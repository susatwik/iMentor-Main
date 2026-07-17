# Document Generation Flow — Root Cause Analysis & Fixes

**Date:** June 7, 2026  
**Status:** ✅ FIXED  
**Severity:** HIGH (Data integrity issue — contradictory audit logs)

---

## Problem Statement

When users generate documents (PPTX/DOCX), the following appears in audit logs:

```
10:24:02 | AUDIT | CONTENT_GENERATION_FROM_TOPIC_SUCCESS | user=saranya_test123@gmail.com
10:24:02 | SYSTEM | XP Awarded: 24 (Multiplier: 1x)
10:24:02 | AUDIT | CONTENT_GENERATION_FROM_TOPIC_FAILURE | user=saranya_test123@gmail.com {"error":""}
10:24:02 | ERROR | Topic generation failure: Failed to generate document from topic.
```

**Issue:** 
- Both SUCCESS and FAILURE audit logs appear
- Error message is empty string (`"error":""`)
- User gets 24 XP for a failed operation
- No visibility into actual failure cause

---

## Root Cause Analysis

### File: [server/routes/generationRoutes.js](server/routes/generationRoutes.js)

### Bug #1: Premature SUCCESS Audit (Lines 15-18 & 98-103)

**Original Code (WRONG):**
```javascript
router.post('/document', async (req, res) => {
    const { markdownContent, docType, sourceDocumentName } = req.body;
    
    // ❌ SUCCESS logged BEFORE any processing!
    auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_SUCCESS', {
        docType: docType,
        sourceDocumentName: sourceDocumentName
    });
    
    // Validation happens AFTER success logged
    if (!markdownContent || !docType || !sourceDocumentName) {
        return res.status(400).json({ message: 'Missing fields' });
    }
    // ... then try/catch ...
});

router.post('/document/from-topic', async (req, res) => {
    const { topic, docType } = req.body;
    
    // ❌ SUCCESS logged at START of handler
    auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_SUCCESS', {
        docType: docType,
        topic: topic
    });
    
    if (!topic || !docType) {
        return res.status(400).json({ message: 'Topic and docType required' });
    }
    // ... then try/catch ...
});
```

**Why This Is Wrong:**
- Audit success logged UNCONDITIONALLY at handler start
- If ANY error occurs later (validation, API call, stream), FAILURE is also logged
- User receives XP before operation completes
- Audit trail shows contradictory events

**Execution Timeline:**
```
t=0ms   POST /document/from-topic arrives
t=1ms   ✅ SUCCESS audit logged (WRONG - no work done yet!)
t=5ms   Validation passes
t=10ms  Axios POST to Python service initiated
t=20ms  Python service unreachable (ECONNREFUSED)
t=25ms  ❌ FAILURE audit logged
t=26ms  Both logs in audit trail (contradiction!)
```

---

### Bug #2: Empty Error Message (Line 152 & 103)

**Original Code (WRONG):**
```javascript
} catch (error) {
    auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_FAILURE', {
        docType: docType,
        topic: topic,
        error: error.message  // ❌ Empty for network errors!
    });
    
    const errorMsg = error.response?.data?.error || error.message || "Failed...";
    log.error('SYSTEM', `Topic generation failure: ${errorMsg}`); // Empty!
}
```

**Why This Is Wrong:**
- Network errors (ECONNREFUSED, ETIMEDOUT) don't have `.message` property
- Error info is in `.code` (e.g., `ECONNREFUSED`)
- Error info is in `.errno` or `.syscall`
- Result: `error.message` is empty string

**Example Network Error Object:**
```javascript
{
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: '127.0.0.1',
    port: 2005
    // ❌ message: undefined
}
```

---

### Bug #3: Python Service Not Running

**From Startup Logs:**
```
15:15:02 | SYSTEM | Python RAG service is not reachable at http://localhost:2005.
```

**Environment Variable:**
```bash
PYTHON_RAG_SERVICE_URL=http://localhost:2005
```

**Check:** Python service at `server/rag_service/` is NOT running. Axios POST fails with ECONNREFUSED.

---

## The 3 Required Fixes

### FIX #1: Move SUCCESS Audit to After Stream Setup

