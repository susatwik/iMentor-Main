# server/rag_service/config.py
import os
import logging
from dotenv import load_dotenv
from pythonjsonlogger import jsonlogger
from datetime import datetime, timezone

# --- Load .env from the parent 'server' directory ---
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path=dotenv_path)


class JsonFormatterWithMilliseconds(jsonlogger.JsonFormatter):
    """
    A custom JSON formatter that correctly formats timestamps with milliseconds and a 'Z' for UTC.
    This overrides the default formatTime method which uses a function that doesn't support %f.
    """
    def formatTime(self, record, datefmt=None):
        # Use the record's creation time and make it timezone-aware (UTC)
        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        
        # Format it to ISO 8601 with milliseconds, then replace the timezone info with 'Z'
        # Example: 2024-01-01T12:34:56.123456+00:00 -> 2024-01-01T12:34:56.123Z
        return dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z')

class ColorFormatter(logging.Formatter):
    """Custom formatter for readable console logs with colors."""
    COLORS = {
        'DEBUG': '\033[94m',      # Blue
        'INFO': '\033[92m',       # Green
        'WARNING': '\033[93m',    # Yellow
        'ERROR': '\033[91m',      # Red
        'CRITICAL': '\033[1;91m', # Bold Red
    }
    RESET = '\033[0m'
    
    def format(self, record):
        # ServiceContextFilter makes levelname lower, so we restore it for color mapping
        orig_level = getattr(record, 'levelname', 'INFO').upper()
        color = self.COLORS.get(orig_level, self.RESET)
        dt = datetime.fromtimestamp(record.created).strftime('%H:%M:%S')
        
        # Try to extract a subsystem/module name for better context
        module_name = record.name.split('.')[-1]
        if module_name == '__main__' or not module_name:
            module_name = 'SYSTEM'
        elif len(module_name) > 10:
            module_name = module_name[:10]
            
        msg = f"{dt} | {color}{orig_level.ljust(8)}{self.RESET} | {color}[{module_name.upper().ljust(10)}]{self.RESET} {record.getMessage()}"
        return msg

def setup_logging():
    """Configure logging to output structured, standardized JSON to a dedicated log file."""
    root_logger = logging.getLogger()
    if root_logger.handlers:
        for handler in root_logger.handlers:
            root_logger.removeHandler(handler)

    log_dir = os.path.join(os.path.dirname(__file__), '..', 'logs')
    os.makedirs(log_dir, exist_ok=True)
    # --- CHANGE 1: Dedicated log file ---
    log_file_path = os.path.join(log_dir, 'python-rag.log')
    
    formatter = JsonFormatterWithMilliseconds(
        '%(asctime)s %(levelname)s %(name)s %(lineno)d %(message)s %(service)s',
        rename_fields={
            'asctime': '@timestamp',
            'levelname': 'log.level',
            'name': 'log.logger',
            'lineno': 'log.origin.file.line',
            'service': 'service.name'
        }
    )
    
    class ServiceContextFilter(logging.Filter):
        def filter(self, record):
            # Standardize log level to lowercase
            record.levelname = record.levelname.lower()
            record.service = "ai-tutor-python-rag"
            return True

    service_filter = ServiceContextFilter()
    
    file_handler = logging.FileHandler(log_file_path, mode='a')
    file_handler.setFormatter(formatter)
    file_handler.addFilter(service_filter)
    root_logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(ColorFormatter())
    console_handler.addFilter(service_filter)
    root_logger.addHandler(console_handler)
    
    LOGGING_LEVEL = os.getenv('LOGGING_LEVEL', 'INFO').upper()
    root_logger.setLevel(LOGGING_LEVEL)
    
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)
    # Neo4j emits label-not-found notifications when querying labels that don't
    # exist yet (e.g. 'Concept' before any curriculum is uploaded). These are
    # expected and not actionable, so suppress them.
    logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)
    init_logger = logging.getLogger(__name__)
    init_logger.info(f"Python logging initialized and standardized. Appending to: {log_file_path}")

setup_logging()


# ─── Logging Configuration ───────────────────────────
logger = logging.getLogger(__name__)
LOGGING_LEVEL_NAME = os.getenv('LOGGING_LEVEL', 'INFO').upper()
LOGGING_LEVEL      = getattr(logging, LOGGING_LEVEL_NAME, logging.INFO)
LOGGING_FORMAT     = '%(asctime)s - %(levelname)s - [%(name)s:%(lineno)d] - %(message)s'


