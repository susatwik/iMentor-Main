import os
import sys
import traceback
try:
    import resource as _resource
except ImportError:
    _resource = None
import asyncio
import logging
import uuid
import subprocess
import tempfile
import shutil
import json
import re
import threading
import warnings
from contextlib import asynccontextmanager
from functools import partial
from typing import List, Optional, Any

# Suppress noisy HuggingFace warnings when no HF_TOKEN is set
if not os.environ.get("HF_TOKEN"):
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    warnings.filterwarnings("ignore", message=".*unauthenticated requests.*")
    warnings.filterwarnings("ignore", message=".*HF_TOKEN.*")

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel
import uvicorn

from werkzeug.utils import secure_filename

try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS

from qdrant_client import models as qdrant_models
import sentry_sdk

# --- Add server directory to sys.path ---
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import config

# Silence noisy HF Hub "unauthenticated" log warnings
logging.getLogger("huggingface_hub._http").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)

# --- Import configurations and services ---
try:
    from vector_db_service import VectorDBService
    import ai_core
    import neo4j_handler
    from neo4j import exceptions as neo4j_exceptions
    from tts_service import initialize_tts
    from stt_service import transcribe_audio
    import document_generator
    import podcast_generator
    from google import genai
    from google.genai import types as genai_types
    # Groq removed — using Ollama + Gemini only
    from prompts import (
        CODE_ANALYSIS_PROMPT_TEMPLATE,
        TEST_CASE_GENERATION_PROMPT_TEMPLATE,
        EXPLAIN_ERROR_PROMPT_TEMPLATE,
        QUIZ_GENERATION_PROMPT_TEMPLATE,
    )
    import quiz_utils
    from academic_search import search_all_apis as academic_search
    from integrity_services import submit_to_turnitin, get_turnitin_report, check_bias_hybrid, calculate_readability
    import curriculum_graph_handler
    try:
        import curriculum_outline_extractor  # [Team6] Syllabus PDF/DOCX → structured curriculum JSON
    except Exception as _coe_err:
        curriculum_outline_extractor = None
        logging.getLogger(__name__).warning(f"curriculum_outline_extractor unavailable: {_coe_err}")
    import knowledge_engine
    import media_processor
    import aiohttp
    import fine_tuner
    import pdf_processor
    import socratic_precompute
    import subtopic_notes_generator
    import study_questions_generator
    import skill_tree_generator
    try:
        from crew.research_crew import run_crewai_research
        _crewai_available = True
    except Exception as _crew_import_err:
        logging.getLogger(__name__).warning(f"CrewAI research module unavailable: {_crew_import_err}. Deep research will use fallback pipeline.")
        _crewai_available = False
        def run_crewai_research(topic: str):
            return {"status": "error", "message": "CrewAI not available in this environment."}

    if config.GEMINI_API_KEY:
        _gemini_client = genai.Client(api_key=config.GEMINI_API_KEY)
        _safety_settings = [
            genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",        threshold="BLOCK_MEDIUM_AND_ABOVE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",       threshold="BLOCK_MEDIUM_AND_ABOVE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_MEDIUM_AND_ABOVE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_MEDIUM_AND_ABOVE"),
        ]
        LLM_MODEL = config.GEMINI_MODEL_NAME
    else:
        _gemini_client = None
        LLM_MODEL = None
        logging.getLogger(__name__).error("GEMINI_API_KEY not found, AI features will fail.")

    # --- Cached Gemini client instances per API key (thread-safe) ---
    _genai_clients: dict = {}

    def get_genai_client(api_key: str):
        """Return a cached genai.Client for this API key, creating one if needed."""
        if api_key not in _genai_clients:
            _genai_clients[api_key] = genai.Client(api_key=api_key)
        return _genai_clients[api_key]

    def llm_wrapper(prompt: str, api_key: str = None) -> str:
        key_to_use = api_key or config.GEMINI_API_KEY
        if not key_to_use:
            raise ConnectionError("AI API Key is not configured for this request.")

        if key_to_use.startswith("gsk_"):
            try:
                client = Groq(api_key=key_to_use)
                model_to_use = getattr(config, "GROQ_MODEL_NAME", "llama-3.3-70b-versatile")
                completion = client.chat.completions.create(
                    messages=[{"role": "user", "content": prompt}],
                    model=model_to_use,
                    temperature=0.7,
                )
                return completion.choices[0].message.content or ""
            except Exception as e:
                logging.getLogger(__name__).error(f"Groq generation failed in llm_wrapper: {e}")
                raise

        client = get_genai_client(key_to_use)
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=config.GEMINI_MODEL_NAME,
                    contents=prompt,
                    config=genai_types.GenerateContentConfig(safety_settings=_safety_settings),
                )
                if response.text:
                    return response.text
                else:
                    logging.getLogger(__name__).warning("LLM returned empty response.")
                    return ""
            except Exception as e:
                logging.getLogger(__name__).warning(f"LLM generation attempt {attempt + 1} failed: {e}")
                if attempt == 2:
                    raise
        return ""

except ImportError as e:
    print(f"CRITICAL IMPORT ERROR: {e}.")
    sys.exit(1)

logger = logging.getLogger(__name__)

# ============================================================================
# SENTRY MONITORING
# ============================================================================
if config.SENTRY_DSN:
    try:
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        sentry_sdk.init(
            dsn=config.SENTRY_DSN,
            integrations=[StarletteIntegration(), FastApiIntegration()],
            traces_sample_rate=0.1,
            profiles_sample_rate=0.1,
        )
        logger.info("Sentry initialized for Python RAG service.")
    except Exception as _sentry_err:
        logger.warning(
            f"Sentry initialization skipped — invalid DSN or missing integration ({_sentry_err}). "
            "Set a valid SENTRY_DSN or leave it unset to disable monitoring."
        )
else:
    logger.info("SENTRY_DSN not set — Sentry monitoring disabled.")

# ============================================================================
# GLOBAL SERVICE INSTANCES (initialized in lifespan)
# ============================================================================
vector_service: Any = None

# ============================================================================
# LIFESPAN — startup / shutdown
# ============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global vector_service
    try:
        vector_service = VectorDBService()
        vector_service.setup_collection()
        logger.info("VectorDBService initialized.")
    except Exception as e:
        logger.critical(f"Failed to initialize VectorDBService: {e}", exc_info=True)

    try:
        neo4j_handler.init_driver()
        logger.info("Neo4j driver initialized.")
        # Verify full-text index used by GraphRAG exists at startup
        from graph_rag import verify_fulltext_index
        verify_fulltext_index("node_search_index")
    except Exception as e:
        logger.critical(f"Neo4j driver failed to initialize: {e}.")

    initialize_tts()
    logger.info(f"--- RAG & Knowledge API Service ready on port {config.API_PORT} ---")

    # Auto-ingest any new PDFs in Cpurses/ on startup (runs after app is fully ready)
    import asyncio as _startup_aio
    _cpurses = os.path.abspath(getattr(config, "CPURSES_DIR", os.path.join(os.path.dirname(__file__), "..", "Cpurses")))
    async def _startup_ingest(cpurses_dir=_cpurses):
        await _startup_aio.sleep(3)
        if not os.path.isdir(cpurses_dir):
            return
        for course_folder in os.listdir(cpurses_dir):
            if not os.path.isdir(os.path.join(cpurses_dir, course_folder)) or course_folder.startswith("_"):
                continue
            course_dir  = os.path.join(cpurses_dir, course_folder)
            course_name = course_folder.replace("_", " ").lower()
            await run_sync(_ingest_course_pdfs_worker, course_name, course_dir)
    _startup_aio.create_task(_startup_ingest())

    # Auto-run material pipeline for course_bootstrap/ (PDF→Markdown→Qdrant→STN→Pedagogy)
    # Runs in background daemon thread, resumable on restart
    import course_material_processor as _cmp_startup
    async def _startup_pipeline():
        await _startup_aio.sleep(8)  # wait for Cpurses ingestion to start first
        _cmp_startup.process_all_courses_background()
    _startup_aio.create_task(_startup_pipeline())

    # Pedagogical cache warmer — pre-loads all L0-L4 notes from Qdrant into Redis
    # so that every user request is served purely from Redis (zero LLM latency).
    async def _warm_pedagogical_cache():
        await _startup_aio.sleep(12)  # let VectorDB settle before scrolling
        try:
            import pedagogical_agent as _ped
            warmed = _ped.warm_pedagogical_cache()
            logger.info(f"Startup: pedagogical cache warmer done — {warmed} entries in Redis")
        except Exception as _warm_err:
            logger.warning(f"Startup: pedagogical cache warmer failed: {_warm_err}")
    _startup_aio.create_task(_warm_pedagogical_cache())

    yield

    neo4j_handler.close_driver()
    logger.info("Neo4j driver closed.")


# ============================================================================
# FASTAPI APP
# ============================================================================
app = FastAPI(lifespan=lifespan)

# CORS
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()
allowed_origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()] or ["http://localhost:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 100 MB upload size guard
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            {"error": "File too large. Maximum allowed upload size is 100 MB.", "code": 413},
            status_code=413,
        )
    return await call_next(request)

# Prometheus
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator().instrument(app).expose(app)
    logger.info("Prometheus metrics endpoint initialized at /metrics.")
except ImportError:
    logger.warning("prometheus-fastapi-instrumentator not installed — metrics disabled.")

GENERATED_DOCS_DIR = os.path.join(SERVER_DIR, "generated_docs")
os.makedirs(GENERATED_DOCS_DIR, exist_ok=True)

# ============================================================================
# HELPERS
# ============================================================================
async def run_sync(fn, *args, **kwargs):
    """Run a blocking/sync function in the default thread-pool executor."""
    return await asyncio.to_thread(fn, *args, **kwargs)


def _error(message: str, status_code: int = 500, details: str = None) -> JSONResponse:
    log_message = f"API Error ({status_code}): {message}"
    if details:
        log_message += f" | Details: {details}"
    logger.error(log_message)
    payload = {"error": message}
    if details and status_code != 500:
        payload["details"] = details
    return JSONResponse(payload, status_code=status_code)


# ============================================================================
# CODE EXECUTION SANDBOX
# ============================================================================
_MEM_LIMIT_BYTES = 256 * 1024 * 1024
_CPU_LIMIT_SECS  = 3

def _sandbox_preexec():
    try:
        _resource.setrlimit(_resource.RLIMIT_AS,  (_MEM_LIMIT_BYTES, _MEM_LIMIT_BYTES))
        _resource.setrlimit(_resource.RLIMIT_CPU, (_CPU_LIMIT_SECS, _CPU_LIMIT_SECS))
    except Exception:
        # Any failure when setting limits should not crash the sandbox helper.
        return

LANGUAGE_CONFIG = {
    "python": {"filename": "main.py",  "compile_cmd": None, "run_cmd": [sys.executable, "main.py"]},
    "java":   {"filename": "Main.java","compile_cmd": ["javac", "-Xlint:all", "Main.java"], "run_cmd": ["java", "Main"]},
    "c":      {"filename": "main.c",   "compile_cmd": ["gcc", "main.c", "-o", "main", "-Wall", "-Wextra", "-pedantic"], "run_cmd": ["main"]},
    "cpp":    {"filename": "main.cpp", "compile_cmd": ["g++", "main.cpp", "-o", "main", "-Wall", "-Wextra", "-pedantic"], "run_cmd": ["main"]},
}

# ============================================================================
# PYDANTIC MODELS
# ============================================================================
class ExecuteCodeRequest(BaseModel):
    code: str
    language: str
    testCases: List[dict] = []

class AnalyzeCodeRequest(BaseModel):
    code: str
    language: str
    apiKey: Optional[str] = None

class GenerateTestCasesRequest(BaseModel):
    code: str
    language: str
    apiKey: Optional[str] = None

class ExplainErrorRequest(BaseModel):
    code: str
    language: str
    errorMessage: str
    apiKey: Optional[str] = None

class QueryRequest(BaseModel):
    query: str
    user_id: str
    documentContextName: Optional[str] = None
    use_kg_critical_thinking: bool = False
    k: int = 5
    # "course"   → query stn_notes + pedagogical_notes (course curriculum RAG)
    # "user_doc" → query my_qdrant_rag_collection (user-uploaded files)
    # None       → auto-detect: no file extension in documentContextName = course
    source_type: Optional[str] = None

class AddDocumentRequest(BaseModel):
    user_id: str
    file_path: Optional[str] = None
    original_name: str
    text_content_override: Optional[str] = None

class AcademicSearchRequest(BaseModel):
    query: str
    max_results: int = 3

class WebSearchRequest(BaseModel):
    query: str

class ExportPodcastRequest(BaseModel):
    sourceDocumentText: str
    analysisContent: str
    podcastOptions: dict = {}
    api_key: str

class DeleteQdrantRequest(BaseModel):
    user_id: str
    document_name: str

class KGRequest(BaseModel):
    userId: str
    originalName: str
    nodes: List[dict]
    edges: List[dict]
    courseName: Optional[str] = None

class QueryKGRequest(BaseModel):
    query: str
    document_name: str
    user_id: str

class IntegrityRequest(BaseModel):
    text: str
    checks: List[str]
    api_key: Optional[str] = None

class TurnitinReportRequest(BaseModel):
    submissionId: str

class GenerateDocumentRequest(BaseModel):
    markdownContent: str
    docType: str
    sourceDocumentText: str
    api_key: str

class GenerateDocumentFromTopicRequest(BaseModel):
    topic: str
    docType: str
    api_key: str

