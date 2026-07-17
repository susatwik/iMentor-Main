/**
 * server/services/contextService.js
 * 
 * Conversation Memory & Context Management
 * 
 * Handles:
 * - Storing and retrieving conversation history
 * - Creating summarized context for long conversations
 * - Tracking student weak concepts
 * - Maintaining topic continuity
 * - Personalizing responses based on history
 */

const ChatHistory = require('../models/ChatHistory');
const log = require('../utils/logger');

/**
 * Save a conversation turn to persistent storage
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {string} role - 'user' or 'assistant'
 * @param {string} message - Message text
 * @param {object} metadata - Optional metadata (topic, confidence, etc.)
 * @returns {Promise<void>}
 */
async function saveConversation(userId, sessionId, role, message, metadata = {}) {
    try {
        const chatHistory = await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $push: {
                    messages: {
                        role,
                        parts: [{ text: message }],
                        timestamp: new Date(),
                        ...metadata
                    }
                },
                $set: { updatedAt: new Date() }
            },
            { upsert: true, new: true }
        );
        return chatHistory;
    } catch (err) {
        log.error('CONTEXT', `Failed to save conversation: ${err.message}`);
        throw err;
    }
}

/**
 * Get recent conversation context (last N messages)
 * Useful for maintaining topic continuity
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {number} limit - Number of recent messages (default 20)
 * @returns {Promise<object>} Context with messages and summary
 */
async function getRecentContext(userId, sessionId, limit = 20) {
    try {
        const chatHistory = await ChatHistory.findOne({ sessionId, userId });
        if (!chatHistory || !chatHistory.messages) {
            return { messages: [], summary: '' };
        }

        // Get last N messages
        const recentMessages = chatHistory.messages.slice(-limit);

        return {
            messages: recentMessages,
            summary: chatHistory.summary || '',
            lastTopic: extractLastTopic(recentMessages),
            weakConcepts: identifyWeakConcepts(recentMessages)
        };
    } catch (err) {
        log.error('CONTEXT', `Failed to get recent context: ${err.message}`);
        return { messages: [], summary: '' };
    }
}

/**
 * Summarize old context when conversation gets too long
 * Uses simple extractive summarization (first approach)
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {number} messageThreshold - Create summary when messages exceed this (default 100)
 * @returns {Promise<string>} Summary text
 */
async function summarizeOldContext(userId, sessionId, messageThreshold = 100) {
    try {
        const chatHistory = await ChatHistory.findOne({ sessionId, userId });
        if (!chatHistory || chatHistory.messages.length <= messageThreshold) {
            return '';
        }

        // Keep last 30 messages, summarize rest
        const oldMessages = chatHistory.messages.slice(0, -30);
        const recentMessages = chatHistory.messages.slice(-30);

        // Extract key topics and student performance from old messages
        const summary = generateConversationSummary(oldMessages);

        // Update the persistent summary
        await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $set: {
                    summary,
                    // Archive old messages (optional)
                    messages: recentMessages
                }
            }
        );

        return summary;
    } catch (err) {
        log.error('CONTEXT', `Failed to summarize context: ${err.message}`);
        return '';
    }
}

/**
 * Extract main topic from recent messages
 * @private
 */
function extractLastTopic(messages) {
    if (!messages || messages.length === 0) return null;

    // Look for assistant messages containing topic hints
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text.toLowerCase();
            // Extract words that likely indicate topics
            const topicKeywords = ['topic', 'concept', 'chapter', 'unit', 'lesson'];
            for (const keyword of topicKeywords) {
                if (text.includes(keyword)) {
                    // Extract the word following the keyword
                    const match = text.match(new RegExp(`${keyword}[:\\s]+([\\w\\s]+?)(?:[.!?]|$)`));
                    if (match) return match[1].trim();
                }
            }
        }
    }

    return null;
}

/**
 * Identify concepts the student struggles with
 * @private
 */
function identifyWeakConcepts(messages) {
    const weakConcepts = [];
    const strugglePhrases = ['i don\'t understand', 'confused', 'can\'t', 'help', 'again', 'wrong'];

    for (const msg of messages) {
        if (msg.role === 'user' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text.toLowerCase();
            if (strugglePhrases.some(phrase => text.includes(phrase))) {
                // Extract potential topic from the message
                const words = text.split(/\s+/).filter(w => w.length > 3);
                weakConcepts.push(...words.slice(0, 3));
            }
        }
    }

    return [...new Set(weakConcepts)].slice(0, 5);
}

/**
 * Generate a summary of conversation
 * @private
 */
