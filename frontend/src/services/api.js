// frontend/src/services/api.js
import axios from "axios";
import toast from "react-hot-toast";

// ─── Native-context detection ────────────────────────────────────────────────
// When the app runs inside a Capacitor WebView (Android / iOS) there is no
// Vite dev-proxy and relative paths like "/api" won't resolve.  We must use
// the absolute HTTPS URL of the production backend.
//
// Detection: Capacitor sets window.Capacitor.isNativePlatform() = true at
// runtime, OR the bundle was compiled with VITE_BUILD_FOR_CAPACITOR=true.
//
// .env files:
//   .env                  VITE_BACKEND_URL=  (empty — uses Vite proxy in web dev)
//   .env.mobile           VITE_BUILD_FOR_CAPACITOR=true
//   .env.production       VITE_BACKEND_URL=https://your-server.com
// ─────────────────────────────────────────────────────────────────────────────
function resolveBaseURL() {
  // Runtime check — true when running inside a Capacitor shell on a device
  const isNative =
    typeof window !== 'undefined' &&
    typeof window.Capacitor !== 'undefined' &&
    window.Capacitor?.isNativePlatform?.();

  // Build-time check — true when built with VITE_BUILD_FOR_CAPACITOR=true
  const isCapacitorBuild =
    typeof __CAPACITOR_BUILD__ !== 'undefined' && __CAPACITOR_BUILD__;

  if (isNative || isCapacitorBuild) {
    // Must be an absolute HTTPS URL — no proxy available in the WebView
    const backendUrl = import.meta.env.VITE_BACKEND_URL;
    if (!backendUrl) {
      console.warn(
        '[iMentor] VITE_BACKEND_URL is not set. ' +
        'API calls will fail on device. ' +
        'Set it in .env.mobile or .env.production.'
      );
    }
    return (backendUrl || 'https://REPLACE_WITH_YOUR_SERVER/api');
  }

  // Web browser: use Vite proxy (/api → backend) or explicit env var
  return import.meta.env.VITE_API_BASE_URL || '/api';
}

const apiClient = axios.create({
  baseURL: resolveBaseURL(),
});

apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("authToken");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      console.error("API Interceptor: Received 401 Unauthorized. Token might be invalid or expired.");
      
      const isAuthEndpoint = error.config && error.config.url && (
        error.config.url.includes("/auth/signin") ||
        error.config.url.includes("/auth/signup") ||
        error.config.url.includes("/auth/send-otp") ||
        error.config.url.includes("/auth/verify-otp") ||
        error.config.url.includes("/auth/verify-forgot-otp") ||
        error.config.url.includes("/auth/reset-password") ||
        error.config.url.includes("/auth/validate-llm-key")
      );
      
      if (!isAuthEndpoint) {
        localStorage.removeItem("authToken");
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (
            key && (
              key.startsWith('tutorProgress_') ||
              key.startsWith('quizResults_') ||
              key.startsWith('quizIndex_') ||
              key.startsWith('tutorSession_') ||
              key === 'aiTutorSessionId' ||
              key === 'aiTutorSelectedSubject' ||
              key === 'aiTutorSystemPrompt' ||
              key === 'lastGeneralSessionId' ||
              key === 'lastTutorSessionId' ||
              key.startsWith('mentor:tutor_onboarding_seen') ||
              key.startsWith('deepResearchIntroSeen') ||
              key.includes('.featureIntroSeen.')
            )
          ) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));

        if (typeof window !== "undefined") {
          window.location.href = "/";
        }
      }
    }
    return Promise.reject(error);
  }
);

function parseAnalysisOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') {
    return { content: '', thinking: '' };
  }
  const thinkingMatch = rawOutput.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  let thinkingText = '';
  let mainContent = rawOutput;

  if (thinkingMatch && thinkingMatch[1]) {
    thinkingText = thinkingMatch[1].trim();
    mainContent = rawOutput.replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, '').trim();
  }
  return { content: mainContent, thinking: thinkingText };
}

function getDebugQuerySuffix() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('debug') === 'true' ? '?debug=true' : '';
}

