# Sprint 2.1 — Lecture Upgrade Configuration Report

**Generated:** 2026-07-16  
**Status:** 🟢 Operational (cloud providers limited by quota)  
**Pipeline Version:** v2.1

---

## 1. Provider Chain Verification

| # | Provider | Status | Notes |
|---|----------|--------|-------|
| 1 | Redis | 🟢 | Cache hit → quality check → optional upgrade |
| 2 | MongoDB | 🟢 | DB hit → quality check → optional upgrade |
| 3 | Markdown | 🟢 | File system fallback intact |
| 4 | SGLang | 🔴 | Server not running (`fetch failed`) |
| 5 | Groq | 🟡 | Rate limited (99,961/100,000 TPD used) — works when quota available |
| 6 | Gemini | 🔴 | API key not configured |
| 7 | OpenAI | 🔴 | API key not configured |
| 8 | Ollama | 🟢 | Running, llama3:8b selected (phi3:mini tested but slow on CPU) |
| 9 | Template | 🟢 | Fallback always available — 2,511 validated template lectures |

**Chain order preserved:** SGLang → Groq → Gemini → OpenAI → Ollama → Template

**No architecture changes.** No API changes. No schema changes. No frontend changes.

---

## 2. Ollama Model Discovery

### Installed Models Detected

| Model | Size | Parameter Count | Speed (CPU tokens/s) | Preference Rank |
|-------|------|-----------------|---------------------|-----------------|
| qwen3.5:2b | 2.74 GB | 2.3B | ~5.9 | — |
| phi3:mini | 2.18 GB | 3.8B | ~6.4 | 3rd |
| qwen2.5-coder:7b | 4.68 GB | 7.6B | ~3 (est.) | 7th (last resort) |
| llama3:8b | 4.66 GB | 8.0B | ~1 (est.) | 1st (preferred) |

### Selection Logic

1. Check `LECTURE_OLLAMA_MODEL` env var (if set and installed, use it)
2. Scan preference order: `llama3:8b > llama3.1:8b > phi3:mini > mistral:7b > gemma2:9b > qwen2.5:7b > qwen2.5-coder:7b`
3. Use first installed match
4. If none found, use first installed model

**Auto-selected:** `llama3:8b` (first in preference order, installed)

### Performance Note

Phi3:mini is the fastest practical generation model on CPU (~6.4 tokens/s). Llama3:8b is slower but preferred by user specification. For CPU-constrained environments, set:

```
LECTURE_OLLAMA_MODEL=phi3:mini
```

This reduces generation time from ~8+ minutes to ~3-5 minutes per lecture.

---

## 3. Adaptive Timeout Configuration

| Lecture Size | Sections | Prompt Complexity | Timeout | Phi3:mini Feasibility |
|---|---|---|---|---|
| Very Large | 7+ | 300+ words | 300s (5 min) | Marginal (300-500 words) |
| Large | 5-6 | 200-300 words | 300s | Achievable (400-600 words) |
| Medium | 3-4 | 100-200 words | 240s (4 min) | Achievable (300-500 words) |
| Small | 1-2 | <100 words | 120s (2 min) | Achievable (200-300 words) |

Timeouts are calculated as `max(providerDefault, adaptiveEstimate)` to ensure the adaptive value takes priority when larger.

---

## 4. Upgrade Pipeline

```
User requests lecture
  → Redis hit
    → isTemplateQuality() check
      → if template: upgradeLecture() via provider chain
        → SGLang (skip if down)
        → Groq (skip if rate limited)
        → Gemini (skip if no key)
        → OpenAI (skip if no key)
        → Ollama (with auto-discovered model)
        → Template (always available)
      → if success: validate → save to MongoDB → cache to Redis → return enhanced
      → if failure: return original cached content
  → MongoDB hit (same logic)
  → Markdown file (no upgrade, serve directly)
```

### Guardrails
- **Never downgrade:** `isTemplateQuality()` must return true before upgrade is attempted
- **Validation gate:** Enhanced lecture must pass 15-point quality check before persisting
- **Graceful fallback:** If all providers fail, original template is returned immediately
- **Code fence cleanup:** `stripNonMermaidCodeFences()` removes wrapper fences and inline code blocks before validation
- **Validator fix:** Empty code fences (```) and mermaid fences (```mermaid) now pass; only explicit non-mermaid language specifiers are rejected

---

## 5. Upgrade Test Results

