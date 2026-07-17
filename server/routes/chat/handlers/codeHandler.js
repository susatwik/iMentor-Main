// server/routes/chat/handlers/codeHandler.js
// Code-intent queries are answered normally by the standard handler.
// This handler only annotates the context so the standard handler can
// append a helpful "💡 Tip" about the Code Executor — it never intercepts
// or short-circuits the response.

/**
 * Always returns false — allows the request to continue to the next handler.
 * Attaches a ctx flag so standardHandler can append a Code Executor tip
 * at the end of its real response.
 *
 * @param {object} res  - Express response (unused here)
 * @param {object} ctx  - Request context built by index.js
 */
async function handle(res, ctx) {
    const { queryIntent, tutorMode } = ctx;

    // Tag the context so standardHandler can append the tip
    if (queryIntent === 'code' && !tutorMode) {
        ctx.appendCodeExecutorTip = true;
    }

    // Always fall through — never intercept
    return false;
}

module.exports = { handle };