# --- API Keys and Service URLs ---
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
GEMINI_MODEL_NAME = os.getenv('GEMINI_MODEL', 'gemini-2.0-flash')

# Gemini is ONLY used when the admin has explicitly validated the key.
# A key that is the placeholder value 'your_openai_api_key' or similar is
# treated as unvalidated. Set GEMINI_API_VALIDATED=true in .env after
# confirming the key works in the admin panel.
_gemini_raw_key = GEMINI_API_KEY or ''
_GEMINI_PLACEHOLDER = _gemini_raw_key in ('', 'your_gemini_api_key', 'your_openai_api_key', 'sk-...')
GEMINI_VALIDATED = (
    not _GEMINI_PLACEHOLDER and
    os.getenv('GEMINI_API_VALIDATED', 'false').lower() == 'true'
)

# SGLang — primary LLM for all generation tasks (course material, study Qs, skill tree)
SGLANG_ENABLED      = os.getenv('SGLANG_ENABLED', 'true').lower() == 'true'
SGLANG_HEAVY_URL    = os.getenv('SGLANG_HEAVY_URL', 'http://localhost:8000/v1')
SGLANG_HEAVY_MODEL  = os.getenv('SGLANG_HEAVY_MODEL', 'Qwen/Qwen2.5-7B-Instruct-AWQ')
SENTRY_DSN = os.getenv('SENTRY_DSN') or None  # Treat empty string as unset
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379/0')

# Groq — fast cloud LLM for fallback generation (lecture notes, study Qs, etc.)
GROQ_API_KEY   = os.getenv('GROQ_API_KEY', '')
GROQ_MODEL_NAME = os.getenv('GROQ_MODEL_NAME', 'llama-3.3-70b-versatile')

# ─── LLM Provider Fallback Configuration ────────────────────────────────────
# Priority order for LLM providers. First healthy provider will be used.
# Options: sglang, grok, gemini, ollama
LLM_PROVIDER_PRIORITY = os.getenv('LLM_PROVIDER_PRIORITY', 'sglang,grok,gemini,ollama')

# Grok (xAI) — secondary provider
GROK_MODEL = os.getenv('GROK_MODEL', 'grok-2-latest')

# Ollama — local fallback (re-enabled for fallback pipeline)
OLLAMA_URL = os.getenv('OLLAMA_URL', 'http://localhost:11434')
OLLAMA_MODEL = os.getenv('OLLAMA_MODEL', 'qwen2.5:7b-instruct')

# ─── SGLang — primary LLM for all generation tasks ───────────────────────────
SGLANG_ENABLED      = os.getenv('SGLANG_ENABLED', 'true').lower() == 'true'
SGLANG_HEAVY_URL    = os.getenv('SGLANG_HEAVY_URL', 'http://localhost:8000/v1')
SGLANG_HEAVY_MODEL  = os.getenv('SGLANG_HEAVY_MODEL', 'Qwen/Qwen2.5-7B-Instruct-AWQ')

TURNITIN_API_URL = os.getenv('TURNITIN_API_URL')
TURNITIN_API_KEY = os.getenv('TURNITIN_API_KEY')
TURNITIN_API_SECRET = os.getenv('TURNITIN_API_SECRET')

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7688")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", 6335))
QDRANT_COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "my_qdrant_rag_collection")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", None)
QDRANT_URL = os.getenv("QDRANT_URL", None)

# --- Embedding Model Configuration ---
DEFAULT_DOC_EMBED_MODEL = 'mixedbread-ai/mxbai-embed-large-v1'
DOCUMENT_EMBEDDING_MODEL_NAME = os.getenv('DOCUMENT_EMBEDDING_MODEL_NAME', DEFAULT_DOC_EMBED_MODEL)

_MODEL_TO_DIM_MAPPING = {
    'mixedbread-ai/mxbai-embed-large-v1': 1024,
    'BAAI/bge-large-en-v1.5': 1024,
    'all-MiniLM-L6-v2': 384,
    'sentence-transformers/all-mpnet-base-v2': 768,
}
_FALLBACK_DIM = 768
DOCUMENT_VECTOR_DIMENSION = int(os.getenv("DOCUMENT_VECTOR_DIMENSION", _MODEL_TO_DIM_MAPPING.get(DOCUMENT_EMBEDDING_MODEL_NAME, _FALLBACK_DIM)))
QDRANT_COLLECTION_VECTOR_DIM = DOCUMENT_VECTOR_DIMENSION

