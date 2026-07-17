# iMentor Application — Complete Authentication & Email Configuration Diagnostic Report

**Generated:** May 30, 2026  
**Project:** iMentor AI Tutor (Full Stack)  
**Diagnosis Scope:** Authentication Flow, OTP Email Verification, Environment Configuration, Startup Issues

---

## SECTION A: Current Authentication Architecture

### A.1 Authentication Layers

#### Frontend (React + Vite)
- **Location:** `frontend/src/components/auth/AuthModal.jsx`, `frontend/src/contexts/AuthContext.jsx`
- **Authentication Type:** JWT token-based
- **Signup Flow:**
  1. User enters email & password (Step 1)
  2. Frontend calls `POST /api/auth/send-otp` → Backend sends OTP email
  3. Frontend displays OTP input field → User receives code in email
  4. User enters OTP (6 digits) → Frontend calls `POST /api/auth/verify-otp` for validation
  5. User enters profile details (Step 2-3) → College, degree, branch, learning style
  6. Frontend calls `POST /api/auth/signup` with all data + validated OTP
  7. Backend creates User document and returns JWT token
  8. Frontend stores token in localStorage, redirects to dashboard

#### Backend (Node.js Express)
- **Location:** `server/routes/auth.js`
- **Email Service:** `server/services/emailService.js`
- **Models:** `server/models/User.js`, `server/models/PendingRegistration.js`
- **Startup Check:** `server/server.js` (line ~140) calls `await checkEmailCredentials()`

#### Key Features:
- **Brute Force Protection:** Redis-based counter for OTP verification (max 5 attempts, 15-min lockout)
- **OTP Expiration:** 10 minutes
- **OTP Hashing:** bcrypt before storage
- **Development Mode:** `EMAIL_VERIFICATION_REQUIRED=false` skips email requirement
- **Graceful Degradation:** Redis fallback to in-memory cache if unavailable

---

## SECTION B: Current OTP Flow

### B.1 OTP Generation & Storage

**Signup Flow (Step 1):**
```
POST /api/auth/send-otp
├─ Input: { email, password }
├─ Check: Email not already registered
├─ Check: Password >= 6 characters
├─ Check: Email service configured (unless DEV mode)
├─ Generate: 6-digit OTP (uppercase=false, specialChars=false)
├─ Store: PendingRegistration collection
│  ├─ hashedOtp (bcrypt)
│  ├─ hashedPassword (bcrypt)
│  ├─ otpExpires (Date, +10 min)
│  └─ TTL index: auto-delete after 15 minutes
└─ Send: HTML email via Nodemailer
```

**OTP Verification (Step 1.5):**
```
POST /api/auth/verify-otp
├─ Input: { email, otp }
├─ Lookup: PendingRegistration by email
├─ Brute Force Check: Redis counter <= 5 attempts
├─ Validation: bcrypt.compare(otp, hashedOtp)
├─ Expiry Check: otpExpires > now()
├─ Success: Response { valid: true }
└─ Failure: Response { valid: false } OR 429 (too many attempts)
```

**Signup Finalization (Step 2-3):**
```
POST /api/auth/signup
├─ Input: { email, otp, name, college, degreeType, branch, year, learningStyle, preferredLlmProvider }
├─ Lookup: PendingRegistration by email
├─ Re-validate: OTP (bcrypt compare again)
├─ Check: All profile fields present
├─ Create: User document (hashed password, profile)
├─ Delete: PendingRegistration (cleanup)
├─ Generate: JWT token
└─ Return: { token, _id, email, username, hasCompletedOnboarding }
```

### B.2 Password Reset OTP Flow

```
POST /api/auth/forgot-password
├─ Input: { email }
├─ Lookup: User by email
├─ Generate: 6-digit OTP
├─ Store: User.otp (hashed), User.otpExpires
├─ Send: Password reset email (HTML)
└─ Return: Generic success message (email enumeration prevention)

POST /api/auth/verify-forgot-otp
├─ Input: { email, otp }
├─ Validate: OTP (bcrypt compare)
└─ Return: { valid: true/false }

POST /api/auth/reset-password
├─ Input: { email, otp, newPassword }
├─ Validate: OTP verified
├─ Hash: New password (bcrypt)
├─ Update: User.password, unset User.otp
└─ Return: Success message
```

---

## SECTION C: Root Cause Analysis of Email Verification Failure

### C.1 Error Message
```
ERROR: "OTP send blocked: email verification service not configured"
HTTP Status: 503 Service Unavailable
```

### C.2 Root Cause

**The error occurs in `POST /api/auth/send-otp` (line 155-163 in auth.js):**

```javascript
const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && isEmailServiceConfigured());
if (!emailConfigured) {
    log.error('AUTH', 'OTP send blocked: email verification service not configured');
    return res.status(503).json({
        success: false,
        message: 'Email verification service not configured'
    });
}
```

**This check fails when:**