function generateConversationSummary(messages) {
    const summaryParts = [];
    
    // Collect all assistant explanations
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text;
            // Take first 100 chars of each significant message
            if (text.length > 50) {
                summaryParts.push(text.substring(0, 100) + '...');
            }
        }
    }

    // Return first 3 key explanations
    return summaryParts.slice(0, 3).join('\n\n');
}

/**
 * Get conversation context formatted for LLM prompt injection
 * Includes recent context + weak concepts + topic continuity hints
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @returns {Promise<string>} Context string for system prompt
 */
async function getFormattedContextForPrompt(userId, sessionId) {
    try {
        const { messages, summary, lastTopic, weakConcepts } = await getRecentContext(userId, sessionId, 15);

        let contextString = '';

        if (summary) {
            contextString += `## Previous Conversation Summary\n${summary}\n\n`;
        }

        if (lastTopic) {
            contextString += `## Current Topic\nWe are discussing: ${lastTopic}\n\n`;
        }

        if (weakConcepts && weakConcepts.length > 0) {
            contextString += `## Student Weak Areas\nThe student struggles with: ${weakConcepts.join(', ')}\nProvide extra clarity on these concepts if they come up.\n\n`;
        }

        if (messages.length > 0) {
            contextString += `## Recent Discussion\n`;
            const recentUserMessages = messages
                .filter(m => m.role === 'user')
                .slice(-3)
                .map(m => `- ${m.parts?.[0]?.text || ''}`)
                .join('\n');
            contextString += recentUserMessages;
        }

        return contextString;
    } catch (err) {
        log.error('CONTEXT', `Failed to format context: ${err.message}`);
        return '';
    }
}

/**
 * Clear old conversations (manual cleanup)
 * 
 * @param {number} daysOld - Delete conversations older than N days
 * @returns {Promise<number>} Number of sessions deleted
 */
async function clearOldConversations(daysOld = 90) {
    try {
        const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
        const result = await ChatHistory.deleteMany({
            updatedAt: { $lt: cutoffDate }
        });
        log.info('CONTEXT', `Cleared ${result.deletedCount} old conversations (>${daysOld} days)`);
        return result.deletedCount;
    } catch (err) {
        log.error('CONTEXT', `Failed to clear old conversations: ${err.message}`);
        return 0;
    }
}

module.exports = {
    saveConversation,
    getRecentContext,
    summarizeOldContext,
    getFormattedContextForPrompt,
    clearOldConversations
};
/**
 * server/services/contextService.js
 * 
 * Conversation Memory & Context Management
 * 
 * Handles:
 * - Storing and retrieving conversation history
 * - Creating summarized context for long conversations
 * - Tracking student weak concepts
 * - Maintaining topic continuity
 * - Personalizing responses based on history
 */

const ChatHistory = require('../models/ChatHistory');
const log = require('../utils/logger');

/**
 * Save a conversation turn to persistent storage
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {string} role - 'user' or 'assistant'
 * @param {string} message - Message text
 * @param {object} metadata - Optional metadata (topic, confidence, etc.)
 * @returns {Promise<void>}
 */
async function saveConversation(userId, sessionId, role, message, metadata = {}) {
    try {
        const chatHistory = await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $push: {
                    messages: {
                        role,
                        parts: [{ text: message }],
                        timestamp: new Date(),
                        ...metadata
                    }
                },
                $set: { updatedAt: new Date() }
            },
            { upsert: true, new: true }
        );
        return chatHistory;
    } catch (err) {
        log.error('CONTEXT', `Failed to save conversation: ${err.message}`);
        throw err;
    }
}

/**
 * Get recent conversation context (last N messages)
 * Useful for maintaining topic continuity
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {number} limit - Number of recent messages (default 20)
 * @returns {Promise<object>} Context with messages and summary
 */
async function getRecentContext(userId, sessionId, limit = 20) {
    try {
        const chatHistory = await ChatHistory.findOne({ sessionId, userId });
        if (!chatHistory || !chatHistory.messages) {
            return { messages: [], summary: '' };
        }

        // Get last N messages
        const recentMessages = chatHistory.messages.slice(-limit);

        return {
            messages: recentMessages,
            summary: chatHistory.summary || '',
            lastTopic: extractLastTopic(recentMessages),
            weakConcepts: identifyWeakConcepts(recentMessages)
        };
    } catch (err) {
        log.error('CONTEXT', `Failed to get recent context: ${err.message}`);
        return { messages: [], summary: '' };
    }
}

/**
 * Summarize old context when conversation gets too long
 * Uses simple extractive summarization (first approach)
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @param {number} messageThreshold - Create summary when messages exceed this (default 100)
 * @returns {Promise<string>} Summary text
 */
