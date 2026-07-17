import asyncio
import os
import sys
import time
import json
import logging
import hashlib
import warnings
import threading
from contextlib import asynccontextmanager
from typing import List, Optional

# Suppress noisy HuggingFace / safetensors warnings
if not os.environ.get("HF_TOKEN"):
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    warnings.filterwarnings("ignore", message=".*unauthenticated requests.*")
    warnings.filterwarnings("ignore", message=".*HF_TOKEN.*")

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from google import genai
from dotenv import load_dotenv

from qdrant_client import QdrantClient
from qdrant_client import models as qmodels
from qdrant_client.models import PointStruct, Filter, FieldCondition, MatchValue
from sentence_transformers import SentenceTransformer
from uuid import uuid4

# ─── Environment ─────────────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub._http").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)

# ─── Gemini ───────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
_gemini_client = None
if GEMINI_API_KEY:
    try:
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info("Gemini API configured successfully")
    except Exception as e:
        logger.warning(f"Failed to configure Gemini: {e}. Using fallback mode.")
else:
    logger.warning("GEMINI_API_KEY not found. Service will operate in fallback mode.")

# ─── Qdrant + embeddings ──────────────────────────────────────────────────────
QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", 6333))
QDRANT_URL  = os.getenv("QDRANT_URL")
COLLECTION  = os.getenv("SOCRATIC_QDRANT_COLLECTION", "socratic_docs")
EMBED_MODEL = os.getenv("QUERY_EMBEDDING_MODEL_NAME", "all-MiniLM-L6-v2")

# RAG service base URL (for precomputed content lookups)
RAG_SERVICE_URL = os.getenv("PYTHON_RAG_SERVICE_URL", "http://localhost:2001")

qdrant = QdrantClient(url=QDRANT_URL) if QDRANT_URL else QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

# Suppress safetensors LOAD REPORT noise during model loading
_old_stdout = os.dup(1)
_old_stderr = os.dup(2)
_devnull_fd = os.open(os.devnull, os.O_WRONLY)
os.dup2(_devnull_fd, 1)
os.dup2(_devnull_fd, 2)
try:
    embedder = SentenceTransformer(EMBED_MODEL)
finally:
    os.dup2(_old_stdout, 1)
    os.dup2(_old_stderr, 2)
    os.close(_old_stdout)
    os.close(_old_stderr)
    os.close(_devnull_fd)

VECTOR_DIM  = embedder.get_sentence_embedding_dimension()
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ─── PDF parsers ──────────────────────────────────────────────────────────────
try:
    import pdfplumber
    _PDFPLUMBER = True
except ImportError:
    _PDFPLUMBER = False

# marker-pdf for quality conversion (shared with rag_service)
_MARKER_MODELS = None
_MARKER_LOCK   = threading.Lock()
try:
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered
    _MARKER = True
except ImportError:
    _MARKER = False
    logger.warning("marker-pdf not available in socratic_service.")


# ─── Pydantic models ──────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    query: str
    file_hash: Optional[str] = None
    file_hashes: List[str] = []
    history: List[dict] = []
    current_topic: Optional[str] = None
    course: Optional[str] = None          # for precomputed cache lookup
    topic_id: Optional[str] = None        # for precomputed cache lookup
    learning_level: str = "beginner"

class PlanRequest(BaseModel):
    file_hashes: List[str]
    learning_level: str = "beginner"


# ─── PDF helpers ──────────────────────────────────────────────────────────────

def _extract_pdf_fast(filepath: str) -> str:
    """pdfplumber fast extraction."""
    if _PDFPLUMBER:
        try:
            parts = []
            with pdfplumber.open(filepath) as pdf:
                for page in pdf.pages:
                    t = page.extract_text(x_tolerance=2, y_tolerance=2)
                    if t and t.strip():
                        parts.append(t.strip())
            return "\n\n".join(parts)
        except Exception as e:
            logger.warning(f"pdfplumber failed: {e}")

    # fallback to pypdf
    try:
        from pypdf import PdfReader
        reader = PdfReader(filepath)
        return "\n".join(p.extract_text() or "" for p in reader.pages)
    except Exception as e:
        logger.warning(f"pypdf fallback failed: {e}")
        return ""


