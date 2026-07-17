// Manages restricted (buffered) streaming for ToT synthesis
// When enabled, intermediate ToT steps are buffered and only the final synthesis is streamed

const log = require('../utils/logger');

/**
 * Creates a buffered streaming callback that collects step updates
 * without emitting them until synthesis begins
 * @returns {object} Object with streamCallback and flushCallback methods
 */
function createBufferedStreamingManager() {
  const bufferedSteps = [];
  let isFlushed = false;

  return {
    /**
     * Buffered callback to replace streamCallback during planning/execution phases
     * @param {object} update - The step update to buffer
     */
    streamCallback: (update) => {
      if (!isFlushed) {
        bufferedSteps.push(update);
      }
    },

    /**
     * Flushes all buffered steps to the output callback
     * Call this before synthesis begins if you want intermediate steps shown
     * @param {function} realStreamCallback - The actual stream callback
     */
    flushBufferedSteps: (realStreamCallback) => {
      if (!isFlushed && realStreamCallback && typeof realStreamCallback === 'function') {
        bufferedSteps.forEach(step => {
          try {
            realStreamCallback(step);
          } catch (err) {
            log.warn('RestrictedStreaming', `Failed to flush buffered step: ${err.message}`);
          }
        });
      }
      isFlushed = true;
    },

    /**
     * Get all buffered steps (for debugging)
     * @returns {array} Array of buffered step updates
     */
    getBufferedSteps: () => [...bufferedSteps],

    /**
     * Clear buffers (for cleanup)
     */
    reset: () => {
      bufferedSteps.length = 0;
      isFlushed = false;
    }
  };
}

/**
 * Creates a pass-through streaming manager when restriction is disabled
 * @returns {object} Object with streamCallback and flushCallback methods
 */
function createUnrestrictedStreamingManager() {
  return {
    streamCallback: (update) => {
      // In unrestricted mode, this is never called - we stream directly
    },

    flushBufferedSteps: () => {
      // No-op in unrestricted mode
    },

    getBufferedSteps: () => [],

    reset: () => {
      // No-op in unrestricted mode
    }
  };
}

/**
 * Creates appropriate streaming manager based on restriction flag
 * @param {boolean} isRestricted - Whether to enable streaming restriction
 * @returns {object} Streaming manager with streamCallback and flushCallback
 */
function createStreamingManager(isRestricted = false) {
  if (isRestricted) {
    log.info('RestrictedStreaming', 'Restricted streaming mode enabled - intermediate steps will be buffered');
    return createBufferedStreamingManager();
  } else {
    return createUnrestrictedStreamingManager();
  }
}

/**
 * Wraps a synthesis function to ensure proper token streaming handling
 * with restricted streaming mode
 * @param {function} synthesizeFn - The synthesizeFinalAnswer function
 * @param {boolean} isRestricted - Whether restriction is enabled
 * @param {function} streamingManager - The streaming manager
 * @returns {function} Wrapped synthesis function
 */
function createRestrictedSynthesisWrapper(synthesizeFn, isRestricted, streamingManager) {
  return async function restrictedSynthesizeFn(query, context, chatHistory, requestContext, onToken) {
    // Ensure token streaming is passed through for synthesis phase
    if (isRestricted && !onToken) {
      log.warn('RestrictedStreaming', 'Restricted mode enabled but onToken callback is missing - synthesis may not stream');
    }

    // Call the original function with the token callback
    return await synthesizeFn(query, context, chatHistory, requestContext, onToken);
  };
}

module.exports = {
  createBufferedStreamingManager,
  createUnrestrictedStreamingManager,
  createStreamingManager,
  createRestrictedSynthesisWrapper
};