1. **Missing .env file** → No `process.env.EMAIL_USER` or `process.env.EMAIL_PASS`
2. **Placeholder values in .env** → Values like `"your_email@gmail.com"` or `"your_app_password"` (not set to real credentials)
3. **Email service not verified at startup** → `isEmailServiceConfigured()` returns false (Nodemailer `transporter.verify()` failed)
4. **EMAIL_VERIFICATION_REQUIRED not set to false** → Default is true (production mode)

### C.3 Email Service Initialization (Startup)

**In `server/server.js` (line ~140):**
```javascript
await checkEmailCredentials();
```

**Implementation in `server/services/emailService.js` (lines 20-35):**
```javascript
const checkEmailCredentials = async () => {
    // Check if essential .env variables are missing or are still placeholders
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || 
        process.env.EMAIL_USER === 'your-email@gmail.com' || 
        process.env.EMAIL_PASS === 'your-app-password') {
        log.warn('AUTH', "Email credentials not configured. OTP disabled.");
        isEmailServiceReady = false;
        return;
    }
    try {
        await transporter.verify();
        log.info('AUTH', "Email service ready");
        isEmailServiceReady = true;
    } catch (error) {
        log.error('AUTH', `Email verification failed: ${error.message}`);
        isEmailServiceReady = false;
    }
};
```

**Failure points:**
1. **Missing or placeholder variables** → `isEmailServiceReady = false`
2. **Transporter.verify() fails** → Nodemailer connection test fails (invalid credentials, network issues, etc.)
3. **Global flag not set** → All subsequent email operations throw "Email service is not configured"

### C.4 Complete Failure Chain

```
No .env file
    ↓
process.env.EMAIL_* = undefined
    ↓
checkEmailCredentials() runs, sets isEmailServiceReady = false
    ↓
User attempts signup → POST /api/auth/send-otp
    ↓
emailConfigured = false (EMAIL_USER undefined)
    ↓
Response: 503 "Email verification service not configured"
    ↓
Frontend signup blocked
```

---

## SECTION D: Files Requiring Changes

### D.1 Configuration Files

| File | Status | Issue | Fix |
|------|--------|-------|-----|
| `server/.env` | ❌ Missing | Does not exist | Create from .env.example |
| `server/.env.example` | ✅ Present | Reference only | Used as template |
| `frontend/.env` | ❌ Missing | Not required for dev | Optional |

### D.2 Backend Source Files

| File | Lines | Issue | Type |
|------|-------|-------|------|
| `server/routes/auth.js` | 15 | EMAIL_VERIFICATION_REQUIRED default is true | Config logic |
| `server/routes/auth.js` | 155-163 | Email service check blocks signup | Blocking condition |
| `server/services/emailService.js` | 1-35 | Transporter initialization | SMTP setup |
| `server/server.js` | ~140 | Email credentials check | Startup sequence |

### D.3 Frontend Source Files

| File | Issue | Status |
|------|-------|--------|
| `frontend/src/components/auth/AuthModal.jsx` | Uses `/api/auth/send-otp` endpoint | ✅ No changes needed |
| `frontend/src/services/api.js` | Provides `sendOtp()` method | ✅ No changes needed |

### D.4 Environment & Dependency Files

| File | Status | Note |
|------|--------|------|
| `server/package.json` | ✅ Present | Includes nodemailer & bcryptjs |
| `docker-compose.yml` | ✅ Present | Includes MongoDB, Redis (no email service) |

---

## SECTION E: Exact Code Changes Required

### E.1 Create `.env` File for Server

**File:** `server/.env`  
**Action:** Create from template with development mode settings

**Content:**
```bash
# ─── Application ────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=5001

# ─── Security (generate with: openssl rand -hex 32) ────────────────────────
JWT_SECRET=your_jwt_secret_dev_only_change_in_production
JWT_EXPIRATION=7d
ENCRYPTION_SECRET=your_32_char_hex_encryption_secret_dev_only

# ─── Database: MongoDB ──────────────────────────────────────────────────────
MONGO_URI=mongodb://localhost:27017/imentor

# ─── Database: Redis ────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_PORT=6379

# ─── Database: Neo4j (Knowledge Graph) ──────────────────────────────────────
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password

# ─── Database: Qdrant (Vector Store) ────────────────────────────────────────
QDRANT_URL=http://localhost:6333
QDRANT_PORT=6333

# ─── Database: Elasticsearch ────────────────────────────────────────────────
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_PORT=9200

# ─── Python RAG Microservice ───────────────────────────────────────────────
PYTHON_RAG_SERVICE_URL=http://localhost:2001
RAG_PORT=2001

# ─── SGLang (OpenAI-compatible local LLM) ───────────────────────────────────
SGLANG_ENABLED=true
SGLANG_CHAT_URL=http://localhost:8000/v1
SGLANG_REASON_URL=http://localhost:8000/v1
SGLANG_HEAVY_URL=http://localhost:8000/v1
SGLANG_CHAT_MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ
SGLANG_REASON_MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ
SGLANG_HEAVY_MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ
GPU_TOTAL_VRAM_GB=16

# ─── Frontend Origin (CORS) ─────────────────────────────────────────────────
FRONTEND_URL=http://localhost:5173

# ─── LLM Provider API Keys ──────────────────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
CLAUDE_API_KEY=your_claude_api_key
MISTRAL_API_KEY=your_mistral_api_key

# ─── Email / SMTP (DEVELOPMENT MODE) ────────────────────────────────────────
# FOR DEVELOPMENT: Set EMAIL_VERIFICATION_REQUIRED=false to skip SMTP setup
# Set real Gmail credentials if you want to test email sending
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM=iMentor <your_email@gmail.com>

# ─── Authentication: Development Mode ───────────────────────────────────────
# ✅ SET THIS TO 'false' FOR DEVELOPMENT (removes email requirement)
EMAIL_VERIFICATION_REQUIRED=false

# When EMAIL_VERIFICATION_REQUIRED=false:
#   - Signup skips actual OTP email sending
#   - Users can complete signup with OTP "123456"
#   - Email service is not required or checked
#   - Development is faster without SMTP setup

# ─── Admin Bootstrap ────────────────────────────────────────────────────────
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your_secure_admin_password
ADMIN_SETUP_KEY=your_admin_setup_key

# ─── Monitoring ────────────────────────────────────────────────────────────
SENTRY_DSN=
```

