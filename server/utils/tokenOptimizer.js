// server/utils/tokenOptimizer.js
const log = require('./logger');

const ABBREVIATIONS = {
    'w/': 'with',
    'w/o': 'without',
    'esp': 'especially',
    'msg': 'message',
    'msgs': 'messages',
    'info': 'information',
    'approx': 'approximately',
    'defn': 'definition',
    'ctx': 'context',
    'db': 'database',
    'configs': 'configurations',
    'config': 'configuration',
    'params': 'parameters',
    'param': 'parameter',
    'impl': 'implementation',
    'char': 'character',
    'chars': 'characters',
    'doc': 'document',
    'docs': 'documents'
};

/**
 * Helper to preserve case when expanding abbreviations.
 */
function getCasePreservedExpansion(match, full) {
    const letters = match.replace(/[^a-zA-Z]/g, '');
    if (letters.length === 0) return full;

    if (letters === letters.toUpperCase()) {
        // If it's a single letter (e.g., "W/" -> "With"), default to capitalized
        if (letters.length === 1) {
            return full.charAt(0).toUpperCase() + full.slice(1).toLowerCase();
        }
        return full.toUpperCase();
    }
    if (letters[0] === letters[0].toUpperCase()) {
        return full.charAt(0).toUpperCase() + full.slice(1).toLowerCase();
    }
    return full.toLowerCase();
}

/**
 * Expand abbreviated text to its full form, preserving code blocks.
 */
function expandText(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;

    // Expand w/o and w/ preserving case
    result = result.replace(/\bw\/o\b/gi, (match) => getCasePreservedExpansion(match, 'without'));
    result = result.replace(/\bw\/(?!\w)/gi, (match) => getCasePreservedExpansion(match, 'with'));

    // For other abbreviations, use a word-boundary regex replacement preserving case
    for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
        if (abbr === 'w/' || abbr === 'w/o') continue;
        const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
        result = result.replace(regex, (match) => getCasePreservedExpansion(match, full));
    }

    return result;
}

/**
 * Helper to recursively traverse and expand JSON string values only, leaving keys intact.
 */
function expandJsonValues(obj) {
    if (typeof obj === 'string') {
        return expandText(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => expandJsonValues(item));
    }
    if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (const [key, value] of Object.entries(obj)) {
            newObj[key] = expandJsonValues(value);
        }
        return newObj;
    }
    return obj;
}

/**
 * Safely expands the outgoing response text by protecting code blocks
 * and only replacing abbreviations outside of code blocks.
 * Also automatically parses raw JSON blocks to only expand JSON string values,
 * ensuring no structural JSON keys are broken.
 */
function expandOutgoingResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') return responseText;

    const trimmed = responseText.trim();
    // Check if the entire response is a JSON block
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const parsed = JSON.parse(trimmed);
            const expandedObj = expandJsonValues(parsed);
            return JSON.stringify(expandedObj);
        } catch (e) {
            // Not valid JSON or failed to parse, fall back to standard code block split
        }
    }

    const parts = responseText.split('```');
    for (let i = 0; i < parts.length; i++) {
        // Even indices are outside of code blocks
        if (i % 2 === 0) {
            parts[i] = expandText(parts[i]);
        }
    }
    return parts.join('```');
}

/**
 * Minifies prompt text by removing unnecessary whitespaces, duplicate newlines,
 * and comments, while protecting code block content.
 */
function minifyPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') return prompt;

    const lines = prompt.split('\n');
    const minifiedLines = [];
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Handle code block boundaries
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            minifiedLines.push(line.trim());
            continue;
        }

        if (inCodeBlock) {
            // Keep code blocks intact
            minifiedLines.push(line);
        } else {
            // First strip HTML/Markdown comments: <!-- ... -->
            let minifiedLine = line.replace(/<!--[\s\S]*?-->/g, '');

            // Trim leading/trailing whitespace
            minifiedLine = minifiedLine.trim();

            // Collapse multiple spaces/tabs into a single space
            minifiedLine = minifiedLine.replace(/[ \t]+/g, ' ');

            if (minifiedLine !== '') {
                minifiedLines.push(minifiedLine);
            } else {
                // Keep at most one consecutive empty line to maintain readability/paragraphs
                if (minifiedLines.length > 0 && minifiedLines[minifiedLines.length - 1] !== '') {
                    minifiedLines.push('');
                }
            }
        }
    }

    let result = minifiedLines.join('\n');
    // Collapse triple or more newlines to double newlines
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

/**
 * Optimizes chat history or message lists for transmission.
 */
function optimizeIncomingMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(msg => {
        if (!msg) return msg;
        const newMsg = { ...msg };
        if (typeof newMsg.content === 'string') {
            newMsg.content = minifyPrompt(newMsg.content);
        }
        if (Array.isArray(newMsg.parts)) {
            newMsg.parts = newMsg.parts.map(part => {
                if (part && typeof part.text === 'string') {
                    return { ...part, text: minifyPrompt(part.text) };
                }
                return part;
            });
        }
        if (typeof newMsg.text === 'string') {
            newMsg.text = minifyPrompt(newMsg.text);
        }
        return newMsg;
    });
}

/**
 * Injects token optimization instructions into the system prompt.
 */
function injectSystemInstruction(systemPrompt = '') {
    const instruction = `\n[TOKEN_SAVING_MODE: ACTIVE. To optimize latency/costs, always use these abbreviations in non-code text: 'w/' for 'with', 'w/o' for 'without', 'esp' for 'especially', 'msg' for 'message', 'msgs' for 'messages', 'info' for 'information', 'approx' for 'approximately', 'defn' for 'definition', 'ctx' for 'context', 'db' for 'database', 'config' for 'configuration', 'configs' for 'configurations', 'param' for 'parameter', 'params' for 'parameters', 'impl' for 'implementation', 'char' for 'character', 'chars' for 'characters', 'doc' for 'document', 'docs' for 'documents'. If returning JSON, always output it in minified/compact form without any newlines or indentation. Do not use conversational filler or greetings. Keep response text compact, dense, and factual.]`;
    return systemPrompt ? `${systemPrompt}\n${instruction}` : instruction;
}

/**
 * Stateful helper to expand stream chunks on the fly.
 */
class StreamingTokenExpander {
    constructor(onToken) {
        this.onToken = onToken;
        this.buffer = '';
        this.inCodeBlock = false;
    }

    processChunk(chunk) {
        if (!chunk) return;
        this.buffer += chunk;

        let output = '';

        while (true) {
            if (this.inCodeBlock) {
                const index = this.buffer.indexOf('```');
                if (index !== -1) {
                    output += this.buffer.substring(0, index + 3);
                    this.buffer = this.buffer.substring(index + 3);
                    this.inCodeBlock = false;
                } else {
                    if (this.buffer.length > 3) {
                        const safeLen = this.buffer.length - 3;
                        output += this.buffer.substring(0, safeLen);
                        this.buffer = this.buffer.substring(safeLen);
                    }
                    break;
                }
            } else {
                const index = this.buffer.indexOf('```');
                let textToProcess = '';
                let remaining = '';

                if (index !== -1) {
                    textToProcess = this.buffer.substring(0, index);
                    remaining = this.buffer.substring(index);
                } else {
                    // Check if buffer ends with backticks that could form a code block marker
                    let backtickLen = 0;
                    if (this.buffer.endsWith('``')) {
                        backtickLen = 2;
                    } else if (this.buffer.endsWith('`')) {
                        backtickLen = 1;
                    }

                    // Temporarily look at buffer without trailing backticks
                    const bufferToSearch = backtickLen > 0 ? this.buffer.substring(0, this.buffer.length - backtickLen) : this.buffer;

                    // Find the last word separator (whitespace or common punctuation)
                    const lastSep = Math.max(
                        bufferToSearch.lastIndexOf(' '),
                        bufferToSearch.lastIndexOf('\n'),
                        bufferToSearch.lastIndexOf('\t'),
                        bufferToSearch.lastIndexOf('.'),
                        bufferToSearch.lastIndexOf(','),
                        bufferToSearch.lastIndexOf('!'),
                        bufferToSearch.lastIndexOf('?'),
                        bufferToSearch.lastIndexOf(';'),
                        bufferToSearch.lastIndexOf(':'),
                        bufferToSearch.lastIndexOf('-'),
                        bufferToSearch.lastIndexOf('/')
                    );

                    if (lastSep !== -1) {
                        textToProcess = this.buffer.substring(0, lastSep + 1);
                        remaining = this.buffer.substring(lastSep + 1);
                    } else {
                        // If no separator is found but buffer is excessively long, force process
                        if (this.buffer.length > 512) {
                            textToProcess = this.buffer;
                            remaining = '';
                        } else {
                            break;
                        }
                    }
                }

                const expanded = expandText(textToProcess);
                output += expanded;
                this.buffer = remaining;

                if (index !== -1) {
                    output += '```';
                    this.buffer = this.buffer.substring(3);
                    this.inCodeBlock = true;
                }
            }
        }

        if (output) {
            this.onToken(output);
        }
    }

    flush() {
        let finalOutput = '';
        if (this.inCodeBlock) {
            finalOutput += this.buffer;
        } else {
            finalOutput += expandText(this.buffer);
        }
        this.buffer = '';
        if (finalOutput) {
            this.onToken(finalOutput);
        }
    }
}

module.exports = {
    minifyPrompt,
    optimizeIncomingMessages,
    injectSystemInstruction,
    expandOutgoingResponse,
    StreamingTokenExpander
};