QUERY_EMBEDDING_MODEL_NAME = os.getenv("QUERY_EMBEDDING_MODEL_NAME", DOCUMENT_EMBEDDING_MODEL_NAME)
QUERY_VECTOR_DIMENSION = int(os.getenv("QUERY_VECTOR_DIMENSION", _MODEL_TO_DIM_MAPPING.get(QUERY_EMBEDDING_MODEL_NAME, _FALLBACK_DIM)))

if QUERY_VECTOR_DIMENSION != QDRANT_COLLECTION_VECTOR_DIM:
    logger.warning(f"[Config Warning] Query vector dim ({QUERY_VECTOR_DIMENSION}) != Qdrant dim ({QDRANT_COLLECTION_VECTOR_DIM})")

# --- Embedding Provider (sentence_transformers — Ollama removed) ---
# Uses mxbai-embed-large-v1 via SentenceTransformers — CPU-efficient, no Ollama dependency.
EMBED_PROVIDER      = os.getenv('EMBED_PROVIDER', 'fastembed')  # 'fastembed' | 'sentence_transformers'
FASTEMBED_MODEL     = os.getenv('FASTEMBED_MODEL', 'mixedbread-ai/mxbai-embed-large-v1')
# Legacy Ollama embed vars — Ollama removed, kept as empty for backward compat
OLLAMA_EMBED_URL    = ''
OLLAMA_EMBED_MODEL  = 'mxbai-embed-large'  # reference only — not used

# --- AI Core & Search Configuration ---
AI_CORE_CHUNK_SIZE = int(os.getenv("AI_CORE_CHUNK_SIZE", 512))
AI_CORE_CHUNK_OVERLAP = int(os.getenv("AI_CORE_CHUNK_OVERLAP", 100))
MAX_TEXT_LENGTH_FOR_NER = int(os.getenv("MAX_TEXT_LENGTH_FOR_NER", 500000))
QDRANT_DEFAULT_SEARCH_K = int(os.getenv("QDRANT_DEFAULT_SEARCH_K", 5))
QDRANT_SEARCH_MIN_RELEVANCE_SCORE = float(os.getenv("QDRANT_SEARCH_MIN_RELEVANCE_SCORE", 0.1))

# --- Hybrid Search (dense + sparse/SPLADE) ---
# Set HYBRID_SEARCH_ENABLED=true to enable BM25-style sparse + dense retrieval with RRF fusion.
# NOTE: Enabling this on an existing collection will trigger a collection recreation.
#       All documents must be re-ingested after enabling for the first time.
HYBRID_SEARCH_ENABLED = os.getenv("HYBRID_SEARCH_ENABLED", "false").lower() == "true"
SPARSE_EMBED_MODEL    = os.getenv("SPARSE_EMBED_MODEL", "prithvida/Splade_PP_en_v1")

# --- SpaCy Configuration ---
SPACY_MODEL_NAME = os.getenv('SPACY_MODEL_NAME', 'en_core_web_sm')

# --- API Port Configuration ---
API_PORT = int(os.getenv('API_PORT', 2001))

# --- Tesseract OCR Path ---
TESSERACT_CMD = os.getenv('TESSERACT_CMD')  # None on Linux; set env var if tesseract is not on PATH

# ─── Course Materials ──────────────────────────────────
# Folder where admin uploads course PDFs, organised as Cpurses/{CourseName}/*.pdf
CPURSES_DIR = os.getenv('CPURSES_DIR', os.path.join(os.path.dirname(__file__), '..', 'Cpurses'))
# STN JSON backup dir — persistent copy so Redis flush doesn't lose notes
STN_BACKUP_DIR = os.getenv('STN_BACKUP_DIR', os.path.join(os.path.dirname(__file__), '..', 'Cpurses', '_stn_backup'))# Dedicated Qdrant collection for STN teaching_context vectors (permanent store beyond Redis TTL)
STN_QDRANT_COLLECTION = os.getenv('STN_QDRANT_COLLECTION', 'stn_notes')
# Dual-layer knowledge pyramid collections
PEDAGOGICAL_QDRANT_COLLECTION = os.getenv('PEDAGOGICAL_QDRANT_COLLECTION', 'pedagogical_notes')
SCHOLARLY_QDRANT_COLLECTION   = os.getenv('SCHOLARLY_QDRANT_COLLECTION',   'scholarly_claims')
# Bootstrap directory — seed courses with syllabus.csv + PDFs, auto-processed on startup
COURSE_BOOTSTRAP_DIR = os.getenv('COURSE_BOOTSTRAP_DIR', os.path.join(os.path.dirname(__file__), '..', 'course_bootstrap'))

