const log = require('../utils/logger');

function buildMemoryAwareSystemPrompt(contextualMemory, basePrompt = '', tutorMode = false, query = '') {
    const memoryPrompt = contextualMemory?.systemPrompt?.trim();
    const clientPrompt = basePrompt?.trim();
    const queryHint = query?.trim() ? `Use the student's prior knowledge when answering: "${query.trim()}".` : '';

    const components = [];
    if (memoryPrompt) {
        components.push(`## Student Memory Context
${memoryPrompt}`);
    }
    if (clientPrompt) {
        components.push(clientPrompt);
    }
    if (tutorMode && !clientPrompt) {
        components.push('Keep the response tutoring-focused, adaptive, and aligned with the student profile above.');
    }
    if (queryHint) {
        components.push(queryHint);
    }

    const combined = components.join('\n\n').trim();
    return combined || null;
}

function buildPersonalizationContext(contextualMemory, query = '') {
    if (!contextualMemory) return '';
    const memoryBlock = contextualMemory.systemPrompt || contextualMemory.knowledgeContext || '';
    if (!memoryBlock) return '';

    const queryNotice = query?.trim() ? `The student's current question is: "${query.trim()}".` : '';
    return [memoryBlock, queryNotice].filter(Boolean).join('\n\n').trim();
}

module.exports = {
    buildMemoryAwareSystemPrompt,
    buildPersonalizationContext
};