def _get_marker_models():
    global _MARKER_MODELS
    if _MARKER_MODELS is None:
        with _MARKER_LOCK:
            if _MARKER_MODELS is None:
                logger.info("Loading marker-pdf models for socratic_service...")
                _MARKER_MODELS = create_model_dict()
    return _MARKER_MODELS


def _upgrade_chunks_with_marker(filepath: str, safe_name: str, file_hash: str):
    """Background thread: run marker, delete old chunks, insert new markdown chunks."""
    try:
        models  = _get_marker_models()
        conv    = PdfConverter(artifact_dict=models)
        rendered = conv(filepath)
        from marker.output import text_from_rendered
        markdown, _, _ = text_from_rendered(rendered)
        if not markdown or not markdown.strip():
            return
        # Delete old pdfplumber chunks
        qdrant.delete(
            collection_name=COLLECTION,
            points_selector=Filter(must=[FieldCondition(key="file_hash", match=MatchValue(value=file_hash))])
        )
        # Insert marker chunks
        chunk_size = 1000
        chunks = [markdown[i:i+chunk_size] for i in range(0, len(markdown), chunk_size)]
        _upsert_chunks(chunks, {"source": safe_name, "file_hash": file_hash, "parser": "marker"})
        logger.info(f"marker upgrade complete for {safe_name}: {len(chunks)} markdown chunks.")
    except Exception as e:
        logger.error(f"marker upgrade failed for {safe_name}: {e}", exc_info=True)


# ─── Ollama fallback ──────────────────────────────────────────────────────────
_OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
_OLLAMA_CHAT_MODELS = ["qwen3.5:27b", "qwen2.5:14b-instruct", "qwen3.5:9b", "qwen3.5:2b"]
_gemini_permanently_failed = False  # Skip Gemini after API_KEY_INVALID