### E.2 Add Environment Variable Validation Logging

**File:** `server/routes/auth.js`  
**Location:** At the top, after imports (around line 16)  
**Action:** Add debug logging

**Add after line 15:**
```javascript
// Development mode flag: skip email verification requirement
const EMAIL_VERIFICATION_REQUIRED = process.env.EMAIL_VERIFICATION_REQUIRED !== 'false';

// Log environment status on startup (add this)
if (process.env.NODE_ENV === 'development') {
    log.info('AUTH', `[STARTUP] EMAIL_VERIFICATION_REQUIRED=${EMAIL_VERIFICATION_REQUIRED}`);
    log.info('AUTH', `[STARTUP] EMAIL_USER configured=${!!process.env.EMAIL_USER}`);
    log.info('AUTH', `[STARTUP] EMAIL_PASS configured=${!!process.env.EMAIL_PASS}`);
}
```

### E.3 Enhance Email Service Debug Logging

**File:** `server/services/emailService.js`  
**Location:** `checkEmailCredentials()` function  
**Action:** Add detailed logging

**Replace lines 20-35 with:**
```javascript
const checkEmailCredentials = async () => {
    // Check if essential .env variables are missing or are still placeholders
    const hasUser = !!process.env.EMAIL_USER;
    const hasPass = !!process.env.EMAIL_PASS;
    const isPlaceholder = process.env.EMAIL_USER === 'your-email@gmail.com' || 
                          process.env.EMAIL_PASS === 'your-app-password';
    
    if (process.env.NODE_ENV === 'development') {
        log.info('AUTH', '[EMAIL SERVICE DEBUG]');
        log.info('AUTH', `  EMAIL_USER: ${hasUser ? '✓ configured' : '✗ missing'}`);
        log.info('AUTH', `  EMAIL_PASS: ${hasPass ? '✓ configured' : '✗ missing'}`);
        log.info('AUTH', `  Placeholder values: ${isPlaceholder ? 'yes (skipping)' : 'no'}`);
        log.info('AUTH', `  EMAIL_VERIFICATION_REQUIRED: ${process.env.EMAIL_VERIFICATION_REQUIRED}`);
    }
    
    if (!hasUser || !hasPass || isPlaceholder) {
        log.warn('AUTH', "Email credentials not configured. OTP disabled.");
        isEmailServiceReady = false;
        return;
    }
    
    try {
        await transporter.verify();
        log.success('AUTH', "Email service ready");
        isEmailServiceReady = true;
    } catch (error) {
        log.error('AUTH', `Email verification failed: ${error.message}`);
        if (process.env.NODE_ENV === 'development') {
            log.error('AUTH', 'Continuing in development mode (email service optional)');
        }
        isEmailServiceReady = false;
    }
};
```

### E.4 Improve Error Messages in Signup Endpoint

**File:** `server/routes/auth.js`  
**Location:** `/send-otp` route, lines 155-163  
**Action:** Add more informative error message

**Replace:**
```javascript
const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && isEmailServiceConfigured());
if (!emailConfigured) {
    log.error('AUTH', 'OTP send blocked: email verification service not configured');
    return res.status(503).json({
        success: false,
        message: 'Email verification service not configured'
    });
}
```

**With:**
```javascript
const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && isEmailServiceConfigured());
if (!emailConfigured) {
    const reason = !process.env.EMAIL_USER ? 'EMAIL_USER not set' :
                   !process.env.EMAIL_PASS ? 'EMAIL_PASS not set' :
                   'Email service verification failed';
    log.error('AUTH', `OTP send blocked: ${reason}`);
    
    // In development mode with EMAIL_VERIFICATION_REQUIRED=false, continue
    if (process.env.EMAIL_VERIFICATION_REQUIRED === 'false') {
        log.warn('AUTH', 'Development mode: proceeding without email service');
    } else {
        return res.status(503).json({
            success: false,
            message: 'Email verification service not configured. Set EMAIL_VERIFICATION_REQUIRED=false for development.'
        });
    }
}
```