# ─── Library Availability Flags & Dynamic Imports ──────────────────────
try:
    import pypdf
    PYPDF_AVAILABLE = True
    PYPDF_PDFREADERROR = pypdf.errors.PdfReadError
except ImportError: PYPDF_AVAILABLE, PYPDF_PDFREADERROR = False, Exception

try:
    from docx import Document as DocxDocument
    DOCX_AVAILABLE = True
except ImportError: DOCX_AVAILABLE, DocxDocument = False, None

try:
    from pptx import Presentation
    PPTX_AVAILABLE = True
except ImportError: PPTX_AVAILABLE, Presentation = False, None

try:
    import pdfplumber
    PDFPLUMBER_AVAILABLE = True
except ImportError: PDFPLUMBER_AVAILABLE, pdfplumber = False, None

try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError: PANDAS_AVAILABLE, pd = False, None

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError: PIL_AVAILABLE, Image = False, None

try:
    import fitz
    FITZ_AVAILABLE = True
except ImportError: FITZ_AVAILABLE, fitz = False, None

try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
    TESSERACT_ERROR = pytesseract.TesseractNotFoundError
    if TESSERACT_CMD: pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
except ImportError: PYTESSERACT_AVAILABLE, pytesseract, TESSERACT_ERROR = False, None, Exception

try:
    import PyPDF2
    PYPDF2_AVAILABLE = True
except ImportError: PYPDF2_AVAILABLE, PyPDF2 = False, None

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    LANGCHAIN_SPLITTER_AVAILABLE = True
except ImportError:
    try:
        from langchain.text_splitter import RecursiveCharacterTextSplitter
        LANGCHAIN_SPLITTER_AVAILABLE = True
    except ImportError:
        LANGCHAIN_SPLITTER_AVAILABLE, RecursiveCharacterTextSplitter = False, None



try:
    import yt_dlp
    YTDLP_AVAILABLE = True
except ImportError:
    YTDLP_AVAILABLE, yt_dlp = False, None
    
# STT: local OpenAI Whisper — no HuggingFace token needed, runs offline, great for Indian English
try:
    import speech_recognition as _sr_check
    SPEECH_RECOGNITION_AVAILABLE = True
except ImportError:
    SPEECH_RECOGNITION_AVAILABLE = False
    logger.warning("SpeechRecognition not installed. STT will be unavailable. Run: pip install SpeechRecognition")

try:
    import whisper as _whisper_check  # openai-whisper
    WHISPER_AVAILABLE = True
    logger.info(f"Whisper STT available (openai-whisper {_whisper_check.__version__})")
except ImportError:
    WHISPER_AVAILABLE = False
    logger.warning("openai-whisper not installed. Whisper STT unavailable. Run: pip install openai-whisper")
    
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE, sync_playwright = False, None
    
try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE, BeautifulSoup = False, None
    
try:
    import ffmpeg
    FFMPEG_PYTHON_AVAILABLE = True
except ImportError:
    FFMPEG_PYTHON_AVAILABLE, ffmpeg = False, None


    
# ─── Lazy Loading Model Getters ───────────────────────
_nlp_spacy_core = None
SPACY_MODEL_LOADED = False

def get_spacy_model():
    global _nlp_spacy_core, SPACY_MODEL_LOADED
    if _nlp_spacy_core is None:
        try:
            import spacy
            _nlp_spacy_core = spacy.load(SPACY_MODEL_NAME)
            SPACY_MODEL_LOADED = True
            logger.info(f"Successfully loaded SpaCy model '{SPACY_MODEL_NAME}'")
        except Exception as e:
            logger.warning(f"Failed to load SpaCy model '{SPACY_MODEL_NAME}': {e}")
            SPACY_MODEL_LOADED = False
    return _nlp_spacy_core

_document_embedding_model = None
EMBEDDING_MODEL_LOADED = False