def _call_ollama_generate(prompt: str) -> str:
    """Try Ollama models in priority order."""
    import urllib.request as _ur
    for model in _OLLAMA_CHAT_MODELS:
        try:
            payload = json.dumps({
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.4, "num_predict": 2048},
            }).encode()
            req = _ur.Request(
                f"{_OLLAMA_BASE_URL}/api/generate",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with _ur.urlopen(req, timeout=120) as r:
                data = json.loads(r.read())
            text = data.get("response", "").strip()
            if text:
                logger.debug(f"Ollama fallback used model: {model}")
                return text
        except Exception as e:
            logger.warning(f"Ollama fallback failed with {model}: {e}")
    return ""


# ─── Gemini helpers ───────────────────────────────────────────────────────────

def generate_with_retry(prompt: str, **kwargs) -> str:
    """Gemini generation with exponential backoff; falls back to Ollama on failure."""
    global _gemini_permanently_failed
    if _gemini_client is not None and not _gemini_permanently_failed:
        base_delay, max_retries = 10, 3
        for attempt in range(max_retries):
            try:
                resp = _gemini_client.models.generate_content(
                    model='gemini-2.0-flash', contents=prompt,
                )
                return resp.text or ""
            except Exception as e:
                err = str(e)
                if "API_KEY_INVALID" in err or "key expired" in err.lower():
                    _gemini_permanently_failed = True
                    logger.warning("Gemini API key expired/invalid — switching permanently to Ollama.")
                    break
                elif "429" in err or "quota" in err.lower():
                    wait = base_delay * (2 ** attempt)
                    logger.warning(f"Rate limit. Retrying in {wait}s... ({attempt+1}/{max_retries})")
                    time.sleep(wait)
                else:
                    logger.warning(f"Gemini error: {e}. Falling back to Ollama.")
                    break
    return _call_ollama_generate(prompt)


async def generate_async(prompt: str) -> str:
    """Non-blocking LLM call via asyncio.to_thread."""
    return await asyncio.to_thread(generate_with_retry, prompt)


# ─── Qdrant helpers ───────────────────────────────────────────────────────────

def _file_exists_in_qdrant(file_hash: str) -> bool:
    try:
        results, _ = qdrant.scroll(
            collection_name=COLLECTION, limit=1,
            scroll_filter=Filter(must=[FieldCondition(key="file_hash", match=MatchValue(value=file_hash))])
        )
        return len(results) > 0
    except Exception:
        return False


def _embed(text: str) -> List[float]:
    return embedder.encode(text).tolist()


def _upsert_chunks(chunks: List[str], metadata_base: dict):
    points = [
        PointStruct(
            id=str(uuid4()),
            vector=_embed(chunk),
            payload={**metadata_base, "text": chunk, "chunk_index": i}
        )
        for i, chunk in enumerate(chunks)
    ]
    qdrant.upsert(collection_name=COLLECTION, points=points)


def _search(query: str, file_hash: str, limit: int = 3) -> List[str]:
    results = qdrant.search(
        collection_name=COLLECTION,
        query_vector=_embed(query),
        limit=limit,
        query_filter=Filter(must=[FieldCondition(key="file_hash", match=MatchValue(value=file_hash))])
    )
    return [hit.payload.get("text", "") for hit in results]


def _get_first_chunks(file_hash: str, limit: int = 10) -> List[str]:
    results, _ = qdrant.scroll(
        collection_name=COLLECTION, limit=limit,
        scroll_filter=Filter(must=[FieldCondition(key="file_hash", match=MatchValue(value=file_hash))])
    )
    return [r.payload.get("text", "") for r in results]


# ─── Precomputed content lookup ───────────────────────────────────────────────

async def _fetch_precomputed(course: Optional[str], topic_id: Optional[str]) -> Optional[dict]:
    """
    Fetch pre-computed Socratic content from the RAG service cache.
    Returns the payload dict or None.
    """
    if not course or not topic_id:
        return None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{RAG_SERVICE_URL}/precompute/topic/{course}/{topic_id}")
            if r.status_code == 200:
                data = r.json()
                if data.get("cached"):
                    return data.get("data")
    except Exception as e:
        logger.debug(f"Precomputed lookup failed: {e}")
    return None


# ─── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        qdrant.get_collection(COLLECTION)
        logger.info(f"Qdrant collection '{COLLECTION}' already exists.")
    except Exception:
        qdrant.create_collection(
            collection_name=COLLECTION,
            vectors_config=qmodels.VectorParams(size=VECTOR_DIM, distance=qmodels.Distance.COSINE)
        )
        logger.info(f"Created Qdrant collection '{COLLECTION}' ({VECTOR_DIM}-dim cosine).")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "service": "socratic_rag", "vector_db": "qdrant"}