### E.5 Add Frontend Development Mode Notification

**File:** `frontend/src/components/auth/AuthModal.jsx`  
**Location:** After OTP is sent (around line 102)  
**Action:** Show dev mode message

**Add after successful OTP response:**
```javascript
if (response.devMode) {
    toast.info('🔧 Development Mode: Use OTP "123456"', { duration: 5000 });
    log.debug('[AUTH] Dev mode enabled - using test OTP');
}
```

---

## SECTION F: Environment Variables Required

### F.1 Critical Variables (Must Be Set)

| Variable | Format | Example | Purpose | Dev Value |
|----------|--------|---------|---------|-----------|
| `NODE_ENV` | string | development | Node environment | `development` |
| `PORT` | number | 5001 | Express server port | `5001` |
| `JWT_SECRET` | hex string | a1b2c3d4... (32 chars) | JWT signing key | Any 32+ char string |
| `ENCRYPTION_SECRET` | hex string | e5f6g7h8... (32 chars) | Data encryption | Any 32+ char string |
| `MONGO_URI` | connection string | mongodb://localhost:27017/imentor | MongoDB connection | `mongodb://localhost:27017/imentor` |
| `REDIS_URL` | connection string | redis://localhost:6379 | Redis cache | `redis://localhost:6379` |

### F.2 Email Configuration Variables

| Variable | Format | Example | Purpose | Dev Value |
|----------|--------|---------|---------|-----------|
| `EMAIL_HOST` | hostname | smtp.gmail.com | SMTP server | `smtp.gmail.com` |
| `EMAIL_PORT` | number | 587 | SMTP port | `587` |
| `EMAIL_USER` | email | your_email@gmail.com | Gmail address | Any valid email |
| `EMAIL_PASS` | string | your_app_password | Gmail App Password | Leave blank |
| `EMAIL_FROM` | email string | iMentor <your_email@gmail.com> | From field | Can be dummy |
| `EMAIL_VERIFICATION_REQUIRED` | boolean string | false | Skip email in dev | **`false` for dev** |

### F.3 Optional Variables (Non-Critical)

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEO4J_URI` | bolt://localhost:7687 | Knowledge graph DB |
| `NEO4J_USER` | neo4j | Neo4j username |
| `NEO4J_PASSWORD` | password | Neo4j password |
| `QDRANT_URL` | http://localhost:6333 | Vector database |
| `ELASTICSEARCH_URL` | http://localhost:9200 | Search engine |
| `SGLANG_ENABLED` | true | LLM inference |
| `PYTHON_RAG_SERVICE_URL` | http://localhost:2001 | RAG service |

### F.4 Gmail App Password Setup (For Real Email)

If you want to test with real Gmail:

1. **Enable 2-Step Verification** on your Google Account
2. **Go to:** https://myaccount.google.com/apppasswords
3. **Select:** Mail, Windows Computer (or your OS)
4. **Get 16-character password** (remove spaces)
5. **In .env:** Set `EMAIL_PASS=your_16_char_password`
6. **In .env:** Set `EMAIL_USER=your_email@gmail.com`
7. **Optional:** Set `EMAIL_VERIFICATION_REQUIRED=true`

---

## SECTION G: Commands to Run

### G.1 Prerequisites

```bash
# Ensure you're in the project root
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main

# Verify Node.js version (should be 20+)
node --version
npm --version

# Verify project structure
ls -la server/
ls -la frontend/
```

### G.2 Setup Backend

```bash
# Navigate to server directory
cd server

# Install dependencies (if not already done)
npm install

# Create .env file from template
cp .env.example .env

# Edit .env to set development values (see SECTION F)
# CRITICAL: Set EMAIL_VERIFICATION_REQUIRED=false
nano .env
  # OR
code .env  # VS Code

# Verify .env was created
cat .env | grep "EMAIL_VERIFICATION_REQUIRED"
# Should output: EMAIL_VERIFICATION_REQUIRED=false
```

### G.3 Start Backend Services

```bash
# Option A: Using Docker Compose (Recommended)
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main
docker-compose up -d

# Wait 30 seconds for services to start
sleep 30

# Check service health
docker-compose ps
# Should show: mongo, redis, neo4j, qdrant, elasticsearch running

# Option B: Using local services (if Docker not available)
# Start MongoDB, Redis, Neo4j, Qdrant manually
# Then continue to backend startup

# Start Node.js backend server
cd server
npm run dev
# Or use: node server.js

# Expected output:
# Server listening on port 5001
# Connected to MongoDB: mongodb://localhost:27017/imentor
# Email service ready: ✓
# Redis client connected
```

### G.4 Start Frontend

```bash
# In a new terminal, navigate to frontend
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main/frontend

# Install dependencies (if not already done)
npm install

# Start development server
npm run dev

# Expected output:
# VITE v... ready in ... ms
# ➜  Local:   http://localhost:5173/
# ➜  press h to show help
```

### G.5 Access Application

```bash
# Open browser
http://localhost:5173

# Or direct frontend link
http://localhost:5173/