async function summarizeOldContext(userId, sessionId, messageThreshold = 100) {
    try {
        const chatHistory = await ChatHistory.findOne({ sessionId, userId });
        if (!chatHistory || chatHistory.messages.length <= messageThreshold) {
            return '';
        }

        // Keep last 30 messages, summarize rest
        const oldMessages = chatHistory.messages.slice(0, -30);
        const recentMessages = chatHistory.messages.slice(-30);

        // Extract key topics and student performance from old messages
        const summary = generateConversationSummary(oldMessages);

        // Update the persistent summary
        await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $set: {
                    summary,
                    // Archive old messages (optional)
                    messages: recentMessages
                }
            }
        );

        return summary;
    } catch (err) {
        log.error('CONTEXT', `Failed to summarize context: ${err.message}`);
        return '';
    }
}

/**
 * Extract main topic from recent messages
 * @private
 */
function extractLastTopic(messages) {
    if (!messages || messages.length === 0) return null;

    // Look for assistant messages containing topic hints
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text.toLowerCase();
            // Extract words that likely indicate topics
            const topicKeywords = ['topic', 'concept', 'chapter', 'unit', 'lesson'];
            for (const keyword of topicKeywords) {
                if (text.includes(keyword)) {
                    // Extract the word following the keyword
                    const match = text.match(new RegExp(`${keyword}[:\\s]+([\\w\\s]+?)(?:[.!?]|$)`));
                    if (match) return match[1].trim();
                }
            }
        }
    }

    return null;
}

/**
 * Identify concepts the student struggles with
 * @private
 */
function identifyWeakConcepts(messages) {
    const weakConcepts = [];
    const strugglePhrases = ['i don\'t understand', 'confused', 'can\'t', 'help', 'again', 'wrong'];

    for (const msg of messages) {
        if (msg.role === 'user' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text.toLowerCase();
            if (strugglePhrases.some(phrase => text.includes(phrase))) {
                // Extract potential topic from the message
                const words = text.split(/\s+/).filter(w => w.length > 3);
                weakConcepts.push(...words.slice(0, 3));
            }
        }
    }

    return [...new Set(weakConcepts)].slice(0, 5);
}

/**
 * Generate a summary of conversation
 * @private
 */
function generateConversationSummary(messages) {
    const summaryParts = [];
    
    // Collect all assistant explanations
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.parts?.[0]?.text) {
            const text = msg.parts[0].text;
            // Take first 100 chars of each significant message
            if (text.length > 50) {
                summaryParts.push(text.substring(0, 100) + '...');
            }
        }
    }

    // Return first 3 key explanations
    return summaryParts.slice(0, 3).join('\n\n');
}

/**
 * Get conversation context formatted for LLM prompt injection
 * Includes recent context + weak concepts + topic continuity hints
 * 
 * @param {string} userId - User ID
 * @param {string} sessionId - Chat session ID
 * @returns {Promise<string>} Context string for system prompt
 */
async function getFormattedContextForPrompt(userId, sessionId) {
    try {
        const { messages, summary, lastTopic, weakConcepts } = await getRecentContext(userId, sessionId, 15);

        let contextString = '';

        if (summary) {
            contextString += `## Previous Conversation Summary\n${summary}\n\n`;
        }

        if (lastTopic) {
            contextString += `## Current Topic\nWe are discussing: ${lastTopic}\n\n`;
        }

        if (weakConcepts && weakConcepts.length > 0) {
            contextString += `## Student Weak Areas\nThe student struggles with: ${weakConcepts.join(', ')}\nProvide extra clarity on these concepts if they come up.\n\n`;
        }

        if (messages.length > 0) {
            contextString += `## Recent Discussion\n`;
            const recentUserMessages = messages
                .filter(m => m.role === 'user')
                .slice(-3)
                .map(m => `- ${m.parts?.[0]?.text || ''}`)
                .join('\n');
            contextString += recentUserMessages;
        }

        return contextString;
    } catch (err) {
        log.error('CONTEXT', `Failed to format context: ${err.message}`);
        return '';
    }
}

/**
 * Clear old conversations (manual cleanup)
 * 
 * @param {number} daysOld - Delete conversations older than N days
 * @returns {Promise<number>} Number of sessions deleted
 */
async function clearOldConversations(daysOld = 90) {
    try {
        const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
        const result = await ChatHistory.deleteMany({
            updatedAt: { $lt: cutoffDate }
        });
        log.info('CONTEXT', `Cleared ${result.deletedCount} old conversations (>${daysOld} days)`);
        return result.deletedCount;
    } catch (err) {
        log.error('CONTEXT', `Failed to clear old conversations: ${err.message}`);
        return 0;
    }
}

module.exports = {
    saveConversation,
    getRecentContext,
    summarizeOldContext,
    getFormattedContextForPrompt,
    clearOldConversations
};
