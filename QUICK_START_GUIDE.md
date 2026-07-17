# iMentor — Quick Start Guide (5 Minutes)

**Goal:** Get the web application fully functional with working signup

**Status:** Ready to run! All critical issues fixed.

---

## Step 1: Verify Prerequisites (1 minute)

```bash
# Check Node.js version (should be 20+)
node --version

# Check npm version
npm --version

# Check Docker is running
docker ps

# Navigate to project root
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main
```

**✓ All good?** Continue to Step 2

---

## Step 2: Verify Environment Configuration (30 seconds)

```bash
# Check .env file exists
cat server/.env | head -20

# Verify critical settings
grep "EMAIL_VERIFICATION_REQUIRED" server/.env
# Should output: EMAIL_VERIFICATION_REQUIRED=false

grep "JWT_SECRET" server/.env
# Should output: JWT_SECRET=imentor_dev_jwt_secret_...

grep "MONGO_URI" server/.env
# Should output: MONGO_URI=mongodb://localhost:27018/chatbot_autoresearch
```

**✓ All settings look good?** Continue to Step 3

---

## Step 3: Start Infrastructure Services (2 minutes)

```bash
# From project root, start Docker services
docker-compose up -d

# Wait for services to start
sleep 30

# Verify services are running
docker-compose ps

# Expected output:
# - mongo ........................ UP (healthy after ~10s)
# - redis ........................ UP (healthy)
# - neo4j ........................ UP (healthy after ~15s)
# - qdrant ....................... UP (healthy)
# - elasticsearch ................ UP (healthy after ~15s)
# - sglang ....................... UP (starting, takes ~60s)
```

**✓ Services running?** Continue to Step 4

---

## Step 4: Start Backend (1 minute)

**Terminal 1:**
```bash
cd server

# Install dependencies (first time only)
npm install

# Start development server
npm run dev

# Expected output:
# ✓ Server listening on port 5001
# ✓ Connected to MongoDB
# ✓ Redis client connected
# ✓ Server running on http://localhost:5001
# 
# Look for:
# [AUTH] DEV_MODE: Email verification disabled
# or
# [AUTH] Email credentials not configured. OTP disabled.
#
# Both are NORMAL and EXPECTED in development!
```

**✓ Backend started successfully?** Continue to Step 5

---

## Step 5: Start Frontend (1 minute)

**Terminal 2 (keep Terminal 1 running):**
```bash
cd /c/Users/prave/OneDrive/Documents/GitHub/iMentor-Main/frontend

# Install dependencies (first time only)
npm install

# Start development server
npm run dev

# Expected output:
# ✓ VITE v5... ready in XXX ms
# ✓ Local:   http://localhost:5173/
# ✓ press h to show help
```

**✓ Frontend started successfully?** Continue to Step 6

---

## Step 6: Test Application (1 minute)

**In Browser:**

```
1. Open: http://localhost:5173
   
2. See: iMentor landing page with "Sign In" and "Sign Up" buttons

3. Click: "Sign Up" button

4. See: AuthModal with email/password form

5. Enter:
   Email: test.user@example.com
   Password: DevTest123456

6. Click: "Send Verification Code"
   
   Expected messages:
   ✓ "Verification OTP sent to your email"
   ✓ "🔧 Development Mode: Use OTP '123456'"
   
   (In dev mode, these are shown instead of real email)

7. Enter: 123456 (the test OTP shown above)

8. Click: Verify / Press Enter
   
   Expected:
   ✓ "Code verified!"
   ✓ Profile form appears

9. Fill profile:
   Name: Test User
   College: University Name
   University Number: 12345
   Degree: Bachelor
   Branch: Computer Science
   Year: 3
   Learning Style: Visual

10. Click: "Create Account"
    
    Expected:
    ✓ Success toast
    ✓ Redirects to dashboard
    ✓ Chat interface visible
    ✓ Can type messages

11. In backend logs (Terminal 1):
    Look for: "USER_SIGNUP_SUCCESS: test.user@example.com"
```

**🎉 SUCCESS! Application is fully functional!**

---

## Port Reference

| Service | Port | URL | Status |
|---------|------|-----|--------|
| Frontend | 5173 | http://localhost:5173 | Development server |
| Backend | 5001 | http://localhost:5001 | Express API |
| MongoDB | 27018 | (internal Docker) | Database |
| Redis | 6380 | (internal Docker) | Cache |
| Neo4j | 7688 | (internal Docker) | Knowledge graph |
| Qdrant | 6335 | (internal Docker) | Vector DB |
| Elasticsearch | 9201 | (internal Docker) | Search |
| SGLang | 8000 | (internal Docker) | LLM inference |