# Navigate to Sign Up
# Should see: "Create Your Account" modal
```

### G.6 Verify Services Running

```bash
# Backend health check
curl http://localhost:5001/health
# Expected: { "status": "ok", "timestamp": "..." }

# Frontend running
curl http://localhost:5173/
# Should return HTML page

# MongoDB check
mongosh "mongodb://localhost:27017"
# Type: show dbs
# Type: exit

# Redis check
redis-cli ping
# Expected: PONG
```

---

## SECTION H: Testing Procedure

### H.1 Happy Path — Development Signup

**Test:** Complete signup with development mode (EMAIL_VERIFICATION_REQUIRED=false)

**Steps:**

1. **Start all services** (see SECTION G.3-G.4)

2. **Navigate to signup**
   ```
   Open http://localhost:5173
   Click "Sign Up" button
   ```

3. **Enter credentials**
   ```
   Email: test.user@example.com
   Password: SecurePass123
   ```

4. **Click "Send Verification Code"**
   ```
   Expected: Success toast "Verification OTP sent to your email"
   In dev mode: Also shows "Development Mode: Use OTP '123456'"
   Backend log: "DEV_MODE: Skipping OTP for test.user@example.com"
   ```

5. **Enter OTP**
   ```
   Enter: 123456 (the dev OTP)
   Click "Verify"
   ```

6. **Fill profile**
   ```
   Name: Test User
   College: Test University
   University Number: 12345
   Degree Type: Bachelor
   Branch: Computer Science
   Year: 3
   Learning Style: Visual
   ```

7. **Submit signup**
   ```
   Click "Create Account"
   Expected: Redirect to dashboard
   Backend log: "USER_SIGNUP_SUCCESS: test.user@example.com"
   Frontend: User profile appears
   ```

### H.2 Failure Case — Missing .env

**Test:** Start backend without .env file

**Steps:**

1. **Delete .env** (if exists)
   ```bash
   cd server
   rm .env
   ```

2. **Start backend**
   ```bash
   npm run dev
   # Expected error in logs:
   # ERROR: JWT_SECRET or ENCRYPTION_SECRET is not set
   # ERROR: MONGO_URI is not set
   # Server will crash or hang
   ```

3. **Recreate .env** (with EMAIL_VERIFICATION_REQUIRED=false)
   ```bash
   cp .env.example .env
   # Edit: Set EMAIL_VERIFICATION_REQUIRED=false
   ```

4. **Restart backend**
   ```bash
   npm run dev
   # Should start successfully
   ```

### H.3 Failure Case — Email Service Configuration

**Test:** Start backend with EMAIL_VERIFICATION_REQUIRED=true (no email config)

**Steps:**

1. **Edit .env to require email**
   ```bash
   # Remove or comment out:
   EMAIL_VERIFICATION_REQUIRED=false
   # Now it defaults to: true
   ```

2. **Leave email credentials as placeholders**
   ```
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASS=your_app_password
   ```

3. **Start backend**
   ```bash
   npm run dev
   # Expected log:
   # WARN: Email credentials not configured. OTP disabled.
   ```

4. **Try signup**
   ```
   Open http://localhost:5173
   Click Sign Up
   Enter email & password
   Click "Send Verification Code"
   
   Expected error:
   HTTP 503: "Email verification service not configured"
   ```

5. **Fix by setting EMAIL_VERIFICATION_REQUIRED=false**
   ```bash
   # Edit .env:
   EMAIL_VERIFICATION_REQUIRED=false
   
   # Restart backend
   npm run dev
   
   # Try signup again — should work!
   ```

### H.4 Validate Environment Variables

**Test:** Check all critical variables are set

**Command:**
```bash
cd server

# Check each variable
grep "EMAIL_VERIFICATION_REQUIRED" .env
grep "JWT_SECRET" .env
grep "MONGO_URI" .env
grep "REDIS_URL" .env
grep "NODE_ENV" .env

# All should show values (not empty or placeholder)
```

### H.5 Monitor Startup Logs

**Test:** Verify email service debug output

**In backend logs during startup (npm run dev):**

```
[INFO] [STARTUP] EMAIL_VERIFICATION_REQUIRED=false
[INFO] [EMAIL SERVICE DEBUG]
  EMAIL_USER: ✓ configured
  EMAIL_PASS: ✓ configured (if set)
  Placeholder values: no (if real creds)
  EMAIL_VERIFICATION_REQUIRED: false
[WARN] Email credentials not configured. OTP disabled. (if placeholders)
[SUCCESS] Email service ready (if real creds & SMTP works)
```

---

## SECTION I: Expected Successful Output

### I.1 Backend Startup (Successful)

```bash
$ npm run dev

> imentor-unified-server@2.0.0 dev
> nodemon server.js