class FastEmbedder:
    """
    Drop-in replacement for SentenceTransformer / OllamaEmbedder that uses
    fastembed (ONNX-based, CPU-efficient, no Ollama dependency).

    Uses mixedbread-ai/mxbai-embed-large-v1 → 1024-dim, identical output to the
    old Ollama mxbai-embed-large route — Qdrant collections remain compatible.

    Interface mirrors SentenceTransformer.encode() so all callers work unchanged.
    """
    def __init__(self, model_name: str):
        from fastembed import TextEmbedding
        self._model = TextEmbedding(model_name=model_name)
        self._model_name = model_name
        logger.info(f"[FastEmbedder] Initialized → model={model_name}")

    def encode(self, texts, normalize_embeddings: bool = True,
               show_progress_bar: bool = False, **kwargs):
        """
        Encode one string or a list of strings into embedding vectors.

        Returns:
            Single input  → 1-D numpy array  (shape: [dim])
            List input    → 2-D numpy array  (shape: [n, dim])
        """
        import numpy as np

        single_input = isinstance(texts, str)
        input_list   = [texts] if single_input else list(texts)

        # fastembed returns a generator of numpy arrays
        vecs = np.array(list(self._model.embed(input_list)), dtype=np.float32)

        if normalize_embeddings:
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            vecs  = vecs / norms

        return vecs[0] if single_input else vecs


class SparseEmbedder:
    """
    SPLADE-based sparse embedder via fastembed.SparseTextEmbedding.
    Returns (indices, values) pairs suitable for Qdrant SparseVector.
    Used for hybrid dense+sparse retrieval with RRF fusion.
    """
    def __init__(self, model_name: str):
        from fastembed import SparseTextEmbedding
        self._model = SparseTextEmbedding(model_name=model_name)
        self._model_name = model_name
        logger.info(f"[SparseEmbedder] Initialized → model={model_name}")

    def embed(self, text: str):
        """
        Embed a single text string.
        Returns an object with .indices (np.ndarray[int]) and .values (np.ndarray[float]).
        """
        results = list(self._model.embed([text]))
        return results[0]

    def embed_batch(self, texts: list):
        """
        Embed a list of texts.
        Returns a list of objects with .indices and .values.
        """
        return list(self._model.embed(texts))


_sparse_embedding_model = None
SPARSE_EMBEDDING_MODEL_LOADED = False


def get_sparse_embedding_model():
    """
    Lazy-load the sparse (SPLADE) embedding model.
    Returns None if HYBRID_SEARCH_ENABLED is False or if the model fails to load.
    """
    global _sparse_embedding_model, SPARSE_EMBEDDING_MODEL_LOADED
    if not HYBRID_SEARCH_ENABLED:
        return None
    if _sparse_embedding_model is None:
        try:
            _sparse_embedding_model = SparseEmbedder(SPARSE_EMBED_MODEL)
            SPARSE_EMBEDDING_MODEL_LOADED = True
            logger.info(f"[Config] Sparse embedding model loaded: {SPARSE_EMBED_MODEL}")
        except Exception as e:
            logger.warning(f"[Config] SparseEmbedder init failed ({e}). Hybrid search disabled for this session.")
            SPARSE_EMBEDDING_MODEL_LOADED = False
    return _sparse_embedding_model


def get_embedding_model():
    global _document_embedding_model, EMBEDDING_MODEL_LOADED
    if _document_embedding_model is None:
        if EMBED_PROVIDER == 'fastembed':
            try:
                _document_embedding_model = FastEmbedder(FASTEMBED_MODEL)
                EMBEDDING_MODEL_LOADED = True
                logger.info(f"[Config] Embedding provider=fastembed  model={FASTEMBED_MODEL}")
            except Exception as e:
                logger.warning(f"[Config] FastEmbedder init failed: {e}")
                EMBEDDING_MODEL_LOADED = False
        else:
            try:
                from sentence_transformers import SentenceTransformer
                logger.info(f"Loading Sentence Transformer: {DOCUMENT_EMBEDDING_MODEL_NAME}...")
                # Force CPU to avoid competing with SGLang/Ollama for VRAM
                _document_embedding_model = SentenceTransformer(DOCUMENT_EMBEDDING_MODEL_NAME, device='cpu')
                EMBEDDING_MODEL_LOADED = True
                logger.info(f"Successfully loaded embedding model '{DOCUMENT_EMBEDDING_MODEL_NAME}'")
            except Exception as e:
                logger.warning(f"Failed to load Sentence Transformer model '{DOCUMENT_EMBEDDING_MODEL_NAME}': {e}")
                EMBEDDING_MODEL_LOADED = False
    return _document_embedding_model

# For backward compatibility with modules expecting global variables
# Note: These will remain None until the first call to get_*_model()
nlp_spacy_core = None
document_embedding_model = None