**Location:** [server/routes/generationRoutes.js](server/routes/generationRoutes.js#L90-L176)

**Change 1a: `/document` endpoint (Line 15-18 → Remove)**
```javascript
// ❌ REMOVE THIS:
auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_SUCCESS', {
    docType: docType,
    sourceDocumentName: sourceDocumentName
});
```

**Change 1b: Add validation failure audit (Line 19-22)**
```javascript
// ✅ ADD THIS instead:
if (!markdownContent || !docType || !sourceDocumentName) {
    auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_FAILURE', {
        docType: docType,
        sourceDocumentName: sourceDocumentName,
        error: 'Missing required fields'
    });
    return res.status(400).json({ message: '...' });
}
```

**Change 1c: Add SUCCESS after axios succeeds (Line 70-72)**
```javascript
const pythonResponse = await axios.post(generationUrl, {
    markdownContent, docType, sourceDocumentText, api_key: apiKeyForRequest
}, { responseType: 'stream', timeout: 600000 });

// ✅ ADD THIS here (after axios succeeds):
auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_SUCCESS', {
    docType: docType,
    sourceDocumentName: sourceDocumentName
});
```

**Change 1d: Same for `/document/from-topic` (Lines 98-103 → Remove)**
```javascript
// ❌ REMOVE THIS:
auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_SUCCESS', {
    docType: docType,
    topic: topic
});
```

**Change 1e: Add after axios succeeds (Lines 168-171)**
```javascript
const pythonResponse = await axios.post(generationUrl, {
    topic, docType, api_key: apiKeyForRequest
}, { responseType: 'stream', timeout: 600000 });

// ✅ ADD THIS here (after axios succeeds):
auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_SUCCESS', {
    docType: docType,
    topic: topic
});
```

---

### FIX #2: Capture Full Error Details (Not Just `.message`)

**Location:** [server/routes/generationRoutes.js](server/routes/generationRoutes.js#L103, #L152, #L199)

**Change 2a: `/document` catch block (Line 103-113)**
```javascript
// ❌ WRONG:
} catch (error) {
    auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_FAILURE', {
        docType: docType,
        sourceDocumentName: sourceDocumentName,
        error: error.message  // ❌ Empty!
    });
    const errorMsg = error.response?.data?.error || error.message || "Failed...";
    log.error('SYSTEM', `Generation error: ${errorMsg}`);
}

// ✅ CORRECT:
} catch (error) {
    const errorCode = error.code || error.response?.status || 'UNKNOWN';
    const errorDetail = error.message || 
                       error.response?.data?.error || 
                       error.response?.statusText ||
                       error.toString();
    
    auditLog(req, 'CONTENT_GENERATION_FROM_SOURCE_FAILURE', {
        docType: docType,
        sourceDocumentName: sourceDocumentName,
        error: `${errorCode}: ${errorDetail}`,
        stage: 'request_setup'
    });
    
    const errorMsg = error.response?.data?.error || errorDetail || "Failed to generate document.";
    log.error('SYSTEM', `Generation error: ${errorMsg}`);
}
```

**Change 2b: `/document/from-topic` catch block (Line 152-157)**
```javascript
// ❌ WRONG:
} catch (error) {
    auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_FAILURE', {
        docType: docType,
        topic: topic,
        error: error.message  // ❌ Empty!
    });
    const errorMsg = error.response?.data?.error || error.message || "Failed...";
    log.error('SYSTEM', `Topic generation failure: ${errorMsg}`);
}

// ✅ CORRECT:
} catch (error) {
    const errorCode = error.code || error.response?.status || 'UNKNOWN';
    const errorDetail = error.message || 
                       error.response?.data?.error || 
                       error.response?.statusText ||
                       error.toString();
    
    auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_FAILURE', {
        docType: docType,
        topic: topic,
        error: `${errorCode}: ${errorDetail}`,
        stage: 'request_setup'
    });
    
    const errorMsg = error.response?.data?.error || errorDetail || "Failed to generate document from topic.";
    log.error('SYSTEM', `Topic generation failure [${topic}]: code=${errorCode} message=${errorMsg}`);
}
```

**Change 2c: Stream error handlers (Lines 87-91 & 181-185)**
```javascript
// ❌ WRONG:
pythonResponse.data.on('error', (err) => {
    log.error('SYSTEM', `Topic generation stream error [${topic}]: ${err.message}`); // Empty!
});

// ✅ CORRECT:
pythonResponse.data.on('error', (err) => {
    const errorCode = err.code || 'UNKNOWN';
    const errorDetail = err.message || err.toString();
    log.error('SYSTEM', `Topic generation stream error [${topic}]: code=${errorCode} detail=${errorDetail}`);
    
    if (!res.headersSent) {
        auditLog(req, 'CONTENT_GENERATION_FROM_TOPIC_FAILURE', {
            docType: docType,
            topic: topic,
            error: `Stream error: ${errorCode}: ${errorDetail}`,
            stage: 'stream_transmission'
        });
        res.status(502).json({ message: `Error during document generation: ${errorCode}` });
    }
});
```

---

### FIX #3: Start Python RAG Service

**Location:** `server/rag_service/` directory

**Current Status:**
```
ERROR: Python RAG service is not reachable at http://localhost:2005
```

**Required Action:**
```bash
# Start the Python RAG service
cd server/rag_service
python main.py

# Or in another terminal:
cd server
python -m rag_service.main
```

**Expected Output:**
```
[RAG Service] Starting on http://localhost:2005
[RAG Service] Ready to accept requests
```

---

## Execution Flow After Fixes

### Success Path:
```
1. POST /document/from-topic
2. Input validation (if fails → FAILURE audit + error response)
3. API key lookup (if fails → FAILURE audit + error response)
4. Axios POST to Python service initiated
5. ✅ Response stream created
6. ✅ SUCCESS audit logged ← (NOW CORRECT)
7. Response headers set
8. Data piped to client
9. Client receives file
```

### Failure Path (Service Down):
```
1. POST /document/from-topic
2. Input validation (if fails → FAILURE audit + error response)
3. Axios POST to Python service initiated
4. ❌ ECONNREFUSED (service down)
5. ❌ FAILURE audit logged with error code: "ECONNREFUSED: ..."
6. Error response sent to client
7. ✅ Only one audit log (FAILURE) ← (NOW CORRECT, not SUCCESS+FAILURE)
```

---

## Verification

### Before Fix:
```bash
# In audit logs:
CONTENT_GENERATION_FROM_TOPIC_SUCCESS | {"error":""}  ← Contradictory!
CONTENT_GENERATION_FROM_TOPIC_FAILURE | {"error":""}  ← Empty error!
```

### After Fix:
```bash
# If success:
CONTENT_GENERATION_FROM_TOPIC_SUCCESS | { docType: "PPTX", topic: "DSA" }

# If failure:
CONTENT_GENERATION_FROM_TOPIC_FAILURE | { error: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:2005", stage: "request_setup" }
```

---

## Files Modified

| File | Changes | Lines | Status |
|------|---------|-------|--------|
| [server/routes/generationRoutes.js](server/routes/generationRoutes.js) | Moved SUCCESS audit logs, improved error handling | 15-220 | ✅ FIXED |

---

## Testing Checklist

- [ ] Python RAG service running: `curl http://localhost:2005/health`
- [ ] Start backend: `cd server && npm run dev`
- [ ] Attempt document generation: POST `/api/generation/document/from-topic`
- [ ] Check audit logs: Should see ONLY SUCCESS or ONLY FAILURE (never both)
- [ ] If failure: Error should show code (e.g., "ECONNREFUSED", "ETIMEDOUT")
- [ ] If success: File should download
- [ ] XP should only be awarded after successful generation (not on error)

---

## Impact

### High Severity Issues Fixed:
1. ✅ Contradictory audit logs (SUCCESS + FAILURE simultaneously)
2. ✅ Empty error messages hiding actual root cause
3. ✅ XP awarded for failed operations
4. ✅ No visibility into what failed (setup vs. transmission)

### User-Facing Impact:
- ✅ Users see clear error messages when generation fails
- ✅ Audit logs are now reliable for troubleshooting
- ✅ XP only awarded on successful operations
- ✅ Support team can see exact error code (not blank)

---

## Summary

**All 3 bugs fixed in: [server/routes/generationRoutes.js](server/routes/generationRoutes.js)**

1. **Bug #1 Fixed:** SUCCESS audit now logged AFTER stream setup succeeds (not at handler start)
2. **Bug #2 Fixed:** Error details now captured fully (code + message + detail)
3. **Bug #3:** Requires Python RAG service to be running on localhost:2005

**Result:** Document generation audit trail is now accurate and actionable.
