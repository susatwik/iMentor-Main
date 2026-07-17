// server/routes/chat/helpers.js
// Shared utility functions for the chat route handlers.
const knowledgeStateService = require('../../services/knowledgeStateService');
const log = require('../../utils/logger');
const { buildDebugMetadata } = require('../../utils/debugMetadata');

async function emitTutorKnowledgeEvents({ userId, sessionId, statusStr, conceptName, hintUsed, mastered }) {
    try {
        const primaryEvent =
            mastered ? 'concept_mastered' :
                (statusStr === 'CORRECT' || statusStr === 'PARTIAL') ? 'student_answer_correct' :
                    'student_answer_wrong';

        await knowledgeStateService.updateKnowledgeFromTutorEvent(userId, sessionId, primaryEvent, { conceptName });

        if (hintUsed) {
            await knowledgeStateService.updateKnowledgeFromTutorEvent(userId, sessionId, 'hint_used', { conceptName });
        }
    } catch (err) {
        log.warn('TUTOR', `Knowledge event emit failed (non-fatal): ${err.message}`);
    }
}

function streamEvent(res, eventData) {
    if (res.writableEnded) {
        return;
    }

    let outboundEvent = eventData;
    if (
        res?.locals?.isDebugMode === true &&
        eventData?.type === 'final_answer' &&
        eventData?.content &&
        typeof eventData.content === 'object' &&
        !Array.isArray(eventData.content)
    ) {
        outboundEvent = {
            ...eventData,
            content: {
                ...eventData.content,
                debug: buildDebugMetadata(res.locals.debugContext || {})
            }
        };
    }

    res.write(`data: ${JSON.stringify(outboundEvent)}\n\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎓 ACADEMIC SUBJECT FILTER
// Fast rule-based check — zero LLM cost.
// Returns true if the query is clearly NON-academic.
// ─────────────────────────────────────────────────────────────────────────────
const NON_ACADEMIC_PATTERNS = [
    // Entertainment & Media
    /\b(movie|movies|film|films|cinema|netflix|series|tv show|web series|anime|drama|episode|season|actor|actress|director|bollywood|hollywood|ott|streaming)\b/i,
    // Sports & Games
    /\b(cricket|football|soccer|basketball|tennis|ipl|fifa|nba|match|score|player|team|tournament|league|gaming|video game|fortnite|pubg|minecraft|gta|valorant|esports)\b/i,
    // Social Media & Celebrities (removed "trending" to allow academic trend queries)
    /\b(instagram celebrity|tiktok dance|viral meme|followers count|likes count|social media influencer)\b/i,
    // Food & Lifestyle
    /\b(recipe|cooking|cake|pizza|biryani|restaurant|food|diet|workout|gym|fashion|clothing|style|hair|makeup|skincare)\b/i,
    // Politics & Gossip (non-academic)
    /\b(gossip|rumor|scandal|affair|breakup|relationship advice|dating|marriage tips|love advice)\b/i,
    // Jokes & Entertainment
    /\b(joke|funny|meme|roast|tell me a story|bedtime story|riddle|prank)\b/i,
];

/**
 * Returns a rejection reason string if query is non-academic, or null if OK.
 */
function detectNonAcademic(query) {
    const lower = query.toLowerCase().trim();

    // Very short greetings are fine — don't block
    if (lower.length < 15 && /^(hi|hello|hey|thanks|ok|okay|yes|no|sure|got it|understood)/.test(lower)) {
        return null;
    }

    for (const pattern of NON_ACADEMIC_PATTERNS) {
        if (pattern.test(query)) {
            const match = query.match(pattern);
            return match ? match[0] : 'non-academic content';
        }
    }
    return null;
}

function doesQuerySuggestRecall(query) {
    const lowerCaseQuery = query.toLowerCase();
    const recallKeywords = [
        'my name', 'my profession', 'i am', 'i told you',
        'remember', 'recall', 'remind me', 'go back to',
        'previously', 'before', 'we discussed', 'we were talking about',
        'earlier', 'yesterday', 'last session',
        'what did i say', 'what was', 'what were', 'who am i',
        'do you know', 'can you tell me again',
        'continue with', 'let\'s continue', 'pick up where we left off',
    ];
    return recallKeywords.some(keyword => lowerCaseQuery.includes(keyword));
}

const TUTOR_MODE_TYPES = {
    COURSE_STRUCTURED: 'structured',
    GENERAL_SOCRATIC: 'general_socratic',
    ASSISTANT: 'assistant'
};

function hasCourseSelection(documentContextName) {
    if (!documentContextName || typeof documentContextName !== 'string') return false;
    const normalized = documentContextName.trim().toLowerCase();
    return !!normalized && normalized !== 'general';
}

function resolveTutorModeType(requestedModeType, documentContextName) {
    if (requestedModeType === TUTOR_MODE_TYPES.ASSISTANT) {
        return TUTOR_MODE_TYPES.ASSISTANT;
    }

    return hasCourseSelection(documentContextName)
        ? TUTOR_MODE_TYPES.COURSE_STRUCTURED
        : TUTOR_MODE_TYPES.GENERAL_SOCRATIC;
}

function isDirectExplanationRequest(query = '') {
    return /\b(just explain|explain fully|full explanation|no questions|just tell me|direct answer|give me the answer|don't ask|do not ask)\b/i.test(query || '');
}

function enforceGeneralSocraticStyle(answer = '', userQuery = '') {
    const text = String(answer || '').trim();
    if (!text) return text;

    // Respect explicit user intent for direct explanations.
    if (isDirectExplanationRequest(userQuery)) {
        return text;
    }

    // Ensure the response ends with one focused Socratic question.
    const hasQuestion = /\?/m.test(text);
    if (hasQuestion) return text;

    return `${text}\n\nQuick check: in your own words, what is the key idea here?`;
}

function mapQueryIntent({ tutorMode, deepResearchMode, classification, query, useWebSearch, useAcademicSearch, criticalThinkingEnabled, useReAct, semanticIntent, isKgRealtimeEnabled }) {
    log.info('CHAT', `[INTENT DEBUG] useWebSearch=${useWebSearch}, useAcademicSearch=${useAcademicSearch}, deepResearchMode=${deepResearchMode}, isKgRealtimeEnabled=${!!isKgRealtimeEnabled}, semanticIntent=${semanticIntent || 'none'}`);
    
    if (tutorMode) return 'tutor';
    if (deepResearchMode === true) return 'research';
    // Issue 1.1: KG toggle is a modifier on top of the standard path — signal it as its own intent
    // so orchestrators/requestContext can enable KG-augmented retrieval.
    if (isKgRealtimeEnabled === true) return 'knowledge_graph';
    if (useWebSearch || useAcademicSearch) {
        log.info('CHAT', `[INTENT DEBUG] Web/Academic search enabled → intent='research'`);
        return 'research';
    }

    // Use semantic routing intent if available
    if (semanticIntent) {
        const semanticToIntent = {
            'DEEP_RESEARCH': 'research',
            'ACADEMIC_SEARCH': 'research',
            'WEB_SEARCH': 'research',
            'TECHNICAL_CODING': 'code',
            'MATHEMATICAL_REASONING': 'complex_reasoning',
            'CONCEPTUAL_EXPLANATION': 'chat',
            'SOCRATIC_TUTORING': 'tutor',
            'DOCUMENT_RAG': 'research',
            'MEMORY_RECALL': 'chat',
            'GREETING': 'chat'
        };
        const mapped = semanticToIntent[semanticIntent];
        if (mapped) {
            log.info('CHAT', `[INTENT DEBUG] Semantic intent ${semanticIntent} → '${mapped}'`);
            return mapped;
        }
    }

    const normalized = String(query || '').toLowerCase();
    const category = String(classification?.category || '').toLowerCase();

    const explicitResearchSignal = /(latest|recent|paper|papers|study|studies|research about|state of the art|scholar|citation)/i.test(normalized);
    if (explicitResearchSignal) return 'research';

    if (category === 'code') return 'code';
    if (useReAct || criticalThinkingEnabled || category === 'reasoning' || category === 'technical') return 'complex_reasoning';
    return 'chat';
}

module.exports = {
    emitTutorKnowledgeEvents,
    streamEvent,
    NON_ACADEMIC_PATTERNS,
    detectNonAcademic,
    doesQuerySuggestRecall,
    TUTOR_MODE_TYPES,
    hasCourseSelection,
    resolveTutorModeType,
    isDirectExplanationRequest,
    enforceGeneralSocraticStyle,
    mapQueryIntent,
};