[nodemon] 3.0.1
[nodemon] to restart at any time, type `rs`
[nodemon] watching path(s): *.*
[nodemon] watching path(s): **/* {}

[SYSTEM] Starting Server Initialization...
[SYSTEM] Admin bootstrap check complete
[SYSTEM] Required server directories exist
[SYSTEM] Connected to MongoDB: mongodb://localhost:27017/imentor
[AUTH] [STARTUP] EMAIL_VERIFICATION_REQUIRED=false
[AUTH] [EMAIL SERVICE DEBUG]
  EMAIL_USER: ✗ missing
  EMAIL_PASS: ✗ missing
  Placeholder values: yes
  EMAIL_VERIFICATION_REQUIRED: false
[AUTH] Email credentials not configured. OTP disabled.
[SYSTEM] Asset cleanup complete
[SYSTEM] RAG service available at http://localhost:2001
[REDIS] Redis client connected successfully.
[SYSTEM] Redis audit complete: 0 bytes used
[SYSTEM] Course file watchers started on: ...
[SYSTEM] Starting gamification cron jobs...
[CRON] Bounty generator job scheduled
[CRON] Bounty cleanup job scheduled
[CRON] Boss battle generator job scheduled
[SYSTEM] Server running on http://localhost:5001
[SYSTEM] Metrics endpoint: http://localhost:5001/metrics
[SYSTEM] Health check: http://localhost:5001/health
```

### I.2 Successful Signup Response

**POST /api/auth/send-otp (Development Mode)**

```json
{
  "message": "Development mode: Email verification skipped. Use OTP \"123456\" to complete signup.",
  "devMode": true,
  "devOtp": "123456"
}
```

**POST /api/auth/verify-otp (Success)**

```json
{
  "valid": true,
  "message": "OTP verified successfully."
}
```

**POST /api/auth/signup (Success)**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "_id": "507f1f77bcf86cd799439011",
  "email": "test.user@example.com",
  "username": "test.user_ab12",
  "hasCompletedOnboarding": false,
  "message": "User registered successfully"
}
```

### I.3 Frontend Success Flow

```
1. Landing Page displays → "Sign Up" button visible
2. User clicks "Sign Up"
3. AuthModal opens → Signup form visible
4. User enters email & password → Clicks "Send Verification Code"
5. Toast appears: "✓ Verification OTP sent to your email"
6. Toast appears: "🔧 Development Mode: Use OTP '123456'"
7. OTP input field appears
8. User enters 123456
9. Toast: "✓ Code verified!"
10. Profile form appears (Step 2)
11. User fills all fields → Clicks "Create Account"
12. Toast: "✓ Signup Successful!"
13. Browser redirects to dashboard
14. Main chat interface loads
```

### I.4 Database State After Signup

**MongoDB - User collection:**
```javascript
{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "email": "test.user@example.com",
  "username": "test.user_ab12",
  "password": "$2a$10$...", // bcrypt hash
  "profile": {
    "name": "Test User",
    "college": "Test University",
    "universityNumber": "12345",
    "degreeType": "Bachelor",
    "branch": "Computer Science",
    "year": "3",
    "learningStyle": "Visual"
  },
  "preferredLlmProvider": "local_llm",
  "hasCompletedOnboarding": false,
  "createdAt": ISODate("2026-05-30T12:00:00.000Z"),
  "updatedAt": ISODate("2026-05-30T12:00:00.000Z")
}
```

**MongoDB - PendingRegistration collection:**
```
EMPTY (auto-deleted after 15 minutes via TTL index)
```

---

## SECTION J: Troubleshooting Guide

### J.1 Common Issues & Solutions

| Issue | Symptoms | Root Cause | Solution |
|-------|----------|-----------|----------|
| **Missing .env** | Server crashes, "JWT_SECRET not set" | .env file not created | `cp .env.example .env` and edit |
| **Email verification required** | 503 error "Email service not configured" | EMAIL_VERIFICATION_REQUIRED=true + no SMTP | Set `EMAIL_VERIFICATION_REQUIRED=false` |
| **MongoDB not running** | Connection timeout, "connect ECONNREFUSED" | Docker containers not started | Run `docker-compose up -d` |
| **Redis not running** | Brute-force protection fails (falls back) | Redis container not started | Run `docker-compose up redis` |
| **Invalid JWT_SECRET** | Token signing fails | JWT_SECRET too short or invalid | Generate: `openssl rand -hex 32` |
| **CORS blocked** | API calls fail from frontend | FRONTEND_URL not configured correctly | Set `FRONTEND_URL=http://localhost:5173` |
| **Port already in use** | "Port 5001 already in use" | Another process using port 5001 | Kill existing: `lsof -i :5001` / `kill -9 <PID>` |
| **MONGO_URI incorrect** | MongoDB connection fails | Wrong MongoDB connection string | Use: `mongodb://localhost:27017/imentor` |
| **Placeholder email vars** | Email service check skipped silently | EMAIL_USER/EMAIL_PASS not changed from template | Replace with real values OR set EMAIL_VERIFICATION_REQUIRED=false |

### J.2 Debug Checklist

```bash
# 1. Verify .env exists
[ -f server/.env ] && echo "✓ .env exists" || echo "✗ .env missing"

# 2. Check critical variables
grep "EMAIL_VERIFICATION_REQUIRED" server/.env
grep "JWT_SECRET" server/.env
grep "MONGO_URI" server/.env

# 3. Test MongoDB connection
mongosh "mongodb://localhost:27017"

# 4. Test Redis connection
redis-cli ping

# 5. Check backend is running
curl http://localhost:5001/health

# 6. Check frontend is running
curl http://localhost:5173

# 7. View backend logs for errors
# (See npm run dev output)

# 8. Monitor network requests
# Open browser DevTools → Network tab → Try signup
```

### J.3 Check Email Configuration at Runtime

**Add this route temporarily to check email config:**

```javascript
// Add to server/routes/debug.js (create if not exists)
router.get('/email-config', (req, res) => {
    res.json({
        EMAIL_HOST: process.env.EMAIL_HOST,
        EMAIL_PORT: process.env.EMAIL_PORT,
        EMAIL_USER: process.env.EMAIL_USER ? '***' : 'NOT SET',
        EMAIL_PASS: process.env.EMAIL_PASS ? '***' : 'NOT SET',
        EMAIL_VERIFICATION_REQUIRED: process.env.EMAIL_VERIFICATION_REQUIRED,
        isEmailServiceConfigured: require('../services/emailService').isEmailServiceConfigured(),
        NODE_ENV: process.env.NODE_ENV
    });
});
```

**Access:** `curl http://localhost:5001/api/debug/email-config`

---

## SECTION K: Quick Start Commands (Copy-Paste)

### K.1 Complete Setup from Scratch (5 minutes)

```bash
# 1. Navigate to project
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main

# 2. Create .env file
cd server
cp .env.example .env

# 3. Set development mode (disable email requirement)
sed -i 's/^# EMAIL_VERIFICATION_REQUIRED=false/EMAIL_VERIFICATION_REQUIRED=false/' .env

# Verify it worked
grep "EMAIL_VERIFICATION_REQUIRED" .env

# 4. Start Docker services (in project root)
cd ..
docker-compose up -d

# Wait for services
sleep 30

# 5. Install backend dependencies
cd server
npm install

# 6. Start backend
npm run dev
# Keep this terminal open, watch for "Server running on..."

# 7. In a NEW terminal, start frontend
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main/frontend
npm install
npm run dev
# Keep this terminal open, watch for "Local: http://localhost:5173"

# 8. Open browser
# http://localhost:5173

# 9. Test signup
# Click "Sign Up"
# Enter email: test@example.com, Password: Test123456
# Click "Send Verification Code"
# Enter OTP: 123456
# Fill profile and submit
```

### K.2 Single Command Startup (After setup)

```bash
# Terminal 1 - Backend
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main/server && npm run dev

# Terminal 2 - Frontend (while Terminal 1 running)
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main/frontend && npm run dev

# Then open: http://localhost:5173
```

---

## SECTION L: Summary of Issues & Fixes

| Issue | Location | Impact | Fix | Priority |
|-------|----------|--------|-----|----------|
| Missing .env file | `server/.env` | Server won't start | Create from .env.example | **P0** |
| EMAIL_VERIFICATION_REQUIRED=true (default) | `.env` / `auth.js:15` | Signup blocked | Set to `false` in .env | **P0** |
| Email service not checked at startup | `server.js:140` | Silent failure, misleading error | Already implemented ✓ | **P1** |
| No debug logging in email service | `emailService.js` | Hard to diagnose | Add DEBUG section (E.3) | **P2** |
| Generic error message | `auth.js:157` | Confusing for developers | Improve message (E.4) | **P2** |
| Frontend doesn't show dev mode indicator | `AuthModal.jsx` | Users don't know why OTP works | Show toast (E.5) | **P3** |

---

## SECTION M: Implementation Checklist

### Before Running Application

- [ ] **Created `server/.env`** from `server/.env.example`
- [ ] **Set `EMAIL_VERIFICATION_REQUIRED=false`** in `.env`
- [ ] **Set `JWT_SECRET`** to a 32+ character random string (or use example)
- [ ] **Set `ENCRYPTION_SECRET`** to a 32+ character random string (or use example)
- [ ] **Set `MONGO_URI`** to `mongodb://localhost:27017/imentor`
- [ ] **Set `REDIS_URL`** to `redis://localhost:6379`
- [ ] **Verified `NODE_ENV=development`**
- [ ] **Installed backend dependencies:** `cd server && npm install`
- [ ] **Installed frontend dependencies:** `cd frontend && npm install`
- [ ] **Started Docker services:** `docker-compose up -d`
- [ ] **Waited 30 seconds for services to initialize**
- [ ] **Backend running:** `npm run dev` in `/server`
- [ ] **Frontend running:** `npm run dev` in `/frontend`
- [ ] **Backend logs show:** "Server running on http://localhost:5001"
- [ ] **Frontend logs show:** "Local: http://localhost:5173"

### During First Signup Test

- [ ] **Open browser:** http://localhost:5173
- [ ] **Click "Sign Up" button**
- [ ] **Enter valid email and password (>=6 chars)**
- [ ] **Click "Send Verification Code"**
- [ ] **See success toast:** "Verification OTP sent to your email"
- [ ] **See dev mode toast:** "Development Mode: Use OTP '123456'"
- [ ] **OTP input appears on form**
- [ ] **Enter:** 123456
- [ ] **Click "Verify" or press Enter**
- [ ] **See success toast:** "Code verified!"
- [ ] **Profile form appears (Step 2)**
- [ ] **Fill all profile fields**
- [ ] **Click "Create Account"**
- [ ] **See success toast:** "Signup Successful!"
- [ ] **Browser redirects to dashboard**
- [ ] **Chat interface visible**
- [ ] **Backend logs show:** "USER_SIGNUP_SUCCESS: {email}"

---

## SECTION N: Next Steps After Successful Signup

Once signup is working:

1. **Test Authentication Flow**
   - Test login with created user
   - Verify JWT token stored and sent in API calls
   - Test logout and re-login

2. **Test Password Reset** (if needed)
   - Set `EMAIL_VERIFICATION_REQUIRED=false` OR configure real email
   - Test forgot-password flow

3. **Test Chat Interface**
   - Send messages
   - Verify LLM responses

4. **Configure Real Email (Optional)**
   - Set up Gmail App Password (see F.4)
   - Update `EMAIL_USER` and `EMAIL_PASS` in `.env`
   - Set `EMAIL_VERIFICATION_REQUIRED=true`
   - Restart backend
   - Test with real email addresses

5. **Deploy to Production**
   - Use strong JWT_SECRET and ENCRYPTION_SECRET
   - Set NODE_ENV=production
   - Set EMAIL_VERIFICATION_REQUIRED=true
   - Configure real email credentials
   - Use production database (not localhost)
   - Enable all security headers (already done)

---

## SECTION O: File Locations Reference

```
iMentor-Main/
├── server/
│   ├── .env                           ← CREATE THIS (from .env.example)
│   ├── .env.example                   ← Template (DO NOT EDIT)
│   ├── server.js                      ← Main server (checks email at startup)
│   ├── routes/
│   │   └── auth.js                    ← Signup/login endpoints
│   ├── services/
│   │   └── emailService.js            ← Email configuration & sending
│   ├── models/
│   │   ├── User.js                    ← User schema
│   │   └── PendingRegistration.js     ← OTP temp storage
│   ├── config/
│   │   ├── db.js                      ← MongoDB connection
│   │   ├── redisClient.js             ← Redis connection
│   │   └── neo4j.js                   ← Neo4j connection
│   ├── middleware/
│   │   └── authMiddleware.js          ← JWT verification
│   └── package.json                   ← Backend dependencies
├── frontend/
│   ├── src/
│   │   ├── components/auth/
│   │   │   └── AuthModal.jsx          ← Signup/login UI
│   │   ├── services/
│   │   │   └── api.js                 ← API client
│   │   └── contexts/
│   │       └── AuthContext.jsx        ← Auth state management
│   └── package.json                   ← Frontend dependencies
├── docker-compose.yml                 ← Infrastructure (MongoDB, Redis, etc.)
└── AUTHENTICATION_DIAGNOSTIC_REPORT.md ← THIS FILE
```

---

## SECTION P: Support & Additional Resources

### P.1 Environment Variables Deep Dive

**For Production:**
- Use strong secrets (generate with `openssl rand -hex 32`)
- Never commit .env to git
- Use environment-specific .env files
- Rotate secrets regularly

**For Development:**
- Can use placeholder values for non-critical vars
- EMAIL_VERIFICATION_REQUIRED=false removes email requirement
- Redis fallback to in-memory cache if unavailable
- Detailed debug logging enabled

### P.2 Gmail App Password Troubleshooting

If real email testing fails:

1. **Verify Gmail settings:**
   - Go to: myaccount.google.com/security
   - Check "2-Step Verification" is ON
   - Go to: myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer"

2. **Common errors:**
   - "Invalid credentials": Wrong app password or email
   - "534 Application-specific password required": 2FA not enabled
   - "535 5.7.8 Username and password not accepted": Typo in credentials

3. **Test SMTP manually:**
   ```bash
   telnet smtp.gmail.com 587
   # Type: EHLO gmail.com
   # Type: STARTTLS
   # (connection should upgrade)
   ```

### P.3 Redis Issues

If Redis not working:

1. **Check Docker:**
   ```bash
   docker ps | grep redis
   docker logs chatbot-redis
   ```

2. **Manual Redis test:**
   ```bash
   redis-cli PING
   # Should return: PONG
   ```

3. **Fallback works automatically:**
   - If Redis unavailable, app uses in-memory cache
   - No data loss, just temporary storage (session-based)

### P.4 MongoDB Atlas (Cloud Database)

To use MongoDB Atlas instead of local:

1. **Create account at mongodb.com**
2. **Create cluster and get connection string**
3. **In .env:**
   ```bash
   MONGO_URI=mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/imentor?retryWrites=true&w=majority
   ```
4. **Restart backend**

---

**END OF DIAGNOSTIC REPORT**

---

**Generated for:** iMentor Team  
**Date:** May 30, 2026  
**Status:** Complete & Ready for Implementation  
**Next Step:** Follow SECTION K for quick start