class FinetuneRequest(BaseModel):
    dataset_path: str
    model_name_to_update: str
    jobId: str

class MissingPrerequisitesRequest(BaseModel):
    topic_id: str
    completed_subtopics: List[str] = []

class CourseIngestRequest(BaseModel):
    course_name: str
    syllabus_csv_path: str
    materials_folder: str
    user_id: str = "admin"

class TopicMissingPrerequisitesRequest(BaseModel):
    completed_subtopics: List[str] = []

class LinkDocumentsRequest(BaseModel):
    course_name: str
    syllabus_csv_path: str
    documents_folder: str
    user_id: str

class RebuildCurriculumRequest(BaseModel):
    courses: List[str]

class ProcessMediaRequest(BaseModel):
    file_path: str
    media_type: str

class ProcessURLRequest(BaseModel):
    url: str
    user_id: str

# --- Pydantic Models ---
class ResearchRequest(BaseModel):
    query: str
    max_results: Optional[int] = 5

class CrewAIResearchRequest(BaseModel):
    topic: str

class SynthesisRequest(BaseModel):
    query: str
    research_results: List[dict]


# ============================================================================
# ROUTES — CODE EXECUTION
# ============================================================================
@app.post("/execute_code")
async def execute_code(body: ExecuteCodeRequest):
    language = body.language.lower()
    lang_config = LANGUAGE_CONFIG.get(language)
    if not lang_config:
        return JSONResponse({"compilationError": f"Language '{language}' is not currently supported for execution."}, status_code=200)

    results = []
    temp_dir = tempfile.mkdtemp()
    try:
        source_path = os.path.join(temp_dir, lang_config["filename"])
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(body.code)

        if lang_config["compile_cmd"]:
            try:
                compile_process = await asyncio.to_thread(
                    subprocess.run,
                    lang_config["compile_cmd"],
                    cwd=temp_dir, capture_output=True, text=True, timeout=10, encoding="utf-8", check=False,
                )
            except FileNotFoundError:
                compiler_name = lang_config["compile_cmd"][0]
                error_msg = (
                    f"Compiler Error: The '{compiler_name}' command was not found. "
                    f"Please ensure the required compiler for '{language}' is installed."
                )
                logger.error(error_msg)
                return JSONResponse({"compilationError": error_msg}, status_code=200)

            if compile_process.returncode != 0:
                error_output = (compile_process.stdout + "\n" + compile_process.stderr).strip()
                return JSONResponse({"compilationError": error_output}, status_code=200)

        for case in body.testCases:
            case_input    = case.get("input", "")
            expected      = str(case.get("expectedOutput", "")).strip()
            case_result   = {"input": case_input, "expected": expected, "output": "", "error": None, "status": "fail"}
            run_command   = lang_config["run_cmd"][:]
            if language in ("c", "cpp"):
                exe = run_command[0] + (".exe" if os.name == "nt" else "")
                run_command[0] = os.path.join(temp_dir, exe)
            try:
                # Build kwargs for subprocess.run. Windows does not support
                # `preexec_fn`, so only include it on POSIX systems.
                run_kwargs = dict(
                    cwd=temp_dir,
                    input=case_input,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    encoding="utf-8",
                )
                if os.name != 'nt':
                    run_kwargs['preexec_fn'] = _sandbox_preexec

                proc = await asyncio.to_thread(
                    subprocess.run,
                    run_command,
                    **run_kwargs,
                )
                stdout = proc.stdout.strip().replace("\r\n", "\n")
                stderr = proc.stderr.strip()
                case_result["output"] = stdout
                if proc.returncode != 0:
                    case_result["status"] = "error"
                    case_result["error"]  = stderr or "Script failed with a non-zero exit code."
                else:
                    if stderr:
                        case_result["error"] = f"Warning (stderr):\n{stderr}"
                    case_result["status"] = "pass" if stdout == expected else "fail"
            except subprocess.TimeoutExpired:
                case_result["status"] = "error"
                case_result["error"]  = "Execution timed out after 5 seconds."
            except Exception as exec_err:
                case_result["status"] = "error"
                case_result["error"]  = f"An unexpected error occurred during execution: {exec_err}"
            results.append(case_result)
    finally:
        shutil.rmtree(temp_dir)
    return {"results": results}


@app.post("/analyze_code")
async def analyze_code_route(body: AnalyzeCodeRequest):
    try:
        prompt   = CODE_ANALYSIS_PROMPT_TEMPLATE.format(language=body.language, code=body.code)
        analysis = await run_sync(llm_wrapper, prompt, body.apiKey)
        return {"analysis": analysis}
    except Exception as e:
        return _error(f"Failed to analyze code: {e}", 500)


@app.post("/generate_test_cases")
async def generate_test_cases_route(body: GenerateTestCasesRequest):
    try:
        prompt        = TEST_CASE_GENERATION_PROMPT_TEMPLATE.format(language=body.language, code=body.code)
        response_text = await run_sync(llm_wrapper, prompt, body.apiKey)
        json_match    = re.search(r"\[.*\]", response_text, re.DOTALL)
        if not json_match:
            raise ValueError("LLM response did not contain a valid JSON array for test cases.")
        return {"testCases": json.loads(json_match.group(0))}
    except Exception as e:
        return _error(f"Failed to generate test cases: {e}", 500)


@app.post("/explain_error")
async def explain_error_route(body: ExplainErrorRequest):
    try:
        prompt      = EXPLAIN_ERROR_PROMPT_TEMPLATE.format(
            language=body.language, code=body.code, error_message=body.errorMessage
        )
        explanation = await run_sync(llm_wrapper, prompt, body.apiKey)
        return {"explanation": explanation}
    except Exception as e:
        return _error(f"Failed to explain error: {e}", 500)


# ============================================================================
# ROUTES — QUIZ GENERATION
# ============================================================================
@app.post("/generate_quiz")
async def generate_quiz_route(
    file: UploadFile = File(...),
    quizOption: str  = Form("standard"),
    api_key: str     = Form(...),
):
    quiz_option_map = {"quick": 5, "standard": 10, "deep_dive": 15, "comprehensive": 20}
    num_questions = quiz_option_map.get(quizOption, 10)

    temp_dir = tempfile.mkdtemp()
    try:
        filename  = secure_filename(file.filename)
        file_path = os.path.join(temp_dir, filename)
        contents  = await file.read()
        with open(file_path, "wb") as f:
            f.write(contents)

        document_text = await run_sync(quiz_utils.extract_text_for_quiz, file_path)
        if not document_text or not document_text.strip():
            return _error("Could not extract any text from the provided document.", 422)

        prompt        = QUIZ_GENERATION_PROMPT_TEMPLATE.format(num_questions=num_questions, document_text=document_text)
        response_text = await run_sync(llm_wrapper, prompt, api_key)
        json_match    = re.search(r"\[.*\]", response_text, re.DOTALL)
        if not json_match:
            raise ValueError("LLM response did not contain a valid JSON array for the quiz.")
        quiz_data = json.loads(json_match.group(0))
        logger.info(f"Quiz Gen: Successfully generated {len(quiz_data)} questions.")
        return {"quiz": quiz_data}
    except Exception as e:
        logger.error(f"Error during quiz generation: {e}", exc_info=True)
        return _error(f"Quiz Generation failed: {e}", 500)
    finally:
        shutil.rmtree(temp_dir)