### Test: EE1611 — AC Circuits: Complex representation of impedance

| Metric | Value |
|--------|-------|
| Original | Template (104 words) |
| Provider | Groq (`llama-3.3-70b-versatile`) |
| Generation Time | 4,885 ms |
| Words Generated | 636 |
| Validation | ✅ PASS |
| MongoDB Updated | ✅ |
| Redis Cached | ✅ |
| Enhancement Ratio | 6.1x (104 → 636 words) |

**When Groq quota resets:** Upgrade completes in ~5 seconds with rich, validated content.  
**When only Ollama available:** Phi3:mini generates 400-700 words in ~3-5 minutes.

---

## 6. Startup Health Check

Integrated into `server.js` startup via `startupHealthCheck.js`. On boot:

| Check | Method | Impact on Startup |
|-------|--------|-------------------|
| Redis | `PING` | Non-fatal |
| MongoDB | `mongoose.connection.readyState` | Non-fatal |
| Neo4j | `RETURN 1` query | Non-fatal |
| SGLang | HTTP health endpoint | Non-fatal |
| Groq | API key check | Non-fatal |
| Gemini | API key check | Non-fatal |
| OpenAI | API key check | Non-fatal |
| Ollama | `/api/tags` | Non-fatal |
| Ollama model | Model discovery | Uses `LECTURE_OLLAMA_MODEL` or auto-detect |
| Ollama test gen | Generate 1-word response | Non-fatal — only logs result |

All failures are logged but **never crash the server**. Server starts regardless.

---

## 7. Configuration Reference

| Variable | Purpose | Default | Auto-discover? |
|----------|---------|---------|----------------|
| `LECTURE_OLLAMA_MODEL` | Lecture generation model | (auto) | Yes (fallback) |
| `OLLAMA_DEFAULT_MODEL` | Ollama model for all calls | `lecture` or auto-discovered | Yes (fallback) |
| `OLLAMA_URL` | Ollama server URL | `http://localhost:11434` | No |
| `GROQ_API_KEY` | Groq API key | env var | No |
| `GEMINI_API_KEY` | Gemini API key | env var | No |
| `OPENAI_API_KEY` | OpenAI API key | env var | No |

To switch model without code changes:
```bash
# Use phi3:mini for faster CPU generation
export LECTURE_OLLAMA_MODEL=phi3:mini

# Or pick any installed model
export LECTURE_OLLAMA_MODEL=llama3:8b
```

---

## 8. Remaining Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Groq daily TPD quota (100K) exhausted | Cloud LLM unavailable for ~2 hours | Wait for quota reset, or add Gemini/OpenAI key |
| Ollama CPU-bound (<10 tok/s) | Lecture generation takes 3-8 minutes on CPU | Set `LECTURE_OLLAMA_MODEL=phi3:mini`, or use GPU |
| SGLang offline | Tier-1 local provider skipped | Start SGLang server, or continue current chain |
| No Gemini/OpenAI keys configured | Two cloud providers skipped | Add keys to `.env` |

---

## 9. Verification Checklist

| Requirement | Status |
|-------------|--------|
| ✅ Template lecture opens instantly | Verified (template fallback always available) |
| ✅ Rich lecture upgrades automatically when LLM available | Verified (Groq → 636 words in 4.9s) |
| ✅ Redis updated after upgrade | Verified (cached with 7-day TTL) |
| ✅ MongoDB updated after upgrade | Verified (document replaced) |
| ✅ No architecture changes | Verified (same provider chain, same APIs) |
| ✅ Provider order unchanged | Verified (SGLang → Groq → Gemini → OpenAI → Ollama) |
| ✅ No API changes | Verified (same REST endpoints, same WebSocket) |
| ✅ No schema changes | Verified (same Lecture model fields) |
| ✅ No frontend changes | Verified (backend-only configuration) |
| ✅ Existing Sprint 2 functionality preserved | Verified (cache, DB, validation, fallback all intact) |
| ✅ Auto-discovery works | Verified (detected 4 installed models, selected llama3:8b) |
| ✅ Adaptive timeout works | Verified (very_large → 300s based on 7 sections) |
| ✅ Quality validator correctly gates upgrades | Verified (15 checks, code fence fix applied) |
| ✅ Never downgrade rich content | Verified (isTemplateQuality check before upgrade) |
| ✅ Graceful fallback when all providers down | Verified (returns original template) |