const api = {
  login: async (credentials) => {
    const response = await apiClient.post("/auth/signin", credentials);
    return response.data;
  },
  sendOtp: async (email, password) => {
    const response = await apiClient.post("/auth/send-otp", { email, password });
    return response.data;
  },
  signup: async (userData) => {
    const response = await apiClient.post("/auth/signup", userData);
    return response.data;
  },
  getMe: async () => {
    const response = await apiClient.get("/auth/me");
    return response.data;
  },
  completeOnboarding: async () => {
    const response = await apiClient.post('/auth/complete-onboarding');
    return response.data;
  },
  forgotPassword: async (email) => {
    const response = await apiClient.post('/auth/forgot-password', { email });
    return response.data;
  },
  verifyOtp: async (email, otp) => {
    const response = await apiClient.post('/auth/verify-otp', { email, otp });
    return response.data;
  },
  verifyForgotOtp: async (email, otp) => {
    const response = await apiClient.post('/auth/verify-forgot-otp', { email, otp });
    return response.data;
  },
  resetPassword: async (email, otp, newPassword) => {
    const response = await apiClient.post('/auth/reset-password', { email, otp, newPassword });
    return response.data;
  },
  sendMessage: async (payload, signal) => {
    const token = localStorage.getItem("authToken");
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${apiClient.defaults.baseURL}/chat/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `Server error: ${res.status}` }));
      const error = new Error(err.message || `Server error: ${res.status}`);
      error.response = { data: err, status: res.status };
      throw error;
    }

    const contentType = res.headers.get('content-type') || '';
    // If server responds with JSON (non-streaming), return directly
    if (contentType.includes('application/json')) {
      return await res.json();
    }

    // SSE stream: read through events and return the final_answer payload
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!chunk.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(chunk.slice(6));
          if (event.type === 'final_answer') {
            finalData = event.content;
          }
        } catch (_) { /* skip malformed chunks */ }
      }
    }

    if (finalData) {
      return { reply: finalData, sessionId: finalData.sessionId };
    }
    throw new Error("No final answer received from stream.");
  },
  getChatHistory: async (sessionId) => {
    const response = await apiClient.get(`/chat/session/${sessionId}`);
    return response.data;
  },
  getChatSessions: async () => {
    const response = await apiClient.get("/chat/sessions");
    return response.data;
  },
  startNewSession: async (previousSessionId, skipAnalysis = false, courseName = null, forceNewChat = false, isTutorMode = false, tutorModeType = null) => {
    const response = await apiClient.post("/chat/history", {
      previousSessionId,
      skipAnalysis,
      courseName,
      forceNewChat,
      isTutorMode,
      tutorModeType
    });
    return response.data;
  },
  deleteChatSession: async (sessionId) => {
    const response = await apiClient.delete(`/chat/session/${sessionId}`);
    return response.data;
  },
  uploadFile: async (formData, onUploadProgress) => {
    const response = await apiClient.post("/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress,
    });
    return response.data;
  },
  // getFiles: async () => {
  //   const response = await apiClient.get("/files");
  //   return response.data;
  // },
  // deleteFile: async (serverFilename) => {
  //   const response = await apiClient.delete(`/files/${serverFilename}`);
  //   return response.data;
  // },
  getKnowledgeSources: async () => {
    const response = await apiClient.get("/knowledge-sources");
    return response.data;
  },
  deleteKnowledgeSource: async (sourceId) => {
    const response = await apiClient.delete(`/knowledge-sources/${sourceId}`);
    return response.data;
  },
  addUrlSource: async (url) => {
    const response = await apiClient.post("/knowledge-sources", {
      type: "url",
      content: url,
    });
    return response.data; // Returns the initial source object with "processing" status
  },
  updateUserLLMConfig: async (configData) => {
    const response = await apiClient.put("/llm/config", configData);
    return response.data;
  },
  validateLLMProviderConnection: async ({ provider, apiKey, ollamaUrl }) => {
    const response = await apiClient.post("/llm/validate-provider-connection", { provider, apiKey, ollamaUrl });
    return response.data; // { ok, provider, models, message }
  },
  // Public — no auth required. Used during signup to validate gemini/groq keys.
  validateLLMKeyPublic: async ({ provider, apiKey }) => {
    const response = await apiClient.post("/auth/validate-llm-key", { provider, apiKey });
    return response.data; // { ok, message }
  },
  getOrchestratorStatus: async () => {
    try {
      const response = await apiClient.get("/network/ip");
      return {
        status: "ok",
        message: `Backend Online at ${response.data.ips[0]}`,
      };
    } catch (e) {
      return { status: "error", message: "Backend Unreachable" };
    }
  },
  getDebugFeatureFlags: async () => {
    const response = await apiClient.get(`/debug/feature-flags${getDebugQuerySuffix()}`);
    return response.data;
  },
  toggleDebugFeature: async (feature, enabled) => {
    const response = await apiClient.post(`/debug/toggle-feature${getDebugQuerySuffix()}`, { feature, enabled });
    return response.data;
  },
  getUserProfile: async () => {
    const response = await apiClient.get("/user/profile");
    return response.data;
  },
  updateUserProfile: async (profileData) => {
    const response = await apiClient.put("/user/profile", profileData);
    return response.data;
  },
  getSubjects: async () => {
    const response = await apiClient.get("/subjects");
    const raw = response.data;
    if (raw && Array.isArray(raw.subjects)) {
      raw.subjects = raw.subjects.map(c => {
        if (typeof c === 'object' && c !== null && !Array.isArray(c)) {
          return { code: c.code || '', name: c.name || c.code || '', semester: c.semester || null, credits: c.credits != null ? c.credits : null };
        }
        const s = String(c || '');
        return { code: s, name: s, semester: null, credits: null };
      }).filter(c => c.code);
    }
    return raw;
  },
  getCourseStructure: async (courseName) => {
    const response = await apiClient.get(`/courses/${encodeURIComponent(courseName)}/structure`);
    return response.data;
  },
  getCourseSubtopicNotes: async (courseName, subtopicId) => {
    const response = await apiClient.get(
      `/courses/${encodeURIComponent(courseName)}/notes/${encodeURIComponent(subtopicId)}`
    );
    return response.data;
  },
  getCourseLectureSection: async (courseName, subtopicId, subtopicName = '', topicName = '') => {
    const response = await apiClient.get(
      `/courses/${encodeURIComponent(courseName)}/lecture/${encodeURIComponent(subtopicId)}`,
      { params: { subtopicName, topicName }, timeout: 130000 }
    );
    return response.data;
  },
  requestAnalysis: async (payload) => {
    const { filename, analysis_type } = payload;
    if (!filename || !analysis_type) {
      throw new Error("Filename and analysis type are required.");
    }
    const toastId = toast.loading(
      `Generating ${analysis_type} for "${filename}"...`
    );

    const handleGenerationFallback = async () => {
        toast.loading(`Real-time generation triggered for "${filename}". This may take ~10-20 seconds...`, { id: toastId });
        const bgResponse = await apiClient.post(`/analysis/generate`, payload);
        const bgRawOutput = bgResponse.data[analysis_type];
        if (!bgRawOutput) throw new Error("Fallback generation failed.");
        const { content, thinking } = parseAnalysisOutput(bgRawOutput);
        toast.success(`Successfully generated ${analysis_type} for "${filename}".`, { id: toastId });
        return { content, thinking };
    };

    try {
      const response = await apiClient.get(
        `/analysis/${encodeURIComponent(filename)}`
      );
      const fullAnalysisObject = response.data;
      const rawOutput = fullAnalysisObject[analysis_type];
      if (
        !rawOutput ||
        typeof rawOutput !== "string" ||
        rawOutput.trim() === ""
      ) {
         return await handleGenerationFallback();
      }
      const { content, thinking } = parseAnalysisOutput(rawOutput);
      toast.success(
        `Successfully retrieved ${analysis_type} for "${filename}".`,
        { id: toastId }
      );
      return { content, thinking };
    } catch (error) {
      if (error.response && error.response.status === 404) {
         try {
             return await handleGenerationFallback();
         } catch (fallbackError) {
             const errorMessage = fallbackError.response?.data?.message || fallbackError.message || "Unknown error during fallback";
             toast.error(`Error generating ${analysis_type}: ${errorMessage}`, { id: toastId });
             throw fallbackError;
         }
      }
      const errorMessage =
        error.response?.data?.message || error.message || "Unknown error";
      toast.error(`Error getting ${analysis_type}: ${errorMessage}`, {
        id: toastId,
      });
      throw error;
    }
  },
  generatePodcast: async ({
    analysisContent,
    sourceDocumentName,
    podcastOptions,
  }) => {
    const response = await apiClient.post(
      "/export/podcast",
      { analysisContent, sourceDocumentName, podcastOptions },
      { responseType: "blob" }
    );
    return { audioBlob: response.data, sourceDocumentName };
  },
  getKnowledgeGraph: async (documentName) => {
    const response = await apiClient.get(
      `/kg/visualize/${encodeURIComponent(documentName)}`
    );
    return response.data;
  },
  getSessionKnowledgeGraph: async (sessionId) => {
    const response = await apiClient.get(
      `/kg/session/${encodeURIComponent(sessionId)}`
    );
    return response.data;
  },
  executeCode: async (payload) => {
    const response = await apiClient.post("/tools/execute", payload);
    return response.data;
  },
  analyzeCode: async (payload) => {
    const response = await apiClient.post("/tools/analyze-code", payload);
    return response.data;
  },
  generateTestCases: async (payload) => {
    const response = await apiClient.post(
      "/tools/generate-test-cases",
      payload
    );
    return response.data;
  },
  explainError: async (payload) => {
    const response = await apiClient.post("/tools/explain-error", payload);
    return response.data;
  },
  getRecommendations: async (sessionId) => {
    const response = await apiClient.get(
      `/learning/recommendations/${sessionId}`
    );
    return response.data;
  },

  findDocumentForTopic: async (topic) => {
    const response = await apiClient.post("/learning/find-document", { topic });
    return response.data;
  },
  getLearningPaths: async () => {
    const response = await apiClient.get("/learning/paths");
    return response.data;
  },

  generateLearningPath: async (goal, context = null) => {
    const response = await apiClient.post("/learning/paths/generate", {
      goal,
      context,
    });
    return response.data;
  },

  updateModuleStatus: async (pathId, moduleId, status) => {
    const response = await apiClient.put(
      `/learning/paths/${pathId}/modules/${moduleId}`,
      { status }
    );
    return response.data;
  },

  generateQuiz: async (file, quizOption) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("quizOption", quizOption); // <<< Send the descriptive string

    const response = await apiClient.post("/tools/generate-quiz", formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
      timeout: 300000,
    });
    return response.data; // Should be { quiz: [...] }
  },
  analyzePrompt: async (promptText) => {
    const response = await apiClient.post("/chat/analyze-prompt", {
      prompt: promptText,
    });
    return response.data; // Expects { improvedPrompt, explanation }
  },
  // --- Academic Integrity Tools ---
  submitIntegrityCheck: async ({ text }) => {
    const response = await apiClient.post("/tools/analyze-integrity/submit", { text });
    return response.data; // Expects { reportId, initialReport }
  },

  getIntegrityReport: async (reportId) => {
    const response = await apiClient.get(`/tools/analyze-integrity/report/${reportId}`);
    return response.data; // Expects the full report object with status updates
  },
  deleteLearningPath: async (pathId) => {
    const response = await apiClient.delete(`/learning/paths/${pathId}`);
    return response.data;
  },
  generateDocument: async (payload) => {
    // This function now handles the entire download process, including error handling.
    const response = await apiClient.post("/generate/document", payload, {
      responseType: "blob" // Crucial: expect a file blob
    });

    // --- THIS IS THE FIX ---
    // If the server sent back a JSON error instead of a file, it will have this content type.
    if (response.data.type === 'application/json') {
      const errorText = await response.data.text();
      const errorJson = JSON.parse(errorText);
      throw new Error(errorJson.message || "An unknown error occurred during generation.");
    }
    // --- END OF FIX ---

    const contentDisposition = response.headers["content-disposition"];
    let filename = `generated-document.${payload.docType}`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
      if (filenameMatch && filenameMatch.length > 1) {
        filename = filenameMatch[1];
      }
    }

    // Trigger browser download
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    window.URL.revokeObjectURL(url);

    return { success: true, filename }; // Return success for toast messages
  },
  generateDocumentFromTopic: async (payload) => {
    const { topic, docType } = payload;
    const response = await apiClient.post(
      `/generate/document/from-topic`,
      { topic, docType },
      { responseType: "blob" } // CRITICAL: This tells axios to expect a file
    );

    if (response.data.type === 'application/json') {
      const errorText = await response.data.text();
      const errorJson = JSON.parse(errorText);
      throw new Error(errorJson.message || "An unknown error occurred during generation from topic.");
    }


    // Extract filename from the 'Content-Disposition' header
    const contentDisposition = response.headers["content-disposition"];
    let filename = `generated-document.${docType}`; // a fallback
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
      if (filenameMatch && filenameMatch.length > 1) {
        filename = filenameMatch[1];
      }
    }

    // Create a temporary link to trigger the browser's automatic download
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();

    // Clean up the temporary link from memory
    link.parentNode.removeChild(link);
    window.URL.revokeObjectURL(url);

    return { success: true, filename }; // Return success status for the toast
  },
  submitFeedback: async (logId, feedback) => {
    const response = await apiClient.post(`/feedback/${logId}`, { feedback });
    return response.data;
  },

  // ===== Admin Gamification APIs =====
  getGamificationOverview: async () => {
    const response = await apiClient.get('/admin/gamification/overview');
    return response.data;
  },

  getActiveStreakUsers: async () => {
    const response = await apiClient.get('/admin/gamification/active-streaks');
    return response.data;
  },

  getGamificationUsers: async (page = 1, limit = 20) => {
    const response = await apiClient.get('/admin/gamification/users', {
      params: { page, limit }
    });
    return response.data;
  },

  awardLearningCreditsToUser: async (userId, amount, reason) => {
    const response = await apiClient.post('/admin/gamification/award-learning-credits', {
      userId,
      amount,
      reason
    });
    return response.data;
  },

  // Backward compatibility alias
  awardXPToUser: async (userId, amount, reason) => {
    const response = await apiClient.post('/admin/gamification/award-learning-credits', {
      userId,
      amount,
      reason
    });
    return response.data;
  },

  getAdminSkillTree: async () => {
    const response = await apiClient.get('/admin/gamification/skill-tree');
    return response.data;
  },

  createSkill: async (skillData) => {
    const response = await apiClient.post('/admin/gamification/skill-tree', skillData);
    return response.data;
  },

  updateSkill: async (skillId, skillData) => {
    const response = await apiClient.put(`/admin/gamification/skill-tree/${skillId}`, skillData);
    return response.data;
  },

  deleteSkill: async (skillId) => {
    const response = await apiClient.delete(`/admin/gamification/skill-tree/${skillId}`);
    return response.data;
  },

  getAdminBossBattles: async () => {
    const response = await apiClient.get('/admin/gamification/boss-battles');
    return response.data;
  },

  getAdminContributions: async () => {
    const response = await apiClient.get('/admin/gamification/contributions');
    return response.data;
  },

  approveContribution: async (contributionId) => {
    const response = await apiClient.put(`/admin/gamification/contribution/${contributionId}/approve`);
    return response.data;
  },

  rejectContribution: async (contributionId) => {
    const response = await apiClient.put(`/admin/gamification/contribution/${contributionId}/reject`);
    return response.data;
  },



  // Gamification User APIs
  getBounties: async () => {
    const response = await apiClient.get('/gamification/bounties');
    return response.data;
  },

  getGamificationProfile: async () => {
    const response = await apiClient.get('/gamification/profile');
    return response.data;
  },

  getUserSkillTree: async () => {
    const response = await apiClient.get('/gamification/skill-tree');
    return response.data;
  },

  // Knowledge State API
  getKnowledgeState: async () => {
    const response = await apiClient.get('/knowledge-state');
    return response.data;
  },

  resetKnowledgeState: async () => {
    const response = await apiClient.delete('/knowledge-state/reset', {
      data: { confirmReset: true }
    });
    return response.data;
  },

  exportKnowledgeState: async () => {
    const response = await apiClient.get('/knowledge-state/export', {
      responseType: 'blob'
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `learning-memory-${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    window.URL.revokeObjectURL(url);

    return { success: true };
  },

  optOutKnowledgeState: async (optOut) => {
    const response = await apiClient.patch('/knowledge-state/opt-out', { optOut });
    return response.data;
  },

  getStrugglingTopics: async () => {
    const response = await apiClient.get('/knowledge-state/struggling');
    return response.data;
  },

  getMasteredTopics: async () => {
    const response = await apiClient.get('/knowledge-state/mastered');
    return response.data;
  },

  checkKnowledgeStateHealth: async () => {
    const response = await apiClient.get('/knowledge-state/health-check');
    return response.data;
  },

  // ===== Curriculum Progress APIs =====
  getTutorCurriculumStructure: async (courseName) => {
    const response = await apiClient.get(`/chat/curriculum/structure/${encodeURIComponent(courseName)}`);
    return response.data;
  },

  getProgress: async (courseName) => {
    const response = await apiClient.get(`/progress/${encodeURIComponent(courseName)}`);
    return response.data;
  },

  updateProgress: async (courseName, type, id) => {
    const response = await apiClient.post('/progress/update', { courseName, type, id });
    return response.data;
  },

  syncProgress: async (courseName, completedTopics, completedModules, completedSubtopics) => {
    const response = await apiClient.post('/progress/update', {
      courseName,
      type: 'sync',
      id: 'bulk',
      completedTopics,
      completedModules,
      completedSubtopics
    });
    return response.data;
  },
  updateQuizProgress: async (courseName, quizResults, quizIndex) => {
    const response = await apiClient.post('/progress/quiz', { courseName, quizResults, quizIndex });
    return response.data;
  },
  // --- Deep Research APIs ---
  getResearchHistory: async () => {
    const response = await apiClient.get('/research/history');
    return response.data;
  },
  getResearchDetail: async (id) => {
    const response = await apiClient.get(`/research/${id}`);
    return response.data;
  },
  exportResearchPDF: async (id) => {
    const response = await apiClient.post(`/research/${id}/export`, {}, {
      responseType: 'blob'
    });
    return response.data;
  },

  // --- Deep Research Job APIs (fire-and-forget) ---
  startResearchJob: async ({ query, nature, depth }) => {
    const response = await apiClient.post('/deep-research/start', { query, nature, depth });
    return response.data;
  },
  getResearchJobStatus: async (jobId) => {
    const response = await apiClient.get(`/deep-research/jobs/${jobId}`);
    return response.data;
  },
  getResearchJobReport: async (jobId) => {
    const response = await apiClient.get(`/deep-research/jobs/${jobId}/report`);
    return response.data;
  },
  listResearchJobs: async () => {
    const response = await apiClient.get('/deep-research/jobs');
    return response.data;
  },
  getDeepResearchHistory: async () => {
    const response = await apiClient.get('/deep-research/history');
    return response.data;
  },

  // ===== Practice Quiz (from fine-tuned QA dataset) =====
  getPracticeQuestions: async (course = null) => {
    const params = course ? { course } : {};
    const response = await apiClient.get('/admin/finetuning/questions', { params });
    return response.data;
  },

  // ===== User Feedback (product bugs / suggestions) =====
  submitUserFeedback: async ({ type, category, message, attachments = [] }) => {
    const formData = new FormData();
    formData.append('type', type);
    formData.append('category', category);
    formData.append('message', message);
    attachments.forEach(file => formData.append('attachments', file));
    const response = await apiClient.post('/user/feedback', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },
  getUserFeedback: async () => {
    const response = await apiClient.get('/user/feedback');
    return response.data;
  },

  // ===== Tutor Progress =====
  getTutorProgress: async (course) => {
    const response = await apiClient.get(`/chat/tutor/current-position/${encodeURIComponent(course)}`);
    return response.data;
  },

  // ===== Speech-to-Text (Whisper backend) =====
  transcribeAudio: async (audioBlob, filename = 'recording.webm') => {
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);
    const response = await apiClient.post('/chat/transcribe', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 30000,
    });
    return response.data; // { text: string, language: string }
  },
  // ===== Socratic Quiz Engine =====
  generateSocraticQuiz: async (courseName, moduleId = null, moduleName = null) => {
    const response = await apiClient.get('/quiz/generate', {
      params: { courseName, moduleId, moduleName }
    });
    return response.data;
  },
  submitSocraticQuiz: async (courseName, answers, moduleId = null, moduleName = null) => {
    const response = await apiClient.post('/quiz/submit', {
      courseName,
      moduleId,
      moduleName,
      answers
    }, { timeout: 20000 });
    return response.data;
  },
  getQuizAnalytics: async () => {
    const response = await apiClient.get('/quiz/analytics');
    return response.data;
  },

  // ===== Knowledge Assessment Engine =====
  generateAssessment: async ({ course, module, topic }) => {
    const response = await apiClient.post('/assessment/generate', { course, module, topic });
    return response.data;
  },
  submitAssessment: async ({ responses, topic, course }) => {
    const response = await apiClient.post('/assessment/submit', { responses, topic, course });
    return response.data;
  },
  getAssessmentProfile: async (topic) => {
    const params = topic ? { topic } : {};
    const response = await apiClient.get('/assessment/profile', { params });
    return response.data;
  },
  getAssessmentHistory: async (topic) => {
    const params = topic ? { topic } : {};
    const response = await apiClient.get('/assessment/history', { params });
    return response.data;
  },
  getBloomTaxonomy: async (topic) => {
    const params = topic ? { topic } : {};
    const response = await apiClient.get('/assessment/blooms-taxonomy', { params });
    return response.data;
  }
};


export default api;