# ============================================================================
# ============================================================================
# ROUTES — STT (Whisper)
# ============================================================================
@app.post("/stt/transcribe")
async def stt_transcribe(audio: UploadFile = File(...)):
    """
    Transcribe uploaded audio using local Whisper.
    Accepts: webm, wav, mp3, m4a, ogg
    Returns: { text, language }
    """
    if not config.WHISPER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Whisper STT not available — install openai-whisper.")
    try:
        audio_bytes = await audio.read()
        result = await run_sync(transcribe_audio, audio_bytes, audio.filename or "audio.webm")
        return JSONResponse(content={"text": result["text"], "language": result["language"]})
    except Exception as e:
        logging.getLogger(__name__).error(f"STT error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


# ============================================================================
# ROUTES — HEALTH
# ============================================================================
@app.get("/health")
async def health_check():
    status_details = {
        "status": "error",
        "qdrant_service": "not_initialized",
        "neo4j_service": "not_initialized_via_handler",
        "neo4j_connection": "unknown",
    }
    http_status = 503

    if not vector_service:
        status_details["qdrant_service"] = "failed_to_initialize"
    else:
        status_details["qdrant_service"] = "initialized"
        try:
            await run_sync(vector_service.client.get_collection, collection_name=vector_service.collection_name)
            status_details["qdrant_collection_status"] = "exists_and_accessible"
        except Exception as e:
            status_details["qdrant_collection_status"] = f"error: {e}"

    neo4j_ok, neo4j_conn_status = await run_sync(neo4j_handler.check_neo4j_connectivity)
    if neo4j_ok:
        status_details["neo4j_service"]    = "initialized_via_handler"
        status_details["neo4j_connection"] = "connected"
    else:
        status_details["neo4j_service"]    = "initialization_failed_or_handler_error"
        status_details["neo4j_connection"] = neo4j_conn_status

    if (
        status_details["qdrant_service"] == "initialized"
        and status_details.get("qdrant_collection_status") == "exists_and_accessible"
        and neo4j_ok
    ):
        status_details["status"] = "ok"
        http_status = 200

    return JSONResponse(status_details, status_code=http_status)


# ============================================================================
# ROUTES — SEMANTIC EMBEDDING (used by Node.js semantic router)
# ============================================================================

class EmbedRequest(BaseModel):
    text: Optional[str] = None
    texts: Optional[List[str]] = None  # batch mode

class ClassifyIntentRequest(BaseModel):
    query: str
    labels: Optional[List[str]] = None  # custom label list; uses defaults if omitted

# ── Zero-shot classifier (lazy-loaded on first request) ───────────────────────
# Model: cross-encoder/nli-deberta-v3-small
#   - Size: ~184 MB ONNX / ~320 MB PyTorch
#   - Latency: ~20-40ms per query on CPU
#   - Quality: top-tier for NLI-based zero-shot classification
#   - No fine-tuning needed; generalises to arbitrary label sets
# Falls back to keyword heuristics if transformers is not installed.
_zsc_pipeline = None
_zsc_load_attempted = False
_ZSC_MODEL = os.getenv("ZERO_SHOT_MODEL", "cross-encoder/nli-deberta-v3-small")

_DEFAULT_INTENT_LABELS = [
    "greeting or simple factual question",    # → direct_answer
    "technical explanation or concept",        # → standard
    "code or programming",                     # → standard / code model
    "creative writing or storytelling",        # → standard / creative
    "logical reasoning or analysis",           # → tot
    "current events or news search",           # → web_search
    "academic research or scholarly papers",   # → academic_search
    "document analysis or uploaded file",      # → rag_retrieve
    "multilingual translation",                # → standard / multilingual
    "deep research or comprehensive study",    # → deep_research
]

# Map labels → route/category for the JS caller
_LABEL_TO_ROUTE = {
    "greeting or simple factual question":    {"route": "direct_answer",  "category": "chat"},
    "technical explanation or concept":        {"route": "standard",       "category": "technical"},
    "code or programming":                     {"route": "standard",       "category": "code"},
    "creative writing or storytelling":        {"route": "standard",       "category": "creative"},
    "logical reasoning or analysis":           {"route": "tot",            "category": "reasoning"},
    "current events or news search":           {"route": "web_search",     "category": "web"},
    "academic research or scholarly papers":   {"route": "academic_search","category": "academic"},
    "document analysis or uploaded file":      {"route": "standard",       "category": "rag"},
    "multilingual translation":                {"route": "standard",       "category": "multilingual"},
    "deep research or comprehensive study":    {"route": "research",       "category": "research"},
}


def _get_zsc_pipeline():
    """Lazy-load the zero-shot classification pipeline (thread-safe singleton)."""
    global _zsc_pipeline, _zsc_load_attempted
    if _zsc_load_attempted:
        return _zsc_pipeline
    _zsc_load_attempted = True
    try:
        from transformers import pipeline as hf_pipeline
        logger.info(f"[ZSC] Loading zero-shot classifier: {_ZSC_MODEL} …")
        _zsc_pipeline = hf_pipeline(
            "zero-shot-classification",
            model=_ZSC_MODEL,
            device=-1,           # CPU; set device=0 for GPU
            batch_size=1,
        )
        logger.info(f"[ZSC] Zero-shot classifier ready ✓  model={_ZSC_MODEL}")
    except Exception as e:
        logger.warning(f"[ZSC] transformers zero-shot load failed ({e}). /classify_intent will use keyword fallback.")
        _zsc_pipeline = None
    return _zsc_pipeline


def _keyword_classify(query: str, labels: List[str]) -> dict:
    """Lightweight keyword fallback when transformers is unavailable."""
    q = query.lower()
    scores = {}
    kw_map = {
        "greeting or simple factual question":  ["hi", "hello", "hey", "what is", "who is", "how are"],
        "code or programming":                  ["python", "javascript", "function", "class", "def ", "code", "bug", "error", "algorithm", "implement"],
        "current events or news search":        ["latest", "news", "today", "yesterday", "recently", "current", "2026", "what happened"],
        "academic research or scholarly papers":["paper", "arxiv", "research", "study", "journal", "cite", "citation", "literature"],
        "multilingual translation":             ["translate", "translation", "spanish", "french", "german", "hindi", "chinese", "japanese"],
        "logical reasoning or analysis":        ["analyze", "compare", "reason", "proof", "prove", "logic", "argue", "deduce"],
        "deep research or comprehensive study": ["comprehensive", "in-depth", "detailed analysis", "thorough", "extensive"],
        "creative writing or storytelling":     ["write a story", "poem", "sonnet", "fiction", "roleplay", "imagine", "creative"],
        "document analysis or uploaded file":   ["document", "pdf", "uploaded", "file", "extract from", "summarize this"],
    }
    for label in labels:
        score = 0.0
        for kw in kw_map.get(label, []):
            if kw in q:
                score += 0.15
        scores[label] = min(score, 0.85)

    # Default floor for "technical explanation"
    if "technical explanation or concept" in scores and not scores.get("technical explanation or concept"):
        scores["technical explanation or concept"] = 0.1

    best_label = max(scores, key=lambda k: scores[k]) if scores else labels[0]
    best_score = scores.get(best_label, 0.1)
    if best_score < 0.1:
        best_label = "technical explanation or concept"
        best_score = 0.1

    return {
        "label":      best_label,
        "confidence": round(best_score, 4),
        "method":     "keyword_fallback",
        "all_scores": {lbl: round(scores.get(lbl, 0.0), 4) for lbl in labels},
    }


@app.post("/classify_intent")
async def classify_intent(body: ClassifyIntentRequest):
    """
    Zero-shot intent classification for query routing.

    Uses a local NLI model (cross-encoder/nli-deberta-v3-small) to classify a
    query into one of the routing intent labels WITHOUT requiring an LLM API call.

    Called by queryClassifierService.js as Step 3.5 — after semantic embedding
    routing (Step 1) but before the expensive LLM fallback (Step 5).

    Request:  { "query": "explain backpropagation in neural networks" }
              { "query": "...", "labels": ["label A", "label B"] }   # optional custom labels

    Response: {
        "label":      "technical explanation or concept",
        "confidence": 0.91,
        "route":      "standard",
        "category":   "technical",
        "method":     "zero_shot_nli",
        "all_scores": { "label A": 0.91, "label B": 0.04, ... },
        "latency_ms": 35
    }
    """
    import time as _time
    t0 = _time.perf_counter()

    labels = body.labels if body.labels else _DEFAULT_INTENT_LABELS

    zsc = await run_sync(_get_zsc_pipeline)

    if zsc is not None:
        try:
            raw = await run_sync(
                zsc,
                body.query,
                labels,
                multi_label=False,
            )
            best_label  = raw["labels"][0]
            best_score  = float(raw["scores"][0])
            all_scores  = {lbl: round(float(sc), 4) for lbl, sc in zip(raw["labels"], raw["scores"])}
            method      = "zero_shot_nli"
        except Exception as e:
            logger.warning(f"[ZSC] Inference failed ({e}), falling back to keywords")
            result = _keyword_classify(body.query, labels)
            best_label, best_score, all_scores, method = (
                result["label"], result["confidence"], result["all_scores"], result["method"]
            )
    else:
        result = _keyword_classify(body.query, labels)
        best_label, best_score, all_scores, method = (
            result["label"], result["confidence"], result["all_scores"], result["method"]
        )

    route_info = _LABEL_TO_ROUTE.get(best_label, {"route": "standard", "category": "technical"})
    latency_ms = round((time.perf_counter() - t0) * 1000, 1) if hasattr(time, 'perf_counter') else round((_time.perf_counter() - t0) * 1000, 1)

    logger.info(
        f"[ZSC] query='{body.query[:60]}' → label='{best_label}' "
        f"conf={best_score:.3f} method={method} ({latency_ms}ms)"
    )

    return {
        "label":      best_label,
        "confidence": round(best_score, 4),
        "route":      route_info["route"],
        "category":   route_info["category"],
        "method":     method,
        "all_scores": all_scores,
        "latency_ms": latency_ms,
    }

@app.post("/embed")
async def embed_text(body: EmbedRequest):
    """
    Returns the embedding vector(s) for one or more texts using the same
    SentenceTransformer model used for document indexing.

    Used by semanticRouterService.js to perform cosine-similarity routing
    WITHOUT calling an LLM. Latency target: < 10ms for single text.

    Single mode:  { "text": "What is Python?" }
                  → { "embedding": [0.12, ...], "dim": 1024 }

    Batch mode:   { "texts": ["Hello", "Explain recursion", ...] }
                  → { "embeddings": [[0.12, ...], ...], "dim": 1024, "count": 3 }
    """
    try:
        embed_model = config.get_embedding_model()
        if embed_model is None:
            raise HTTPException(status_code=503, detail="Embedding model not loaded")

        if body.texts:
            # Batch mode
            vecs = await run_sync(embed_model.encode, body.texts, normalize_embeddings=True)
            return {
                "embeddings": [v.tolist() for v in vecs],
                "dim":        int(vecs[0].shape[0]),
                "count":      len(body.texts),
            }
        elif body.text:
            # Single mode
            vec = await run_sync(embed_model.encode, body.text, normalize_embeddings=True)
            return {
                "embedding": vec.tolist(),
                "dim":       int(vec.shape[0]),
            }
        else:
            raise HTTPException(status_code=422, detail="Provide 'text' (single) or 'texts' (batch)")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[/embed] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")


# ============================================================================
# ROUTES — RAG / VECTOR SEARCH
# ============================================================================
@app.post("/query")
async def search_qdrant_documents(body: QueryRequest):
    logger.info("--- /query Request (RAG + KG Search) ---")
    _query_start = asyncio.get_event_loop().time()

    # ── Determine source routing ────────────────────────────────────────────
    # "course"   → stn_notes + pedagogical_notes (curriculum authored content)
    # "user_doc" → my_qdrant_rag_collection filtered by user_id (user uploads)
    # auto-detect: documentContextName with no file extension → treat as course
    import os as _os
    _has_extension = bool(body.documentContextName and _os.path.splitext(body.documentContextName)[1])
    _is_course = (body.source_type == "course") or (
        body.source_type is None and body.documentContextName and not _has_extension
    )

    # KG timeout: bail out after 200ms so slow Neo4j never blocks chat responses
    _KG_TIMEOUT_S = float(os.getenv("GRAPHRAG_TIMEOUT_MS", "200")) / 1000.0

    async def _kg_search():
        if body.use_kg_critical_thinking and body.documentContextName:
            logger.info(f"KG search ENABLED for doc '{body.documentContextName}' (timeout={_KG_TIMEOUT_S*1000:.0f}ms).")
            try:
                return await asyncio.wait_for(
                    run_sync(
                        neo4j_handler.search_knowledge_graph,
                        body.user_id, body.documentContextName, body.query,
                    ),
                    timeout=_KG_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                logger.warning(f"[GraphRAG] KG search timed out after {_KG_TIMEOUT_S*1000:.0f}ms — returning empty")
                return ""
            except Exception as e_kg:
                logger.error(f"Error during KG search: {e_kg}", exc_info=True)
                return ""
        return ""

    if _is_course:
        # ── Course path: stn_notes + pedagogical_notes + admin-uploaded PDFs ─
        # Searches all three sources in parallel and merges results so that
        # BOTH generated curriculum content AND raw uploaded PDFs are available.
        logger.info(f"[RAG] Course path for '{body.documentContextName}' → stn_notes + pedagogical_notes + admin PDFs")
        _course_raw   = (body.documentContextName or "").strip()
        course_lower  = _course_raw.lower()
        # Qdrant MatchValue is case-sensitive — try both the original name and
        # lowercase so we match regardless of how the content was indexed.
        _course_values = list(dict.fromkeys([_course_raw, course_lower, _course_raw.title()]))
        course_filter = qdrant_models.Filter(
            should=[
                qdrant_models.FieldCondition(key="course", match=qdrant_models.MatchValue(value=v))
                for v in _course_values
            ]
        )

        # Build candidate filenames for admin-uploaded PDFs.
        # Course names from Neo4j have no extension, but stored file_name does —
        # try the most common permutations so we find the file regardless of case.
        _admin_pdf_candidates = []
        for _name in [_course_raw, _course_raw.title(), _course_raw.lower()]:
            for _ext in [".pdf", ".PDF", ".docx", ".txt", ".md"]:
                _cand = _name + _ext
                if _cand not in _admin_pdf_candidates:
                    _admin_pdf_candidates.append(_cand)

        async def _course_vector_search():
            # Run all three collection searches in parallel
            stn_task  = run_sync(
                vector_service.search_documents,
                query=body.query, k=body.k,
                filter_conditions=course_filter,
                collection_name=config.STN_QDRANT_COLLECTION
            )
            ped_task  = run_sync(
                vector_service.search_documents,
                query=body.query, k=body.k,
                filter_conditions=course_filter,
                collection_name=config.PEDAGOGICAL_QDRANT_COLLECTION
            )

            # Admin PDF: try candidate filenames sequentially until one matches
            async def _try_admin_pdf():
                for candidate in _admin_pdf_candidates:
                    try:
                        admin_filter = qdrant_models.Filter(must=[
                            qdrant_models.FieldCondition(key="user_id",  match=qdrant_models.MatchValue(value="admin")),
                            qdrant_models.FieldCondition(key="file_name", match=qdrant_models.MatchValue(value=candidate)),
                        ])
                        docs, snip, doc_map = await run_sync(
                            vector_service.search_documents,
                            query=body.query, k=body.k,
                            filter_conditions=admin_filter,
                        )
                        if docs:
                            logger.info(f"[RAG] Admin PDF match: '{candidate}' → {len(docs)} chunks")
                            return docs, snip, doc_map
                    except Exception as e_pdf:
                        logger.warning(f"[RAG] Admin PDF search failed for '{candidate}': {e_pdf}")
                logger.info(f"[RAG] No admin PDF found for course '{_course_raw}' (tried {len(_admin_pdf_candidates)} filenames)")
                return [], "", {}

            (stn_docs, _, _), (ped_docs, _, _), (pdf_docs, _, _) = await asyncio.gather(
                stn_task, ped_task, _try_admin_pdf()
            )

            # Merge: interleave all three sources, cap at k
            all_docs_typed = []
            _max_range = max(len(stn_docs), len(ped_docs), len(pdf_docs), 0)
            for i in range(_max_range):
                if i < len(stn_docs):  all_docs_typed.append(("stn", stn_docs[i]))
                if i < len(ped_docs):  all_docs_typed.append(("ped", ped_docs[i]))
                if i < len(pdf_docs):  all_docs_typed.append(("pdf", pdf_docs[i]))
            all_docs_typed = all_docs_typed[:body.k]

            parts = []
            merged_map = {}
            for idx, (src_type, doc) in enumerate(all_docs_typed):
                ci  = idx + 1
                meta = doc.metadata
                if src_type == "pdf":
                    src_label = meta.get("file_name", "Course Document")
                    section   = meta.get("section_context", "")
                    content   = doc.page_content
                    preview   = content[:300] + "..." if len(content) > 300 else content
                    parts.append(
                        f"[{ci}] 📄 {src_label}" +
                        (f" — {section}" if section else "") +
                        f"\nContent: {preview}"
                    )
                else:
                    src_label   = meta.get("subtopic_name") or meta.get("subtopic_id") or "Course Note"
                    topic       = meta.get("topic_name", "")
                    content_key = "teaching_context" if "teaching_context" in meta else "content"
                    content     = meta.get(content_key) or doc.page_content
                    preview     = content[:300] + "..." if len(content) > 300 else content
                    parts.append(
                        f"[{ci}] 📚 {src_label}" +
                        (f" → {topic}" if topic else "") +
                        f"\nContent: {preview}"
                    )
                merged_map[str(ci)] = {
                    "subject":          src_label,
                    "document_name":    f"Course: {body.documentContextName}",
                    "content_preview":  preview,
                    "full_content":     content,
                    "score":            meta.get("score", 1.0),
                    "subtopic_id":      meta.get("subtopic_id"),
                    "source_type":      src_type,
                }

            merged_snippet = "\n\n---\n\n".join(parts) if parts else "No course material found for this topic."
            return [doc for _, doc in all_docs_typed], merged_snippet, merged_map

        try:
            facts_from_kg, (retrieved_docs, snippet_from_vector, docs_map) = await asyncio.gather(
                _kg_search(), _course_vector_search()
            )
        except Exception as e:
            logger.error(f"Error in /query (course path): {e}", exc_info=True)
            return _error(f"Query failed: {e}", 500)

    else:
        # ── User-doc path: query my_qdrant_rag_collection ────────────────────
        # Admin-uploaded PDFs (user_id="admin") must be accessible by any student.
        # Use top-level should with two complete AND groups:
        #   (student owns file AND name matches) OR (admin owns file AND name matches)
        logger.info(f"[RAG] User-doc path → my_qdrant_rag_collection (user={body.user_id}, doc={body.documentContextName})")

        _should_conditions = []
        if body.documentContextName:
            # Student's own document
            _should_conditions.append(
                qdrant_models.Filter(must=[
                    qdrant_models.FieldCondition(key="user_id", match=qdrant_models.MatchValue(value=body.user_id)),
                    qdrant_models.FieldCondition(key="file_name", match=qdrant_models.MatchValue(value=body.documentContextName)),
                ])
            )
            # Admin-uploaded document with same filename (shared course material)
            if body.user_id != "admin":
                _should_conditions.append(
                    qdrant_models.Filter(must=[
                        qdrant_models.FieldCondition(key="user_id", match=qdrant_models.MatchValue(value="admin")),
                        qdrant_models.FieldCondition(key="file_name", match=qdrant_models.MatchValue(value=body.documentContextName)),
                    ])
                )
        else:
            # No specific document selected — return all of this student's content
            _should_conditions.append(
                qdrant_models.FieldCondition(key="user_id", match=qdrant_models.MatchValue(value=body.user_id))
            )
        qdrant_filters = qdrant_models.Filter(should=_should_conditions)

        async def _user_doc_vector_search():
            return await run_sync(
                vector_service.search_documents,
                query=body.query, k=body.k,
                filter_conditions=qdrant_filters
            )

        try:
            facts_from_kg, (retrieved_docs, snippet_from_vector, docs_map) = await asyncio.gather(
                _kg_search(), _user_doc_vector_search()
            )
        except Exception as e:
            logger.error(f"Error in /query (user-doc path): {e}", exc_info=True)
            return _error(f"Query failed: {e}", 500)

    _elapsed_ms = (asyncio.get_event_loop().time() - _query_start) * 1000
    logger.info(f"[RAG] /query completed in {_elapsed_ms:.1f}ms — {len(retrieved_docs)} docs, kg={'yes' if facts_from_kg else 'no'}")

    final_snippet = ""
    if facts_from_kg and "No specific facts were found" not in facts_from_kg:
        final_snippet += facts_from_kg + "\n\n---\n\n"
    final_snippet += snippet_from_vector

    logger.info(f"RAG+KG search successful. Returning {len(retrieved_docs)} documents.")
    return {
        "retrieved_documents_list":   [d.to_dict() for d in retrieved_docs],
        "formatted_context_snippet":  final_snippet.strip(),
        "retrieved_documents_map":    docs_map,
    }


@app.post("/add_document")
async def add_document_qdrant(body: AddDocumentRequest):
    is_pdf = (body.original_name or "").lower().endswith(".pdf")

    if body.text_content_override:
        logger.info(f"Adding document '{body.original_name}' (text_content_override), user '{body.user_id}'.")
        processed_chunks, raw_text, kg_chunks = await run_sync(
            ai_core.process_document_for_qdrant,
            file_path="", original_name=body.original_name,
            user_id=body.user_id, text_content_override=body.text_content_override,
        )

    elif body.file_path and os.path.exists(body.file_path) and is_pdf:
        # ── PDF ingest: pdfplumber (PyMuPDF fallback for scanned) — Marker standby ──
        # Marker conversion disabled for user PDFs — will be integrated in future versions.
        # Document analytics (FAQ/Topics/Mindmap) commented out — not needed at this point.
        # KG extraction for user docs commented out — will be integrated in future versions.
        logger.info(f"PDF ingest (pdfplumber): '{body.original_name}', user '{body.user_id}'.")

        fast_text = await run_sync(
            pdf_processor.process_pdf_dual_mode,
            file_path=body.file_path,
            original_name=body.original_name,
            user_id=body.user_id,
            on_quality_ready=None,   # Marker upgrade disabled — standby for future version
        )

        processed_chunks, raw_text, _kg_chunks = await run_sync(
            ai_core.process_document_for_qdrant,
            file_path="", original_name=body.original_name,
            user_id=body.user_id, text_content_override=fast_text or "",
        )

        num_added, status = 0, "processed_no_content"
        if processed_chunks:
            num_added = await run_sync(vector_service.add_processed_chunks, processed_chunks)
            if num_added > 0:
                status = "added_to_qdrant"

        # Slim response for user uploads — no analysis text or KG chunks needed.
        # Analysis & KG workers are disabled on the Node.js side for user uploads.
        return JSONResponse({
            "message":                    "Document processed and indexed.",
            "status":                     status,
            "filename":                   body.original_name,
            "num_chunks_added_to_qdrant": num_added,
        }, status_code=201)

    elif body.file_path and os.path.exists(body.file_path):
        logger.info(f"Adding document '{body.original_name}' (file_path), user '{body.user_id}'.")
        processed_chunks, raw_text, kg_chunks = await run_sync(
            ai_core.process_document_for_qdrant,
            file_path=body.file_path, original_name=body.original_name, user_id=body.user_id,
        )
    else:
        return _error("Neither 'file_path' (and file exists) nor 'text_content_override' provided.", 400)

    num_added, status = 0, "processed_no_content"
    if processed_chunks:
        num_added = await run_sync(vector_service.add_processed_chunks, processed_chunks)
        if num_added > 0:
            status = "added_to_qdrant"

    is_admin = str(body.user_id).lower() == "admin"
    response_data = {
        "message":                    "Document processed.",
        "status":                     status,
        "filename":                   body.original_name,
        "num_chunks_added_to_qdrant": num_added,
    }
    # Only include analysis text and KG chunks for admin uploads (used by admin analysis/KG workers)
    if is_admin:
        response_data["raw_text_for_analysis"] = raw_text or ""
        response_data["chunks_with_metadata"] = kg_chunks

    return JSONResponse(response_data, status_code=201)


# ============================================================================
# ROUTES — SOCRATIC PRECOMPUTE
# ============================================================================

class PrecomputeTopicRequest(BaseModel):
    course: str
    topic_id: str
    topic_name: str
    subtopics: Optional[List[str]] = None
    force: bool = False

class PrecomputeCourseRequest(BaseModel):
    course: str
    modules: List[Any]   # list of module dicts from /curriculum/{course}/structure

@app.post("/precompute/topic")
async def precompute_topic_route(body: PrecomputeTopicRequest):
    """Generate and cache Socratic content for one topic."""
    result = await run_sync(
        socratic_precompute.precompute_topic,
        body.course, body.topic_id, body.topic_name, body.subtopics, body.force,
    )
    if result:
        return {"success": True, "cached": True, "topic_id": body.topic_id}
    return _error("Precompute failed — LLM returned no content.", 500)

@app.post("/precompute/course")
async def precompute_course_route(body: PrecomputeCourseRequest):
    """Trigger background precompute for all topics in a course."""
    t = socratic_precompute.precompute_course_background(body.course, body.modules)
    return {"success": True, "message": f"Background precompute started for '{body.course}'", "thread": t.name}

@app.get("/precompute/topic/{course}/{topic_id}")
async def get_precomputed_topic(course: str, topic_id: str):
    """Retrieve cached precomputed Socratic content for a topic."""
    data = socratic_precompute.get_precomputed(course, topic_id)
    if data:
        return {"success": True, "cached": True, "data": data}
    return {"success": False, "cached": False, "data": None}


# ── Subtopic Teaching Notes (STN) ────────────────────────────────────────────

class STNSubtopicRequest(BaseModel):
    course: str
    topic_id: str
    topic_name: str
    subtopic_id: str
    subtopic_name: str
    force: bool = False

class STNCourseRequest(BaseModel):
    course: str
    modules: List[Any]   # same shape as PrecomputeCourseRequest

class StudyQuestionsSubtopicRequest(BaseModel):
    course: str
    topic_id: str
    topic_name: str
    subtopic_id: str
    subtopic_name: str
    teaching_context: str = ""
    force: bool = False

class StudyQuestionsCourseRequest(BaseModel):
    course: str
    modules: List[Any]
    delay: float = 1.0

class SkillTreeRequest(BaseModel):
    course: str
    modules: List[Any]
    force: bool = False

@app.post("/stn/subtopic")
async def stn_generate_subtopic(body: STNSubtopicRequest):
    """Generate and cache teaching notes for one subtopic."""
    result = await run_sync(
        subtopic_notes_generator.generate_subtopic_notes,
        body.course, body.topic_id, body.topic_name,
        body.subtopic_id, body.subtopic_name, body.force,
    )
    if result:
        return {"success": True, "cached": True, "subtopic_id": body.subtopic_id}
    return _error("STN generation failed.", 500)

@app.post("/stn/course")
async def stn_generate_course(body: STNCourseRequest):
    """Trigger background STN generation for all subtopics in a course."""
    t = subtopic_notes_generator.generate_course_notes_background(body.course, body.modules)
    return {"success": True, "message": f"Background STN started for '{body.course}'", "thread": t.name}

@app.get("/stn/{course}/{subtopic_id}")
async def stn_get(course: str, subtopic_id: str):
    """Retrieve cached teaching notes for a subtopic."""
    data = subtopic_notes_generator.get_subtopic_notes(course, subtopic_id)
    if data:
        return {"success": True, "cached": True, "data": data}
    return {"success": False, "cached": False, "data": None}


# ============================================================================
# ROUTES — STUDY QUESTIONS
# ============================================================================

@app.get("/study-questions/{course}/{subtopic_id}")
async def study_questions_get(course: str, subtopic_id: str):
    """Retrieve cached study questions (MCQ + SA + flashcards) for a subtopic."""
    data = study_questions_generator.get_study_questions(course, subtopic_id)
    if data:
        return {"success": True, "cached": True, "data": data}
    return {"success": False, "cached": False, "data": None}


@app.post("/study-questions/subtopic")
async def study_questions_generate_subtopic(body: StudyQuestionsSubtopicRequest):
    """Generate and cache study questions for one subtopic."""
    result = await run_sync(
        study_questions_generator.generate_study_questions,
        body.course, body.topic_id, body.topic_name,
        body.subtopic_id, body.subtopic_name, body.teaching_context, body.force,
    )
    if result:
        return {"success": True, "subtopic_id": body.subtopic_id, "data": result}
    return _error("Study questions generation failed.", 500)


@app.post("/study-questions/course")
async def study_questions_generate_course(body: StudyQuestionsCourseRequest):
    """Trigger background study-question generation for all subtopics in a course."""
    import threading
    t = threading.Thread(
        target=study_questions_generator.generate_course_study_questions,
        args=(body.course, body.modules, body.delay),
        daemon=True,
        name=f"study-q-{body.course}",
    )
    t.start()
    return {"success": True, "message": f"Background study-questions generation started for '{body.course}'", "thread": t.name}


# ============================================================================
# ROUTES — SKILL TREE
# ============================================================================

@app.get("/skill-tree/{course}")
async def skill_tree_get(course: str):
    """Retrieve cached skill tree for a course."""
    data = skill_tree_generator.load_skill_tree(course)
    if data:
        return {"success": True, "cached": True, "data": data}
    return {"success": False, "cached": False, "data": None}


@app.post("/skill-tree/generate")
async def skill_tree_generate(body: SkillTreeRequest):
    """Generate (or regenerate) the skill tree for a course."""
    result = await run_sync(
        skill_tree_generator.generate_skill_tree,
        body.course, body.modules, body.force,
    )
    if result:
        return {"success": True, "course": body.course, "skill_tree": result}
    return _error("Skill tree generation failed.", 500)


@app.delete("/delete_qdrant_document_data")
async def delete_qdrant_data_route(body: DeleteQdrantRequest):
    try:
        result = await run_sync(vector_service.delete_document_vectors, body.user_id, body.document_name)
        return result
    except Exception as e:
        return _error(f"Deletion failed: {e}", 500)


# ============================================================================
# ROUTES — ACADEMIC / WEB SEARCH
# ============================================================================
@app.post("/academic_search")
async def academic_search_route(body: AcademicSearchRequest):
    try:
        results = await academic_search(body.query, max_results_per_api=body.max_results)
        return {"success": True, "results": results}
    except Exception as e:
        return _error(f"Academic search failed: {e}", 500)


@app.post("/web_search")
async def web_search_route(body: WebSearchRequest):
    try:
        def _search():
            with DDGS() as ddgs:
                return list(ddgs.text(body.query, max_results=5))
        results = await run_sync(_search)
        return [{"title": r.get("title"), "url": r.get("href"), "content": r.get("body")} for r in results]
    except Exception as e:
        return _error(f"Web search failed: {e}", 500)


# ============================================================================
# ROUTES — PODCAST / DOCUMENT GENERATION
# ============================================================================
@app.post("/export_podcast")
async def export_podcast_route(body: ExportPodcastRequest):
    logger.info("--- /export_podcast Request ---")
    try:
        script = await run_sync(
            podcast_generator.generate_podcast_script,
            body.sourceDocumentText, body.analysisContent, body.podcastOptions,
            lambda p: llm_wrapper(p, body.api_key),
        )
        final_mp3_filename = f"podcast_final_{uuid.uuid4()}.mp3"
        final_mp3_path     = os.path.join(GENERATED_DOCS_DIR, final_mp3_filename)
        await run_sync(podcast_generator.create_podcast_from_script, script, final_mp3_path)

        return FileResponse(
            path=final_mp3_path,
            filename=final_mp3_filename,
            media_type="audio/mpeg",
            background=BackgroundTask(os.remove, final_mp3_path),
        )
    except Exception as e:
        logger.error(f"Failed to generate podcast: {e}", exc_info=True)
        return _error(f"Failed to generate podcast: {e}", 500)


@app.get("/download_document/{filename}")
async def download_document_route(filename: str):
    if ".." in filename:
        return _error("Invalid filename.", 400)
    file_path = os.path.join(GENERATED_DOCS_DIR, filename)
    if not os.path.exists(file_path):
        return _error("File not found.", 404)
    return FileResponse(
        path=file_path,
        filename=filename,
        background=BackgroundTask(os.remove, file_path),
    )


@app.post("/generate_document")
async def generate_document_route(body: GenerateDocumentRequest):
    try:
        expanded_content = await run_sync(
            document_generator.expand_content_with_llm,
            body.markdownContent, body.sourceDocumentText, body.docType,
            lambda p: llm_wrapper(p, body.api_key),
        )
        if body.docType == "pptx":
            parsed_data = await run_sync(document_generator.parse_pptx_json, expanded_content)
        else:
            parsed_data = await run_sync(document_generator.refined_parse_docx_markdown, expanded_content)

        if not parsed_data:
            return _error(
                f"The AI was unable to structure the content correctly for a {body.docType.upper()} file. "
                "Please try rephrasing or using a different source document.", 422
            )

        safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", body.markdownContent)[:50]
        filename  = f"gen_{safe_name}_{uuid.uuid4()}.{body.docType}"
        file_path = os.path.join(GENERATED_DOCS_DIR, filename)

        if body.docType == "pptx":
            await run_sync(document_generator.create_ppt, parsed_data, file_path)
        else:
            await run_sync(document_generator.create_doc, parsed_data, file_path, "text_content")

        return FileResponse(
            path=file_path,
            filename=filename,
            background=BackgroundTask(os.remove, file_path),
        )
    except Exception as e:
        logger.error(f"Error during document generation: {e}", exc_info=True)
        return _error(f"Failed to generate document: {e}", 500)


@app.post("/generate_document_from_topic")
async def generate_document_from_topic_route(body: GenerateDocumentFromTopicRequest):
    try:
        generated_content = await run_sync(
            document_generator.generate_content_from_topic,
            body.topic, body.docType, lambda p: llm_wrapper(p, body.api_key),
        )
        if body.docType == "pptx":
            parsed_data = await run_sync(document_generator.parse_pptx_json, generated_content)
        else:
            parsed_data = await run_sync(document_generator.refined_parse_docx_markdown, generated_content)

        if not parsed_data:
            return _error(
                f"The AI was unable to structure the content correctly for a {body.docType.upper()} file "
                f"based on that topic. Please try a different topic.", 422
            )

        safe_topic = re.sub(r"[^a-zA-Z0-9_-]", "_", body.topic)[:50]
        filename   = f"gen_{safe_topic}_{uuid.uuid4()}.{body.docType}"
        file_path  = os.path.join(GENERATED_DOCS_DIR, filename)

        if body.docType == "pptx":
            await run_sync(document_generator.create_ppt, parsed_data, file_path)
        else:
            await run_sync(document_generator.create_doc, parsed_data, file_path, "text_content")

        return FileResponse(
            path=file_path,
            filename=filename,
            background=BackgroundTask(os.remove, file_path),
        )
    except Exception as e:
        logger.error(f"Failed to generate document from topic '{body.topic}': {e}", exc_info=True)
        return _error(f"Failed to generate document from topic: {e}", 500)


# ============================================================================
# ROUTES — KNOWLEDGE GRAPH
# ============================================================================
@app.post("/kg")
async def add_or_update_kg_route(body: KGRequest):
    try:
        result = await run_sync(
            neo4j_handler.ingest_knowledge_graph,
            body.userId, body.originalName, body.nodes, body.edges,
        )
        covers_count = 0
        if body.courseName:
            try:
                covers_count = await run_sync(
                    curriculum_graph_handler.create_covers_relationships,
                    body.courseName, body.userId, body.originalName,
                )
                logger.info(f"COVERS: {covers_count} relationships created for '{body.originalName}' → '{body.courseName}'")
            except Exception as cov_err:
                logger.warning(f"COVERS wiring non-fatal: {cov_err}")
        return JSONResponse({"message": "KG ingested", "status": "completed", "covers_created": covers_count, **result}, status_code=201)
    except Exception as e:
        return _error(f"KG ingestion failed: {e}", 500)


@app.get("/kg/{user_id}/{document_name:path}")
async def get_kg_route(user_id: str, document_name: str):
    try:
        kg_data = await run_sync(neo4j_handler.get_knowledge_graph, user_id, document_name)
        if kg_data is None:
            return {"nodes": [], "edges": []}
        return kg_data
    except Exception as e:
        return _error(f"KG retrieval failed: {e}", 500)


@app.delete("/kg/{user_id}/{document_name:path}")
async def delete_kg_route(user_id: str, document_name: str):
    try:
        deleted = await run_sync(neo4j_handler.delete_knowledge_graph, user_id, document_name)
        if not deleted:
            return _error("KG not found", 404)
        return {"message": "KG deleted"}
    except Exception as e:
        return _error(f"KG deletion failed: {e}", 500)


@app.post("/query_kg")
async def query_kg_route(body: QueryKGRequest):
    logger.info("--- /query_kg Request ---")
    try:
        facts_from_kg = await run_sync(
            neo4j_handler.search_knowledge_graph,
            body.user_id, body.document_name, body.query,
        )
        return {"success": True, "facts": facts_from_kg}
    except neo4j_exceptions.ClientError as e:
        logger.error(f"Neo4j client error during KG query: {e}", exc_info=True)
        return _error(f"Database error during KG query: {e}", 500)
    except Exception as e:
        logger.error(f"Error during KG query: {e}", exc_info=True)
        return _error(f"KG query failed: {e}", 500)


class GraphSearchRequest(BaseModel):
    query: str
    user_id: str
    document_context: str = None


@app.post("/graph/search")
async def graph_search_route(body: GraphSearchRequest):
    """
    GraphRAG traversal search — fulltext KnowledgeNode index → 1-2 hop RELATED_TO traversal.
    Returns structured facts to augment tutor / RAG context.
    """
    try:
        from graph_rag import graph_search_query
        facts = await run_sync(
            graph_search_query,
            body.query,
            body.user_id,
            body.document_context,
        )
        return {"success": True, "facts": facts}
    except Exception as e:
        logger.warning(f"[/graph/search] error: {e}")
        return {"success": False, "facts": ""}


# ============================================================================
# ROUTES — INTEGRITY ANALYSIS
# ============================================================================
@app.post("/analyze_integrity")
async def analyze_integrity_route(body: IntegrityRequest):
    results = {}
    llm_func = lambda p: llm_wrapper(p, body.api_key)

    if "plagiarism" in body.checks:
        try:
            async with aiohttp.ClientSession() as session:
                submission_id = await submit_to_turnitin(session, body.text)
            results["plagiarism"] = {"status": "pending", "submissionId": submission_id}
        except Exception as e:
            logger.error(f"Turnitin submission failed: {e}", exc_info=True)
            results["plagiarism"] = {"status": "error", "message": str(e)}

    if "bias" in body.checks:
        try:
            results["bias"] = await run_sync(check_bias_hybrid, body.text, llm_func)
        except Exception as e:
            logger.error(f"Bias check failed: {e}", exc_info=True)
            results["bias"] = {"status": "error", "message": str(e)}

    if "readability" in body.checks:
        try:
            results["readability"] = await run_sync(calculate_readability, body.text)
        except Exception as e:
            logger.error(f"Readability check failed: {e}", exc_info=True)
            results["readability"] = {"status": "error", "message": str(e)}

    return results


@app.post("/get_turnitin_report")
async def get_turnitin_report_route(body: TurnitinReportRequest):
    try:
        async with aiohttp.ClientSession() as session:
            report = await get_turnitin_report(session, body.submissionId)
        return {"status": "completed", "report": report}
    except TimeoutError:
        return JSONResponse({"status": "pending"}, status_code=202)
    except Exception as e:
        return _error(f"Failed to get Turnitin report: {e}", 500)


# ============================================================================
# ROUTES — FINE-TUNING
# ============================================================================
@app.post("/finetune")
async def finetune_route(body: FinetuneRequest):
    logger.info(f"Received fine-tuning request. Job ID: {body.jobId}. Model: {body.model_name_to_update}.")
    # Lazy-import the fine_tuner module so the app can start without
    # training dependencies (trl/peft/torch/etc.). If the import fails,
    # return a clear 503 response explaining how to enable it.
    try:
        import importlib
        fine_tuner = importlib.import_module("fine_tuner")
    except Exception as e:
        logger.warning(f"Fine-tuner unavailable: {e}")
        return JSONResponse({
            "error": "Fine-tuner unavailable: training dependencies not installed or failed to import.",
            "details": "Install optional training packages (trl, peft, transformers, torch) and restart the service to enable fine-tuning.",
        }, status_code=503)

    def fine_tuning_task():
        try:
            import fine_tuner
            fine_tuner.run_fine_tuning(body.dataset_path, body.model_name_to_update, body.jobId)
        except Exception as e:
            logger.error(f"Background fine-tuning job {body.jobId} failed: {e}", exc_info=True)

    thread = threading.Thread(target=fine_tuning_task, daemon=True)
    thread.start()
    return JSONResponse({
        "message": "Fine-tuning job has been successfully queued and is running in the background.",
        "jobId":       body.jobId,
        "model_tag":   body.model_name_to_update,
    }, status_code=202)


# ============================================================================
# ROUTES — SYLLABUS GRAPH
# ============================================================================
try:
    import syllabus_graph_handler as _sgh
except ImportError as e:
    logger.warning(f"Failed to import syllabus_graph_handler: {e}")
    _sgh = None


@app.post("/syllabus/upload")
async def upload_syllabus_route(
    file: UploadFile = File(...),
    courseName: str  = Form(...),
):
    logger.info("--- /syllabus/upload Request ---")
    if not _sgh:
        return _error("Syllabus graph handler not available", 503)
    if not file.filename:
        return _error("No file selected", 400)
    if not file.filename.lower().endswith(".csv"):
        return _error("Only CSV files are supported in this version", 400)

    temp_dir = tempfile.mkdtemp()
    try:
        filename  = secure_filename(file.filename)
        file_path = os.path.join(temp_dir, filename)
        with open(file_path, "wb") as f:
            f.write(await file.read())

        concepts = await run_sync(_sgh.parse_syllabus_csv, file_path)
        if not concepts:
            return _error("No valid concepts found in the CSV file. Please check the format.", 422)

        result = await run_sync(_sgh.build_syllabus_graph, courseName, concepts)
        return JSONResponse({
            "success": True, "message": result["message"], "course": courseName,
            "conceptsProcessed": len(concepts), "nodesCreated": result["nodes_created"],
            "edgesCreated": result["edges_created"],
        }, status_code=201)
    except Exception as e:
        logger.error(f"Error processing syllabus upload: {e}", exc_info=True)
        return _error(f"Failed to process syllabus: {e}", 500)
    finally:
        shutil.rmtree(temp_dir)


@app.get("/syllabus/courses/{course_name}")
async def get_course_concepts_route(course_name: str):
    if not _sgh:
        return _error("Syllabus graph handler not available", 503)
    try:
        concepts = await run_sync(_sgh.get_course_concepts, course_name)
        return {"course": course_name, "concepts": concepts}
    except Exception as e:
        logger.error(f"Error retrieving course concepts: {e}", exc_info=True)
        return _error(f"Failed to retrieve concepts: {e}", 500)


@app.delete("/syllabus/courses/{course_name}")
async def delete_course_graph_route(course_name: str):
    if not _sgh:
        return _error("Syllabus graph handler not available", 503)
    try:
        await run_sync(_sgh.delete_course_graph, course_name)
        return {"success": True, "message": f"Course '{course_name}' deleted"}
    except Exception as e:
        logger.error(f"Error deleting course graph: {e}", exc_info=True)
        return _error(f"Failed to delete course: {e}", 500)


# ============================================================================
# ROUTES — CURRICULUM GRAPH
# ============================================================================
@app.post("/curriculum/upload")
async def upload_curriculum_route(
    file: UploadFile = File(...),
    courseName: str  = Form(...),
):
    logger.info("--- /curriculum/upload Request ---")
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    if not file.filename or not file.filename.lower().endswith(".csv"):
        return _error("Only CSV files are supported", 400)

    temp_dir = tempfile.mkdtemp()
    try:
        filename  = secure_filename(file.filename)
        file_path = os.path.join(temp_dir, filename)
        with open(file_path, "wb") as f:
            f.write(await file.read())

        try:
            delete_result = await run_sync(curriculum_graph_handler.delete_course_curriculum, courseName)
            if delete_result.get("deleted_count", 0) > 0:
                logger.info(f"Deleted {delete_result['deleted_count']} existing nodes for '{courseName}'")
        except Exception as del_err:
            logger.warning(f"Could not delete existing curriculum (may not exist): {del_err}")

        result = await run_sync(curriculum_graph_handler.ingest_from_unified_csv, courseName, file_path)
        return JSONResponse(
            {"success": True, "message": f"Curriculum graph created for '{courseName}'", **result},
            status_code=201,
        )
    except Exception as e:
        logger.error(f"Error processing curriculum upload: {e}", exc_info=True)
        return _error(f"Failed to process curriculum: {e}", 500)
    finally:
        shutil.rmtree(temp_dir)


@app.post("/curriculum/ingest")
async def ingest_curriculum_route(
    modules:    UploadFile = File(...),
    topics:     UploadFile = File(...),
    subtopics:  UploadFile = File(...),
    courseName: str        = Form(...),
):
    logger.info("--- /curriculum/ingest Request ---")
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)

    temp_dir = tempfile.mkdtemp()
    try:
        file_paths = {}
        for key, upload in (("modules", modules), ("topics", topics), ("subtopics", subtopics)):
            fname           = secure_filename(upload.filename)
            fpath           = os.path.join(temp_dir, fname)
            file_paths[key] = fpath
            with open(fpath, "wb") as f:
                f.write(await upload.read())

        mods     = await run_sync(curriculum_graph_handler.parse_modules_csv, file_paths["modules"])
        tops     = await run_sync(curriculum_graph_handler.parse_topics_csv, file_paths["topics"])
        subtops  = await run_sync(curriculum_graph_handler.parse_subtopics_csv, file_paths["subtopics"])
        if not mods:
            return _error("No valid modules found in modules.csv", 422)

        result = await run_sync(curriculum_graph_handler.build_curriculum_graph, courseName, mods, tops, subtops)
        return JSONResponse(
            {"success": True, "message": f"Curriculum graph created for '{courseName}'", **result},
            status_code=201,
        )
    except Exception as e:
        logger.error(f"Error ingesting curriculum: {e}", exc_info=True)
        return _error(f"Failed to ingest curriculum: {e}", 500)
    finally:
        shutil.rmtree(temp_dir)


@app.get("/curriculum/courses")
async def list_courses_route():
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        courses = await run_sync(curriculum_graph_handler.list_courses)
        return {"success": True, "courses": courses}
    except Exception as e:
        logger.error(f"Error listing courses: {e}", exc_info=True)
        return _error(f"Failed to list courses: {e}", 500)


@app.post("/curriculum/rebuild")
async def rebuild_curriculum_route(body: RebuildCurriculumRequest):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)

    validated, empty_structure, missing = [], [], []
    for course in body.courses:
        try:
            structure = await run_sync(curriculum_graph_handler.traverse_curriculum, course)
            modules   = structure.get("modules", [])
            if not modules:
                missing.append(course)
            elif not any(m.get("topics") for m in modules):
                empty_structure.append(course)
            else:
                validated.append(course)
        except Exception as e:
            logger.warning(f"Rebuild check failed for '{course}': {e}")
            missing.append(course)

    orphaned_cleaned = 0
    try:
        gc_result        = await run_sync(curriculum_graph_handler.gc_orphaned_nodes)
        orphaned_cleaned = gc_result.get("deleted_count", 0)
    except Exception:
        pass

    needs_reupload = empty_structure + missing
    return {
        "success":        True,
        "validated":      validated,
        "emptyStructure": empty_structure,
        "missing":        missing,
        "orphanedCleaned": orphaned_cleaned,
        "message":        (
            f"Courses needing CSV re-upload via POST /curriculum/upload: {needs_reupload}"
            if needs_reupload else "All courses are structurally complete."
        ),
    }