**Note:** Ports are shifted from standard defaults (27017→27018, 6379→6380, etc.) to avoid conflicts with existing services.

---

## Troubleshooting Quick Fixes

### "Port already in use"
```bash
# Kill process on port 5001
npx kill-port 5001

# Or manually find and kill
lsof -i :5001
kill -9 <PID>

# Restart backend
cd server && npm run dev
```

### "Cannot connect to MongoDB"
```bash
# Verify Docker services running
docker-compose ps

# If not running, start them
docker-compose up -d

# Wait 30 seconds for MongoDB to become healthy
sleep 30

# Restart backend
npm run dev
```

### "Email verification service not configured"
```bash
# This should NOT appear with EMAIL_VERIFICATION_REQUIRED=false

# Verify setting:
grep "EMAIL_VERIFICATION_REQUIRED" server/.env
# Should show: EMAIL_VERIFICATION_REQUIRED=false

# If it shows =true or is missing:
# Edit server/.env and add/change:
EMAIL_VERIFICATION_REQUIRED=false

# Restart backend
npm run dev
```

### Frontend stuck on loading
```bash
# Check if frontend dev server is running (Terminal 2)
# Should see "Local: http://localhost:5173"

# If not running, start it:
cd frontend
npm run dev

# If getting 404 errors in browser console:
# Clear browser cache (Ctrl+Shift+Delete)
# Refresh page (Ctrl+R)
```

### Backend won't start
```bash
# Check for errors:
npm run dev 2>&1 | head -50

# Common issues:
# 1. Missing packages: npm install
# 2. Port in use: npx kill-port 5001
# 3. Missing .env: cp .env.example .env && add EMAIL_VERIFICATION_REQUIRED=false
# 4. MongoDB not running: docker-compose up -d
```

---

## What's Working ✓

- ✓ **Signup with development OTP** (test code: 123456)
- ✓ **Email verification disabled** for development (no SMTP needed)
- ✓ **User profile creation** during signup
- ✓ **JWT authentication** for subsequent requests
- ✓ **Login functionality** with created accounts
- ✓ **Chat interface** ready for LLM responses
- ✓ **Database persistence** with MongoDB
- ✓ **Session management** with Redis
- ✓ **Rate limiting** for API endpoints
- ✓ **CORS configuration** for cross-origin requests

---

## Next Steps

### 1. **Test More Features**
- [ ] Try login with created account
- [ ] Test sending chat messages
- [ ] Explore admin panel (if configured)
- [ ] Check user profile page

### 2. **For Real Email Testing (Optional)**
If you want to test with real email:
```bash
# Set up Gmail App Password (see AUTHENTICATION_DIAGNOSTIC_REPORT.md, Section F.4)
# Update .env:
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_16_char_app_password
EMAIL_VERIFICATION_REQUIRED=true

# Restart backend
npm run dev

# Signup will now send real OTP codes
```

### 3. **Development Tips**
- Backend hot-reloads with nodemon (edit files and save)
- Frontend hot-reloads automatically (edit files and save)
- Check browser DevTools → Network tab for API calls
- Check backend terminal for logs with [AUTH], [SYSTEM], etc.

### 4. **Stopping Services**
```bash
# Stop backend (Terminal 1): Press Ctrl+C
# Stop frontend (Terminal 2): Press Ctrl+C
# Stop Docker services:
docker-compose down

# To also remove data:
docker-compose down -v
```

---

## File Locations

- **Backend:** `/server/`
- **Frontend:** `/frontend/`
- **Configuration:** `/server/.env`
- **Docker setup:** `/docker-compose.yml`
- **Documentation:** `/AUTHENTICATION_DIAGNOSTIC_REPORT.md`

---

## Support

If you encounter issues:

1. **Check logs:**
   - Backend: Terminal 1 (npm run dev output)
   - Frontend: Terminal 2 (npm run dev output)
   - Browser: DevTools → Console tab

2. **Check services:**
   ```bash
   docker-compose ps
   curl http://localhost:5001/health
   ```

3. **Read detailed guide:**
   - Open: `/AUTHENTICATION_DIAGNOSTIC_REPORT.md`
   - Section J: Troubleshooting Guide
   - Section K: Quick start commands

---

**Ready to start?** ➜ Go to **Step 1** above! 🚀

**Project Status:** ✅ Ready to Run — All authentication & email issues resolved