@app.post("/ingest")
async def ingest_file(file: UploadFile = File(...), file_hash: str = Form(...)):
    """
    Ingest a PDF/TXT into the socratic Qdrant collection.
    PDF pipeline: pdfplumber (fast, immediate) → marker-pdf (quality, background).
    """
    if not file_hash:
        raise HTTPException(status_code=400, detail="File hash required")

    # Deduplication
    if _file_exists_in_qdrant(file_hash):
        logger.info(f"file_hash={file_hash} already indexed. Returning cached summary.")
        chunks = _get_first_chunks(file_hash, limit=1)
        preview_text = chunks[0] if chunks else ""
        summary = "Summary generation failed."
        try:
            resp = generate_with_retry(
                f"Briefly summarize this document for a Socratic tutor:\n\n{preview_text[:3000]}"
            )
            summary = resp.text
        except Exception as e:
            logger.error(f"Cached summary gen failed: {e}")
        return {"message": "File already indexed", "cached": True, "summary": summary}

    if not file.filename:
        raise HTTPException(status_code=400, detail="No selected file")

    safe_name = os.path.basename(file.filename)
    filepath  = os.path.join(UPLOAD_FOLDER, safe_name)
    with open(filepath, "wb") as fh:
        fh.write(await file.read())

    try:
        lower = safe_name.lower()
        content = ""

        if lower.endswith('.pdf'):
            # Fast path — pdfplumber
            content = await asyncio.to_thread(_extract_pdf_fast, filepath)
            if not content.strip():
                # scanned PDF → marker handles it fully in background
                logger.info(f"{safe_name}: pdfplumber extracted no text (likely scanned).")

            # Chunk and store fast-path content immediately
            if content.strip():
                chunk_size = 1000
                fast_chunks = [content[i:i+chunk_size] for i in range(0, len(content), chunk_size)]
                await asyncio.to_thread(
                    _upsert_chunks, fast_chunks,
                    {"source": safe_name, "file_hash": file_hash, "parser": "pdfplumber"}
                )

            # Quality upgrade in background (marker)
            if _MARKER:
                t = threading.Thread(
                    target=_upgrade_chunks_with_marker,
                    args=(filepath, safe_name, file_hash),
                    daemon=True,
                    name=f"marker-socratic:{safe_name}",
                )
                t.start()

        elif lower.endswith(('.txt', '.md')):
            with open(filepath, 'r', encoding='utf-8') as fh:
                content = fh.read()
            chunk_size = 1000
            chunks = [content[i:i+chunk_size] for i in range(0, len(content), chunk_size)]
            await asyncio.to_thread(
                _upsert_chunks, chunks,
                {"source": safe_name, "file_hash": file_hash, "parser": "text"}
            )
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type")

        # Generate summary async (non-blocking)
        summary = "No summary available."
        try:
            summary_prompt = (
                f"Analyze this document excerpt. Respond with:\n"
                f"**Title/Topic:** ...\n**Key Concepts:** ...\n"
                f"**Difficulty:** ...\n**Socratic Approach:** ...\n\n"
                f"Excerpt:\n{(content or '')[:3000]}"
            )
            summary = await generate_async(summary_prompt)
        except Exception as e:
            logger.error(f"Summary generation failed: {e}")

        return {
            "message": "File ingested (fast path). Marker quality upgrade running in background." if _MARKER else "File ingested.",
            "cached": False,
            "summary": summary,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ingestion failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat")
async def chat(body: ChatRequest):
    """
    Socratic chat with parallel RAG retrieval + precomputed content lookup.
    Both Qdrant search and Redis precomputed cache are queried simultaneously.
    LLM is called once with the merged context.
    """
    file_hashes = body.file_hashes or ([body.file_hash] if body.file_hash else [])

    # ── Parallel: Qdrant RAG search + precomputed lookup ─────────────────────
    async def _qdrant_search():
        context_parts = []
        for f_hash in file_hashes:
            try:
                chunks = await asyncio.to_thread(_search, body.query, f_hash, limit=3)
                doc_ctx = "\n\n".join(chunks)
                if doc_ctx:
                    context_parts.append(f"--- Document ({f_hash[:8]}) ---\n{doc_ctx}")
            except Exception as e:
                logger.error(f"Qdrant search failed for hash {f_hash}: {e}")
        return "\n\n".join(context_parts)

    async def _precomputed_lookup():
        return await _fetch_precomputed(body.course, body.topic_id)

    qdrant_ctx, precomputed = await asyncio.gather(_qdrant_search(), _precomputed_lookup())

    # ── Merge context ─────────────────────────────────────────────────────────
    context_blocks = []

    if precomputed:
        intro = precomputed.get("intro_summary", "")
        level = body.learning_level.lower()
        qs    = precomputed.get("questions", {}).get(level, [])
        if intro:
            context_blocks.append(f"[CURRICULUM INTRO]\n{intro}")
        if qs:
            q_lines = "\n".join(f"- {q['question']}" for q in qs[:2])
            context_blocks.append(f"[SUGGESTED SOCRATIC QUESTIONS ({level})]\n{q_lines}")

    if qdrant_ctx:
        context_blocks.append(f"[DOCUMENT CONTEXT]\n{qdrant_ctx}")

    if not context_blocks:
        if file_hashes:
            return {"response": "I couldn't find relevant information in the uploaded documents.", "topic_completed": False}
        # No docs, no precomputed — still answer Socratically from the topic name alone
        context_blocks.append(f"[TOPIC] {body.current_topic or body.query}")

    aggregated_context = "\n\n".join(context_blocks)

    # ── History compression ───────────────────────────────────────────────────
    history = body.history
    recent_limit = 5
    summary_text = ""
    if len(history) > recent_limit:
        older = history[:-recent_limit]
        recent = history[-recent_limit:]
        history_str = "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in older)
        try:
            summary_text = await generate_async(
                f"Summarize the key points of this conversation in 2-3 sentences:\n\n{history_str}"
            )
            summary_text = f"PREVIOUS CONVERSATION SUMMARY: {summary_text}\n"
        except Exception as ex:
            logger.error(f"History summarisation failed: {ex}")
    else:
        recent = history

    formatted_history = "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in recent)
    history_block = summary_text + formatted_history

    # ── Build prompt ──────────────────────────────────────────────────────────
    level_guidance = {
        "beginner":     "Use simple language. Focus on recall and basic understanding (Bloom's L1-L2).",
        "intermediate": "Probe application and worked examples (Bloom's L2-L3).",
        "advanced":     "Challenge with edge cases, design decisions, and critique (Bloom's L3-L4).",
        "expert":       "Engage with research-level tradeoffs and open problems (Bloom's L4).",
    }.get(body.learning_level.lower(), "Adapt to the student's level.")

    system_instructions = f"""You are a wise Socratic Tutor. Guide the student using the provided context.
Current Topic : {body.current_topic or 'General'}
Learning Level: {body.learning_level} — {level_guidance}

INSTRUCTIONS:
1. Never give the answer directly. Ask probing questions.
2. Use the DOCUMENT CONTEXT and CURRICULUM INTRO if available.
3. If the SUGGESTED SOCRATIC QUESTIONS match the student's query, use them as a guide.
4. If context is absent, ask a clarifying Socratic question on the topic.
5. Set "topic_completed" to true only if the student has clearly demonstrated full understanding.

OUTPUT FORMAT (strict JSON):
{{
    "response": "Your Socratic response here...",
    "topic_completed": boolean
}}"""

    prompt = (
        f"{system_instructions}\n\n"
        f"CONTEXT:\n{aggregated_context}\n\n"
        f"CHAT HISTORY:\n{history_block}\n\n"
        f"USER QUERY:\n{body.query}"
    )

    try:
        response_text = await generate_async(prompt)
        try:
            return json.loads(response_text)
        except Exception:
            return {"response": response_text, "topic_completed": False}
    except Exception as e:
        logger.error(f"Chat failed: {e}")
        err = str(e)
        if "429" in err or "quota" in err.lower():
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait and try again.")
        raise HTTPException(status_code=500, detail=err)


@app.post("/generate_plan")
async def generate_plan(body: PlanRequest):
    if not body.file_hashes:
        raise HTTPException(status_code=400, detail="File hash(es) are required")

    aggregated_context = ""
    preview_limit = 5000
    for f_hash in body.file_hashes:
        try:
            chunks = _get_first_chunks(f_hash, limit=10)
            doc_text = "\n".join(chunks)
            if doc_text:
                aggregated_context += f"--- Source ({f_hash[:8]}) ---\n{doc_text[:preview_limit]}\n\n"
        except Exception as e:
            logger.error(f"Error reading file_hash={f_hash}: {e}")

    if not aggregated_context:
        raise HTTPException(status_code=404, detail="No context found from files")

    prompt = f"""You are an expert curriculum designer. Create a structured study plan for a **{body.learning_level}** level student.

DOCUMENT CONTENT:
{aggregated_context}

Output ONLY valid JSON:
{{
    "study_plan": [
        {{
            "topic": "Module 1: Title",
            "description": "Overview.",
            "subtopics": [
                {{"topic": "1.1 Subtopic", "description": "Details."}}
            ]
        }}
    ]
}}"""

    try:
        clean = await generate_async(prompt)
        clean = clean.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        return json.loads(clean)
    except Exception as e:
        logger.error(f"Plan generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == '__main__':
    port = int(os.environ.get("SOCRATIC_PORT", 2002))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