@app.get("/curriculum/{course}/structure")
async def get_curriculum_structure_route(course: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        structure = await run_sync(curriculum_graph_handler.traverse_curriculum, course)
        return {"success": True, "curriculum": structure}
    except Exception as e:
        logger.error(f"Error getting curriculum structure: {e}", exc_info=True)
        return _error(f"Failed to get curriculum structure: {e}", 500)


@app.get("/curriculum/{course}/notes/{subtopic_id}")
async def get_subtopic_notes_route(course: str, subtopic_id: str):
    """Return all STN teaching-note chunks for a specific subtopic_id.
    Used by the CourseViewerPanel to render lecture notes inline.
    Searches both stn_notes and pedagogical_notes collections."""
    course_values = [course, course.lower(), course.title()]
    sub_lower = subtopic_id.lower()

    async def _search_notes(collection_name: str):
        # Try each case variant for the course field
        all_docs = []
        for cv in course_values:
            filt = qdrant_models.Filter(must=[
                qdrant_models.FieldCondition(key="course",       match=qdrant_models.MatchValue(value=cv)),
                qdrant_models.FieldCondition(key="subtopic_id",  match=qdrant_models.MatchValue(value=sub_lower)),
            ])
            try:
                docs, _, _ = await run_sync(
                    vector_service.search_documents,
                    query=subtopic_id.replace("_", " "),
                    k=20,
                    filter_conditions=filt,
                    collection_name=collection_name,
                )
                all_docs.extend(docs)
                if all_docs:
                    break
            except Exception as e_inner:
                logger.warning(f"[notes] search failed in {collection_name} for course='{cv}': {e_inner}")
        return all_docs

    try:
        stn_docs, ped_docs = await asyncio.gather(
            _search_notes(config.STN_QDRANT_COLLECTION),
            _search_notes(config.PEDAGOGICAL_QDRANT_COLLECTION),
        )
        # Prefer STN notes; augment with pedagogical if STN is thin
        combined = stn_docs or ped_docs
        if stn_docs and ped_docs:
            combined = stn_docs + [d for d in ped_docs if d not in stn_docs]

        notes = []
        for doc in combined:
            meta = doc.metadata
            content_key = "teaching_context" if "teaching_context" in meta else "content"
            raw_content  = meta.get(content_key) or doc.page_content or ""
            notes.append({
                "subtopic_id":   meta.get("subtopic_id", subtopic_id),
                "subtopic_name": meta.get("subtopic_name", subtopic_id.replace("_", " ").title()),
                "topic_name":    meta.get("topic_name", ""),
                "course":        meta.get("course", course),
                "content":       raw_content,
                "preview":       raw_content[:400],
            })

        return {
            "success":    True,
            "course":     course,
            "subtopic_id": subtopic_id,
            "notes":      notes,
            "count":      len(notes),
        }
    except Exception as e:
        logger.error(f"Error fetching notes for {course}/{subtopic_id}: {e}", exc_info=True)
        return _error(f"Failed to fetch notes: {e}", 500)


# ─── Lecture markdown endpoint ────────────────────────────────────────────────
# Reads the pre-generated lecture.md from disk and returns the Markdown slice
# that corresponds to the requested subtopic/concept.  The lecture.md produced
# by lecture_generator/note_writer.py has sections with anchors like:
#   ## N. Concept Name {#concept-name}
# We fuzzy-match the subtopic_id / subtopic name against those anchors/headers.

def _normalise(s: str) -> str:
    """Lower-case, strip punctuation, collapse spaces — for fuzzy matching."""
    import re
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _find_lecture_md(course: str) -> str | None:
    """Return the path to lecture.md for the given course, or None if not found."""
    bootstrap_dir = config.COURSE_BOOTSTRAP_DIR
    # Try exact course folder name first, then case-insensitive scan
    candidates = []
    try:
        for entry in os.listdir(bootstrap_dir):
            full = os.path.join(bootstrap_dir, entry)
            if os.path.isdir(full):
                candidates.append(entry)
    except OSError:
        return None

    # Prefer exact match, then case-insensitive
    course_lower = course.strip().lower()
    matched_folder = None
    for c in candidates:
        if c.lower() == course_lower:
            matched_folder = c
            break
    if matched_folder is None:
        # Partial match
        for c in candidates:
            if course_lower in c.lower() or c.lower() in course_lower:
                matched_folder = c
                break
    if matched_folder is None:
        return None

    course_folder = os.path.join(bootstrap_dir, matched_folder)
    lecture_notes_dir = os.path.join(course_folder, "lecture_notes")
    if not os.path.isdir(lecture_notes_dir):
        return None

    # Find any lecture.md inside lecture_notes/<AnySubdir>/
    for sub in os.listdir(lecture_notes_dir):
        candidate = os.path.join(lecture_notes_dir, sub, "lecture.md")
        if os.path.isfile(candidate):
            return candidate
    return None


def _extract_lecture_section(md_text: str, subtopic_id: str, subtopic_name: str) -> str | None:
    """
    Parse lecture.md and return the Markdown section for the matching concept.

    Sections are delimited by level-2 headings:
        ## N. Concept Name {#anchor}
    We match on:
      1. Anchor slug  → matches subtopic_id  (e.g. "machine-learning")
      2. Normalised heading title → matches normalised subtopic_id / subtopic_name
    Returns the full section text (from its ## heading up to, but not including,
    the next ## heading or end-of-file), or None if no match is found.
    """
    import re

    # Split into level-2 sections
    # A section starts at a line that begins with "## "
    section_pattern = re.compile(r'^(## .+)$', re.MULTILINE)
    splits = list(section_pattern.finditer(md_text))

    if not splits:
        return None  # No sections found — return full text as fallback

    sections: list[tuple[str, str]] = []  # (heading_line, section_body)
    for i, m in enumerate(splits):
        start = m.start()
        end   = splits[i + 1].start() if i + 1 < len(splits) else len(md_text)
        sections.append((m.group(0), md_text[start:end].rstrip()))

    # Build query tokens
    norm_id   = _normalise(subtopic_id.replace("_", " "))
    norm_name = _normalise(subtopic_name) if subtopic_name else norm_id

    # Also build the slug the way GitHub/Pandoc does: lower, replace spaces with -
    def to_slug(s: str) -> str:
        s = re.sub(r"[^a-z0-9\s-]", "", s.lower())
        return re.sub(r"\s+", "-", s.strip())

    id_slug   = to_slug(subtopic_id.replace("_", "-"))
    name_slug = to_slug(subtopic_name) if subtopic_name else id_slug

    best_section   = None
    best_score     = 0

    for heading_line, body in sections:
        # Extract anchor: {#some-anchor}
        anchor_match = re.search(r'\{#([^}]+)\}', heading_line)
        anchor = anchor_match.group(1) if anchor_match else ""

        # Strip number prefix and anchor from heading for text matching
        # "## 1. Machine Learning {#machine-learning}" → "Machine Learning"
        heading_text = re.sub(r'\{#[^}]+\}', '', heading_line)
        heading_text = re.sub(r'^#+\s*\d+\.\s*', '', heading_text).strip()
        norm_heading = _normalise(heading_text)

        score = 0
        # Exact anchor match → highest priority
        if anchor and (anchor == id_slug or anchor == name_slug):
            score = 100
        # Normalised heading matches query tokens
        elif norm_heading == norm_id or norm_heading == norm_name:
            score = 90
        # Heading contains the query
        elif norm_id and norm_id in norm_heading:
            score = 60
        elif norm_name and norm_name in norm_heading:
            score = 55
        # Query contains the heading (query is broader)
        elif norm_heading and norm_heading in norm_id:
            score = 40
        elif norm_heading and norm_heading in norm_name:
            score = 35

        if score > best_score:
            best_score = score
            best_section = body

    # Require at least a weak match
    if best_score >= 35:
        return best_section

    return None


@app.get("/curriculum/{course}/lecture/{subtopic_id}")
async def get_lecture_section_route(
    course: str,
    subtopic_id: str,
    subtopic_name: str = "",
    topic_name: str = "",
):
    """
    Return student-facing lecture Markdown for a subtopic.

    Priority:
    1. Per-subtopic disk cache  (subtopics/{subtopic_id}.md)  — instant
    2. lecture.md section match                               — instant if found
    3. LLM generation from STN context (SGLang→Gemini→Groq)  — ~5-15 s first time
       Result is cached to disk so future requests are instant.
    """
    try:
        import subtopic_lecture_generator as _slg

        name = subtopic_name or subtopic_id.replace("_", " ").title()

        # ── 1. Per-subtopic disk cache ──────────────────────────────────────────
        cached = await run_sync(_slg.load_from_cache, course, subtopic_id)
        if cached:
            return {
                "success":       True,
                "course":        course,
                "subtopic_id":   subtopic_id,
                "subtopic_name": name,
                "markdown":      cached,
                "matched":       True,
                "source":        "cache",
            }

        # ── 2. lecture.md section match ─────────────────────────────────────────
        md_path = await run_sync(_find_lecture_md, course)
        if md_path:
            md_text = await run_sync(lambda: open(md_path, encoding="utf-8").read())
            section = await run_sync(_extract_lecture_section, md_text, subtopic_id, subtopic_name)
            if section:
                # Save to per-subtopic cache so next request is instant
                await run_sync(_slg.save_to_cache, course, subtopic_id, section)
                return {
                    "success":       True,
                    "course":        course,
                    "subtopic_id":   subtopic_id,
                    "subtopic_name": name,
                    "markdown":      section,
                    "matched":       True,
                    "source":        "lecture_md",
                }

        # ── 3. LLM generation from STN ──────────────────────────────────────────
        logger.info(f"[lecture] Generating subtopic note via LLM: {course}/{subtopic_id}")
        markdown, from_cache = await run_sync(
            _slg.get_or_generate_lecture,
            course, subtopic_id, name, topic_name,
        )
        return {
            "success":       True,
            "course":        course,
            "subtopic_id":   subtopic_id,
            "subtopic_name": name,
            "markdown":      markdown,
            "matched":       from_cache or bool(markdown and not markdown.startswith("> ⚠️")),
            "source":        "generated",
            "generating":    not from_cache,
        }

    except Exception as e:
        logger.error(f"Error fetching lecture section for {course}/{subtopic_id}: {e}", exc_info=True)
        return _error(f"Failed to fetch lecture section: {e}", 500)


@app.post("/curriculum/{course}/lecture/batch-generate")
async def batch_generate_subtopic_lectures(course: str):
    """
    Trigger background pre-generation of per-subtopic lecture notes for all
    subtopics in the course curriculum graph.  Safe to call multiple times —
    subtopics that already have a cached note are skipped instantly.
    """
    try:
        if not curriculum_graph_handler:
            return _error("Curriculum graph handler not available (no subtopic list)", 503)

        structure = await run_sync(curriculum_graph_handler.traverse_curriculum, course)
        if not structure:
            return _error(f"No curriculum structure found for '{course}'", 404)

        # Flatten subtopics
        subtopics_flat = []
        for mod in (structure.get("modules") or []):
            for top in (mod.get("topics") or []):
                topic_name = top.get("name") or top.get("id") or ""
                for sub in (top.get("subtopics") or []):
                    subtopics_flat.append({
                        "id":         sub.get("id") or "",
                        "name":       sub.get("name") or "",
                        "topic_name": topic_name,
                    })

        if not subtopics_flat:
            return {"success": True, "course": course, "message": "No subtopics found", "count": 0}

        import subtopic_lecture_generator as _slg

        def _run_batch():
            _slg.generate_all_subtopic_lectures(course, subtopics_flat)

        # Run in background thread so the HTTP response returns immediately
        import threading
        t = threading.Thread(target=_run_batch, daemon=True)
        t.start()

        return {
            "success": True,
            "course":  course,
            "message": f"Batch generation started for {len(subtopics_flat)} subtopics (background). "
                       "Results will be cached to disk — subsequent requests will be instant.",
            "count":   len(subtopics_flat),
        }

    except Exception as e:
        logger.error(f"Batch lecture generation error for {course}: {e}", exc_info=True)
        return _error(f"Batch generation failed: {e}", 500)


@app.get("/curriculum/{course}/prerequisites/{topic_id}")
async def get_topic_prerequisites_route(course: str, topic_id: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        prerequisites = await run_sync(curriculum_graph_handler.get_topic_prerequisites, course, topic_id)
        return {"course": course, "topic_id": topic_id, "prerequisites": prerequisites}
    except Exception as e:
        logger.error(f"Error getting prerequisites: {e}", exc_info=True)
        return _error(f"Failed to get prerequisites: {e}", 500)


@app.get("/curriculum/{course}/path/{topic_id}")
async def get_learning_path_route(course: str, topic_id: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        learning_path = await run_sync(curriculum_graph_handler.get_learning_path, course, topic_id)
        return {"course": course, "target_topic": topic_id, "learning_path": learning_path}
    except Exception as e:
        logger.error(f"Error getting learning path: {e}", exc_info=True)
        return _error(f"Failed to get learning path: {e}", 500)


@app.get("/curriculum/{course}/next-module/{module_id}")
async def get_next_module_route(course: str, module_id: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        next_module = await run_sync(curriculum_graph_handler.get_next_module, course, module_id)
        return {"course": course, "current_module": module_id, "next_module": next_module}
    except Exception as e:
        logger.error(f"Error getting next module: {e}", exc_info=True)
        return _error(f"Failed to get next module: {e}", 500)


@app.post("/curriculum/{course}/missing-prerequisites")
async def detect_missing_prerequisites_route(course: str, body: MissingPrerequisitesRequest):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        missing = await run_sync(
            curriculum_graph_handler.detect_missing_prerequisites,
            course, body.topic_id, body.completed_subtopics,
        )
        return {"course": course, "topic_id": body.topic_id, "missing_prerequisites": missing}
    except Exception as e:
        logger.error(f"Error detecting missing prerequisites: {e}", exc_info=True)
        return _error(f"Failed to detect missing prerequisites: {e}", 500)


@app.delete("/curriculum/{course}")
async def delete_curriculum_route(course: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        result = await run_sync(curriculum_graph_handler.delete_course_curriculum, course)
        try:
            gc_result               = await run_sync(curriculum_graph_handler.gc_orphaned_nodes)
            result["orphaned_cleaned"] = gc_result.get("deleted_count", 0)
        except Exception:
            pass
        return result
    except Exception as e:
        logger.error(f"Error deleting curriculum: {e}", exc_info=True)
        return _error(f"Failed to delete curriculum: {e}", 500)


# ============================================================================
# ROUTES — SYLLABUS-QDRANT LINKER
# ============================================================================
try:
    import syllabus_qdrant_linker as _sql
except ImportError as e:
    logger.warning(f"Failed to import syllabus_qdrant_linker: {e}")
    _sql = None


@app.post("/curriculum/link-documents")
async def link_documents_to_curriculum_route(body: LinkDocumentsRequest):
    logger.info("--- /curriculum/link-documents Request ---")
    if not _sql:
        return _error("Syllabus-Qdrant linker not available", 503)
    if not os.path.exists(body.syllabus_csv_path):
        return _error(f"Syllabus CSV not found: {body.syllabus_csv_path}", 404)
    if not os.path.isdir(body.documents_folder):
        return _error(f"Documents folder not found: {body.documents_folder}", 404)

    try:
        linker      = _sql.SyllabusQdrantLinker()
        num_entries = await run_sync(linker.load_syllabus, body.syllabus_csv_path, body.course_name)
        logger.info(f"Loaded {num_entries} syllabus entries for '{body.course_name}'")

        resource_summary = await run_sync(linker.get_resource_summary)
        results = {
            "course_name":             body.course_name,
            "syllabus_entries_loaded": num_entries,
            "resources_in_syllabus":   list(resource_summary.keys()),
            "documents_processed":     [],
            "documents_skipped":       [],
            "total_chunks_added":      0,
        }
        supported = {".pdf", ".docx", ".pptx", ".txt", ".csv"}
        for filename in os.listdir(body.documents_folder):
            if os.path.splitext(filename)[1].lower() not in supported:
                continue
            file_path    = os.path.join(body.documents_folder, filename)
            syllabus_ctx = await run_sync(linker.get_context_for_document, filename)
            doc_result   = {"filename": filename, "syllabus_linked": syllabus_ctx is not None}
            if syllabus_ctx:
                doc_result["syllabus_context"] = {
                    "module": syllabus_ctx.module,
                    "topic":  syllabus_ctx.topic,
                    "lecture_number": syllabus_ctx.lecture_number,
                }
            try:
                base_metadata     = {"user_id": body.user_id, "original_name": filename, "file_name": filename}
                enriched_metadata = await run_sync(linker.enrich_metadata_with_syllabus, base_metadata, filename)
                processed_chunks, raw_text, kg_chunks = await run_sync(
                    ai_core.process_document_for_qdrant,
                    file_path=file_path, original_name=filename, user_id=body.user_id,
                )
                for chunk in processed_chunks:
                    if chunk.get("metadata"):
                        for key, value in enriched_metadata.items():
                            if key.startswith("syllabus_"):
                                chunk["metadata"][key] = value
                if processed_chunks and vector_service:
                    num_added                      = await run_sync(vector_service.add_processed_chunks, processed_chunks)
                    doc_result["chunks_added"]     = num_added
                    results["total_chunks_added"] += num_added
                else:
                    doc_result["chunks_added"] = 0
                doc_result["status"] = "success"
                results["documents_processed"].append(doc_result)
            except Exception as e:
                logger.error(f"Error processing document '{filename}': {e}", exc_info=True)
                doc_result["status"] = "error"
                doc_result["error"]  = str(e)
                results["documents_skipped"].append(doc_result)

        return JSONResponse({
            "success": True,
            "message": f"Processed {len(results['documents_processed'])} documents for '{body.course_name}'",
            **results,
        }, status_code=201)
    except Exception as e:
        logger.error(f"Error in link-documents: {e}", exc_info=True)
        return _error(f"Failed to link documents: {e}", 500)


@app.get("/curriculum/resource-summary/{course_name}")
async def get_resource_summary_route(course_name: str):
    if not _sql:
        return _error("Syllabus-Qdrant linker not available", 503)
    linker = _sql.get_linker()
    if not linker.loaded:
        return _error("No syllabus loaded. Call /curriculum/link-documents first.", 400)
    summary = linker.get_resource_summary()
    return {"course": linker.course_name, "resources": summary}


# ============================================================================
# ROUTES — UNIFIED COURSE PIPELINE
# ============================================================================
try:
    import course_pipeline as _cp
except ImportError as e:
    logger.warning(f"Failed to import course_pipeline: {e}")
    _cp = None


@app.post("/course/ingest")
async def ingest_course_route(body: CourseIngestRequest):
    logger.info("--- /course/ingest Request (Unified Pipeline) ---")
    if not _cp:
        return _error("Course pipeline not available", 503)
    try:
        result = await run_sync(
            _cp.ingest_course,
            course_name=body.course_name,
            syllabus_csv_path=body.syllabus_csv_path,
            materials_folder=body.materials_folder,
            user_id=body.user_id,
        )
        return JSONResponse(result, status_code=201 if result.get("success") else 400)
    except Exception as e:
        logger.error(f"Error in course ingestion: {e}", exc_info=True)
        return _error(f"Course ingestion failed: {e}", 500)


@app.post("/course/stn_from_kg")
async def stn_from_kg_endpoint(request: Request):
    """Trigger concept-aware STN generation from a KnowledgeGraph."""
    try:
        body = await request.json()
        course_name = body.get("course_name", "")
        concepts = body.get("concepts", [])
        if not course_name or not concepts:
            return JSONResponse({"error": "course_name and concepts required"}, status_code=400)
        thread = subtopic_notes_generator.generate_course_notes_from_kg(course_name, concepts)
        return JSONResponse({
            "status": "started",
            "course": course_name,
            "concept_count": len(concepts),
            "thread": thread.name,
        })
    except Exception as e:
        logger.error(f"STN from KG error: {e}", exc_info=True)
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/course/{course}/topic/{topic_id}/context")
async def get_topic_context_route(course: str, topic_id: str):
    if not _cp:
        return _error("Course pipeline not available", 503)
    try:
        return await run_sync(_cp.get_topic_context, course, topic_id)
    except Exception as e:
        logger.error(f"Error getting topic context: {e}", exc_info=True)
        return _error(f"Failed to get topic context: {e}", 500)


@app.get("/course/{course}/topic/{topic_id}/next")
async def get_next_curriculum_item_route(course: str, topic_id: str):
    if not _cp:
        return _error("Course pipeline not available", 503)
    try:
        next_item = await run_sync(_cp.get_next_curriculum_item, course, topic_id)
        return {"course": course, "current_topic": topic_id, "next_item": next_item, "course_complete": next_item is None}
    except Exception as e:
        logger.error(f"Error getting next curriculum item: {e}", exc_info=True)
        return _error(f"Failed to get next item: {e}", 500)


@app.post("/course/{course}/topic/{topic_id}/missing-prerequisites")
async def detect_missing_prerequisites_tutor_route(course: str, topic_id: str, body: TopicMissingPrerequisitesRequest):
    if not _cp:
        return _error("Course pipeline not available", 503)
    try:
        missing = await run_sync(_cp.detect_missing_prerequisites, course, topic_id, body.completed_subtopics)
        return {
            "course": course, "topic_id": topic_id,
            "missing_prerequisites": missing, "has_missing": len(missing) > 0,
        }
    except Exception as e:
        logger.error(f"Error detecting prerequisites: {e}", exc_info=True)
        return _error(f"Failed to check prerequisites: {e}", 500)


@app.get("/course/{course}/visualization")
async def get_curriculum_visualization_route(course: str):
    if not curriculum_graph_handler:
        return _error("Curriculum graph handler not available", 503)
    try:
        curriculum = await run_sync(curriculum_graph_handler.traverse_curriculum, course)
        nodes, edges = [], []
        modules = curriculum.get("modules", [])
        for i, module in enumerate(modules):
            module_id = module.get("id")
            nodes.append({"id": module_id, "label": module.get("name"), "type": "module", "order": module.get("order", i + 1)})
            if i > 0:
                edges.append({"from": modules[i - 1].get("id"), "to": module_id, "type": "PRECEDES"})
            for topic in module.get("topics", []):
                topic_id = topic.get("id")
                nodes.append({"id": topic_id, "label": topic.get("name"), "type": "topic", "module_id": module_id})
                edges.append({"from": module_id, "to": topic_id, "type": "HAS_TOPIC"})
                for subtopic in topic.get("subtopics", []):
                    subtopic_id = subtopic.get("id")
                    if not any(n["id"] == subtopic_id for n in nodes):
                        nodes.append({"id": subtopic_id, "label": subtopic.get("name"), "type": "subtopic", "topic_id": topic_id})
                    edges.append({"from": subtopic_id, "to": topic_id, "type": "PREREQUISITE_OF"})

        logger.info(f"Visualization for '{course}': {len(nodes)} nodes, {len(edges)} edges")
        return {"course": course, "nodes": nodes, "edges": edges}
    except Exception as e:
        logger.error(f"Error getting visualization: {e}", exc_info=True)
        return _error(f"Failed to get visualization: {e}", 500)


# ============================================================================
# ROUTES — MEDIA PROCESSING
# ============================================================================
@app.post("/process_media_file")
async def process_media_file_route(body: ProcessMediaRequest):
    logger.info("--- /process_media_file Request ---")
    if not os.path.exists(body.file_path):
        return _error(f"File not found at path: {body.file_path}", 404)
    try:
        text_content = None
        if body.media_type == "audio":
            text_content = await run_sync(media_processor.process_uploaded_audio, body.file_path)
        elif body.media_type == "video":
            text_content = await run_sync(media_processor.process_uploaded_video, body.file_path)
        elif body.media_type == "image":
            text_content = await run_sync(media_processor.process_uploaded_image, body.file_path)
        else:
            return _error(f"Unsupported media_type: {body.media_type}", 400)

        if not text_content or not text_content.strip():
            return _error(f"Failed to extract meaningful text from the {body.media_type} file.", 422)

        return {
            "success": True,
            "message": f"Successfully extracted text from {body.media_type} file.",
            "text_content": text_content,
        }
    except Exception as e:
        logger.error(f"Error in /process_media_file for type '{body.media_type}': {e}", exc_info=True)
        return _error(f"Failed to process {body.media_type} file: {e}", 500)


@app.post("/process_url")
async def process_url_source_route(body: ProcessURLRequest):
    logger.info("--- /process_url Request ---")
    try:
        extracted_text, final_title, source_type = await run_sync(
            knowledge_engine.process_url_source, body.url, body.user_id
        )
        if not extracted_text:
            return _error(f"Failed to extract meaningful text from the {source_type}.", 422)
        return {
            "success": True,
            "message": f"Successfully extracted text from {source_type}.",
            "text_content": extracted_text,
            "title": final_title,
            "source_type": source_type,
        }
    except Exception as e:
        logger.error(f"Error in /process_url for URL '{body.url}': {e}", exc_info=True)
        return _error(f"Failed to process URL: {e}", 500)


# ============================================================================
# ROUTES — COURSE MATERIAL PIPELINE  (course_bootstrap/ → Markdown → Qdrant → STN)
# ============================================================================
import course_material_processor as _cmp

@app.post("/pipeline/run")
async def pipeline_run_all(background_tasks: BackgroundTasks):
    """
    Trigger the full material processing pipeline for ALL courses in course_bootstrap/.
    Runs in background. Resumable — skips already-completed stages.
    """
    courses = _cmp.discover_courses()
    if not courses:
        return {"success": False, "message": "No course folders found in course_bootstrap/"}
    _cmp.process_all_courses_background()
    return {
        "success": True,
        "message": f"Pipeline started in background for {len(courses)} course(s).",
        "courses": [c["name"] for c in courses],
    }

@app.post("/pipeline/run/{course_name}")
async def pipeline_run_course(course_name: str, background_tasks: BackgroundTasks):
    """Trigger the material processing pipeline for a single course."""
    course_dir = os.path.join(_cmp.BOOTSTRAP_DIR, course_name)
    if not os.path.isdir(course_dir):
        return _error(f"Course folder not found: {course_name}", 404)

    import threading as _thr
    def _worker():
        try:
            _cmp.process_course(course_name, course_dir)
        except Exception as e:
            logger.error(f"Pipeline error for {course_name}: {e}", exc_info=True)
    _thr.Thread(target=_worker, daemon=True, name=f"pipeline:{course_name}").start()

    return {"success": True, "message": f"Pipeline started for '{course_name}'."}

@app.get("/pipeline/status")
async def pipeline_status_all():
    """Get pipeline status for all courses."""
    return _cmp.get_pipeline_status()

@app.get("/pipeline/status/{course_name}")
async def pipeline_status_course(course_name: str):
    """Get pipeline status for a specific course."""
    return _cmp.get_pipeline_status(course_name)


# ============================================================================
# ROUTES — COURSE MATERIAL INGESTION  (server/Cpurses/{CourseName}/*.pdf)
# ============================================================================
import hashlib as _hashlib
import shutil as _shutil
import threading as _threading

_CPURSES_DIR    = os.path.abspath(getattr(config, "CPURSES_DIR", os.path.join(os.path.dirname(__file__), "..", "Cpurses")))
_COURSE_USER_ID = "__course_material__"  # Sentinel user_id so course chunks are distinct from user uploads
_INGEST_LOCKS: dict = {}          # per-course threading.Lock to prevent concurrent double-ingest
_INGEST_LOCKS_LOCK = _threading.Lock()

def _get_course_lock(course_name: str) -> _threading.Lock:
    with _INGEST_LOCKS_LOCK:
        if course_name not in _INGEST_LOCKS:
            _INGEST_LOCKS[course_name] = _threading.Lock()
        return _INGEST_LOCKS[course_name]


def _pdf_sha256(path: str) -> str:
    h = _hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _load_manifest(processed_dir: str) -> dict:
    """Load the per-course ingestion manifest (sha256 → filename)."""
    manifest_path = os.path.join(processed_dir, ".manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_manifest(processed_dir: str, manifest: dict):
    manifest_path = os.path.join(processed_dir, ".manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)


def _move_to_backup(src: str, backup_subdir: str):
    """Move a file to a _processed or _markdown backup subfolder."""
    os.makedirs(backup_subdir, exist_ok=True)
    dst = os.path.join(backup_subdir, os.path.basename(src))
    # If destination exists, don't overwrite — just leave original in place
    if not os.path.exists(dst):
        _shutil.move(src, dst)
        logger.info(f"Moved to backup: {dst}")
    else:
        logger.debug(f"Backup already exists, skipping move: {dst}")


def _ingest_course_pdfs_worker(course_name: str, course_dir: str):
    """Background worker: ingest all new PDFs in a course folder into Qdrant."""
    lock = _get_course_lock(course_name)
    if not lock.acquire(blocking=False):
        logger.info(f"Course ingest [{course_name}]: already running, skipping duplicate call.")
        return 0
    try:
        return _ingest_course_pdfs_locked(course_name, course_dir)
    finally:
        lock.release()


def _ingest_course_pdfs_locked(course_name: str, course_dir: str):
    """Actual ingestion logic — called only when the per-course lock is held."""
    processed_dir = os.path.join(course_dir, "_processed")
    markdown_dir  = os.path.join(course_dir, "_markdown")
    os.makedirs(processed_dir, exist_ok=True)
    os.makedirs(markdown_dir, exist_ok=True)

    manifest = _load_manifest(processed_dir)
    pdfs = [f for f in os.listdir(course_dir) if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(course_dir, f))]
    logger.info(f"Course ingest [{course_name}]: found {len(pdfs)} PDFs to check.")

    ingested_count = 0
    for fname in pdfs:
        fpath = os.path.join(course_dir, fname)
        sha   = _pdf_sha256(fpath)

        if sha in manifest:
            logger.debug(f"Already ingested (SHA match): {fname}")
            continue

        logger.info(f"Ingesting course PDF: {course_name}/{fname}")
        try:
            def _marker_callback(md_text, orig_fname=fname):
                """Called when marker finishes — save markdown backup."""
                md_path = os.path.join(markdown_dir, os.path.splitext(orig_fname)[0] + ".md")
                try:
                    with open(md_path, "w", encoding="utf-8") as f:
                        f.write(md_text)
                    logger.info(f"Markdown backup saved: {md_path}")
                except Exception as e:
                    logger.warning(f"Markdown backup write failed for {orig_fname}: {e}")

            fast_text = pdf_processor.process_pdf_dual_mode(
                file_path=fpath,
                original_name=fname,
                user_id=_COURSE_USER_ID,
                on_quality_ready=_marker_callback,
            )

            if fast_text:
                chunks, _, _ = ai_core.process_document_for_qdrant(
                    file_path=fpath,
                    original_name=fname,
                    user_id=_COURSE_USER_ID,
                    text_content_override=fast_text,
                )
                if chunks:
                    added = vector_service.add_processed_chunks(chunks)
                    logger.info(f"Ingested {added} chunks from {course_name}/{fname}")

            # Record in manifest and move PDF to _processed/
            manifest[sha] = fname
            _save_manifest(processed_dir, manifest)
            ingested_count += 1
            _move_to_backup(fpath, processed_dir)

        except Exception as e:
            logger.error(f"Error ingesting {course_name}/{fname}: {e}", exc_info=True)

    logger.info(f"Course ingest [{course_name}]: {ingested_count} new PDFs ingested.")
    return ingested_count


@app.post("/ingest/cpurses")
async def ingest_cpurses(background_tasks: BackgroundTasks):
    """
    Scan server/Cpurses/ for all course folders, ingest any new PDFs into Qdrant,
    move processed PDFs to _processed/ and markdown to _markdown/, then trigger
    STN regeneration for courses that had new material.
    """
    if not os.path.isdir(_CPURSES_DIR):
        return {"success": False, "message": f"Cpurses dir not found: {_CPURSES_DIR}"}

    courses = [d for d in os.listdir(_CPURSES_DIR)
               if os.path.isdir(os.path.join(_CPURSES_DIR, d)) and not d.startswith("_")]

    if not courses:
        return {"success": True, "message": "No course folders found.", "courses": []}

    async def _run_all():
        for course_folder in courses:
            course_dir  = os.path.join(_CPURSES_DIR, course_folder)
            course_name = course_folder.replace("_", " ").lower()
            ingested = await run_sync(_ingest_course_pdfs_worker, course_name, course_dir)
            if ingested > 0:
                logger.info(f"New material ingested for '{course_name}' — STN regeneration should be triggered via /stn/course.")

    background_tasks.add_task(lambda: asyncio.run(_run_all()) if False else None)
    # Run directly as a background coroutine
    import asyncio as _aio
    _aio.create_task(_run_all())

    return {
        "success": True,
        "message": f"Ingestion started for {len(courses)} course(s) in background.",
        "courses": courses,
        "cpurses_dir": _CPURSES_DIR,
    }


@app.get("/ingest/status")
async def ingest_status():
    """List all courses in Cpurses and how many PDFs are in each state."""
    if not os.path.isdir(_CPURSES_DIR):
        return {"error": f"Cpurses dir not found: {_CPURSES_DIR}"}

    result = {}
    for course_folder in os.listdir(_CPURSES_DIR):
        course_dir = os.path.join(_CPURSES_DIR, course_folder)
        if not os.path.isdir(course_dir) or course_folder.startswith("_"):
            continue
        pending   = [f for f in os.listdir(course_dir) if f.lower().endswith(".pdf")]
        processed = [f for f in os.listdir(os.path.join(course_dir, "_processed")) if f.lower().endswith(".pdf")] if os.path.isdir(os.path.join(course_dir, "_processed")) else []
        markdown  = [f for f in os.listdir(os.path.join(course_dir, "_markdown"))  if f.lower().endswith(".md")]  if os.path.isdir(os.path.join(course_dir, "_markdown"))  else []
        result[course_folder] = {"pending_pdfs": len(pending), "processed_pdfs": len(processed), "markdown_files": len(markdown)}
    return result


# ============================================================================
# SKILL TREE QUESTION GENERATION (Bloom's Taxonomy + Hardness Levels)
# ============================================================================

class QuestionGenerationRequest(BaseModel):
    prompt: str
    skill_id: str
    bloom_level: str  # remember, understand, apply, analyze, evaluate, create
    hardness: str     # easy, medium, hard


@app.post("/generate/question")
async def generate_skill_tree_question(request: QuestionGenerationRequest):
    """
    Generate unique skill tree assessment questions using constrained JSON.
    
    Uses SGLang with constrained decoding to ensure valid JSON output.
    Generates questions across Bloom's taxonomy levels and hardness levels.
    """
    try:
        # Use SGLang with constrained decoding for guaranteed valid JSON
        sglang_enabled = os.getenv("SGLANG_ENABLED", "true").lower() == "true"
        
        if not sglang_enabled:
            return JSONResponse(
                status_code=503,
                content={"error": "SGLang is required for question generation but is not enabled"}
            )
        
        sglang_url = os.getenv("SGLANG_HEAVY_URL", "http://localhost:8000/v1")
        sglang_model = os.getenv("SGLANG_HEAVY_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ")
        
        # Import OpenAI client for SGLang API compatibility
        try:
            from openai import OpenAI
        except ImportError:
            return JSONResponse(
                status_code=500,
                content={"error": "OpenAI SDK not installed (required for SGLang)"}
            )
        
        client = OpenAI(base_url=sglang_url, api_key="EMPTY")
        
        # Define Pydantic schema for constrained decoding
        try:
            from pydantic import BaseModel as PydanticBase
            
            class QuestionOutput(PydanticBase):
                question: str
                options: list[str]
                correctAnswer: str
                explanation: str
                bloomLevel: str
                difficulty: str
        except ImportError:
            return JSONResponse(
                status_code=500,
                content={"error": "Pydantic not installed (required for schema validation)"}
            )
        
        # Generate question with constrained JSON
        response = client.chat.completions.create(
            model=sglang_model,
            messages=[
                {"role": "system", "content": "You are an expert educator creating assessment questions."},
                {"role": "user", "content": request.prompt}
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "schema": QuestionOutput.model_json_schema(),
                    "strict": True
                }
            },
            temperature=0.7,  # Some creativity for question variety
            max_tokens=1024
        )
        
        # Parse and return the generated question
        question_json = json.loads(response.choices[0].message.content)
        
        return {
            "status": "success",
            "question": question_json
        }
        
    except Exception as e:
        logging.getLogger(__name__).error(f"[QUESTION_GEN] Failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Question generation failed: {str(e)}"}
        )


# ============================================================================
# [Team6] CURRICULUM OUTLINE EXTRACTION — Syllabus PDF/DOCX → JSON
# ============================================================================
@app.post("/curriculum-outline")
async def extract_curriculum_outline(request: Request):
    """
    Convert an uploaded syllabus file (PDF/DOCX/TXT) into a structured
    Module -> Topic -> Subtopic JSON outline, compatible with the course
    bootstrap pipeline. Uses OCR for image-based PDFs, rejects corrupt images.
    """
    try:
        if curriculum_outline_extractor is None:
            return JSONResponse(
                status_code=503,
                content={"error": "curriculum_outline_extractor module not available"}
            )
        data = await request.json()
        file_path = data.get("file_path", "")
        course_name = data.get("course_name", "Untitled Course")

        if not file_path or not os.path.exists(file_path):
            return JSONResponse(
                status_code=400,
                content={"error": "file_path is required and must exist on server"}
            )

        text = curriculum_outline_extractor.extract_text_from_upload(file_path)
        if not text or not text.strip():
            return JSONResponse(
                status_code=422,
                content={"error": "Could not extract readable text from the uploaded file"}
            )

        outline = curriculum_outline_extractor.build_outline_from_text(text, course_name)
        logging.getLogger(__name__).info(
            f"[CURRICULUM_OUTLINE] Extracted {len(outline.get('modules', []))} modules, "
            f"{len(outline.get('topics', []))} topics for course '{course_name}'"
        )
        return JSONResponse(content={"success": True, "outline": outline})

    except Exception as e:
        logging.getLogger(__name__).error(f"[CURRICULUM_OUTLINE] Failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Curriculum outline extraction failed: {str(e)}"}
        )


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=config.API_PORT,
        reload=False,
        workers=1,          # increase to os.cpu_count() in production
        log_level="info",
    )
