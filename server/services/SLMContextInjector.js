/**
 * Model Cache & Context Injector
 * Implements Task 2.5.3: Pre-loading specialized templates
 */

/**
 * Modifies an Ollama payload to inject course-specific system constraints 
 * overriding the default Modelfile parameters for a specific query context.
 */
function injectSLMContext(ollamaPayload, courseContext, sessionType) {
    if (!courseContext) return ollamaPayload;

    console.log(`[SLMContext] Injecting dynamic constraints for [${courseContext}] in mode: ${sessionType}`);

    // If it's a critical thinking request acting on a course, enforce strict factual grounding
    let dynamicSystemPrompt = `You are the authoritative voice for ${courseContext}. Provide highly academic, referenced answers.`;

    if (sessionType === 'socratic') {
        dynamicSystemPrompt += ` Do NOT provide direct answers. Ask leading questions.`;
    }

    // Attempt to locate a system prompt in the history payload and overwrite it
    const messages = ollamaPayload.messages || [];
    let systemInjected = false;

    for (let msg of messages) {
        if (msg.role === 'system') {
            msg.content = dynamicSystemPrompt + "\n" + msg.content;
            systemInjected = true;
            break;
        }
    }

    if (!systemInjected) {
        messages.unshift({ role: 'system', content: dynamicSystemPrompt });
    }

    return {
        ...ollamaPayload,
        messages,
        options: {
            ...ollamaPayload.options,
            temperature: sessionType === 'socratic' ? 0.7 : 0.2 // Tighter on general, creative on socratic
        }
    };
}

module.exports = {
    injectSLMContext
};
