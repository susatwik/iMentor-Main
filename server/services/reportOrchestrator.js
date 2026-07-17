// server/services/reportOrchestrator.js
const { z } = require('zod');
const socraticTutorService = require('./socraticTutorService');
const log = require('../utils/logger');

// ── Zod Validation Schemas ───────────────────────────────────────────────────

const PlanSchema = z.object({
    sections: z.array(z.object({
        title: z.string(),
        subsections: z.array(z.string())
    }))
});

const WriteBulletsSchema = z.object({
    bullets: z.array(z.string())
});

// CriticAgent sometimes returns objects instead of strings in `revised`.
// Accept either shape and normalise to a plain string after parsing.
const RevisedItemSchema = z.union([
    z.string(),
    z.object({}).passthrough()
]);

const CritiqueBulletsSchema = z.object({
    approved: z.array(z.string()),
    revised: z.array(RevisedItemSchema),
    // LLM sometimes omits `flagged` when there are no hallucinations — default to [] instead of failing
    flagged: z.array(z.string()).optional().default([])
});

/**
 * Normalises a single item from the CriticAgent's `revised` array.
 * If the LLM returns an object instead of a string, we extract a text field or
 * fall back to JSON.stringify so we never silently lose content.
 */
function normaliseRevisedItem(item) {
    if (typeof item === 'string') return item;
    // Common object shapes: { text: '...' }, { content: '...' }, { bullet: '...' }, { revised: '...' }
    for (const key of ['text', 'content', 'bullet', 'revised', 'value']) {
        if (typeof item[key] === 'string' && item[key].trim()) return item[key];
    }
    // Last resort — stringify it (at least preserves the data)
    return JSON.stringify(item);
}

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Extracts and parses JSON from raw LLM output, then validates against a zod schema.
 */
function extractAndParseJSON(text, schema) {
    const jsonMatch = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        throw new Error('No JSON block found in response');
    }
    const rawJson = jsonMatch[0];
    try {
        const parsed = JSON.parse(rawJson);
        return schema.parse(parsed);
    } catch (parseError) {
        try {
            // Attempt to escape unescaped backslashes (common in LaTeX formulas)
            const repaired = rawJson.replace(/\\(?!["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
            const parsed = JSON.parse(repaired);
            return schema.parse(parsed);
        } catch (_) {
            throw parseError; // Throw the original parse error if repair attempt fails
        }
    }
}

/**
 * Executes a call with fallback and performs validation, with a single retry on failure.
 */
async function callAgentWithValidation(chatHistory, currentQuery, systemPrompt, llmConfig, schema, contextInfo = "") {
    // Ensure we instruct sglang (if enabled) to use the heavy model via llmConfig
    const config = { sglangEndpoint: 'heavy', ...llmConfig };
    
    try {
        const responseText = await socraticTutorService.generateWithFallback(
            chatHistory,
            currentQuery,
            systemPrompt,
            config
        );
        return extractAndParseJSON(responseText, schema);
    } catch (firstError) {
        log.warn('REPORT', `Failed first attempt for ${contextInfo}: ${firstError.message}. Retrying once with stricter prompt.`);
        
        // Retry once with stricter formatting instruction
        const strictQuery = `${currentQuery}\n\nIMPORTANT: Return ONLY the JSON object. Do not include any markdown formatting (such as \`\`\`json), no preamble, no markdown code blocks, and no extra text.`;
        try {
            const responseText = await socraticTutorService.generateWithFallback(
                chatHistory,
                strictQuery,
                "You are a strict data-output agent. Respond with ONLY valid JSON.",
                config
            );
            return extractAndParseJSON(responseText, schema);
        } catch (retryError) {
            log.error('REPORT', `Failed retry attempt for ${contextInfo}: ${retryError.message}`);
            throw new Error(`Agent call failed validation for ${contextInfo} after retry: ${retryError.message}`);
        }
    }
}

/**
 * Resolve a planner-generated subsection title to a real subtopicId/topicId.
 */
async function resolveSubtopicId(courseName, subsectionTitle) {
    if (!courseName || !subsectionTitle) return null;
    try {
        const structure = await socraticTutorService.getCurriculumStructure(courseName);
        if (!structure || !structure.modules) return null;

        const subTitleLower = subsectionTitle.toLowerCase().trim();

        // 1. Exact case-insensitive match for subtopic names
        for (const mod of structure.modules) {
            for (const topic of (mod.topics || [])) {
                const subtopics = topic.subtopics || topic.prerequisites || [];
                for (const sub of subtopics) {
                    if (sub.name && sub.name.toLowerCase().trim() === subTitleLower) {
                        log.info('REPORT', `Resolved exact subtopic match: "${sub.name}" (ID: ${sub.id})`);
                        return { subtopicId: sub.id, topicId: topic.id };
                    }
                }
            }
        }

        // 2. Strict token-overlap match for subtopics
        const STOP_WORDS = new Set([
            'and', 'or', 'to', 'in', 'of', 'the', 'a', 'an', 'for', 'with', 'on', 'at', 'by', 'from', 'about', 'as',
            'learning', 'machine', 'data', 'model', 'models', 'algorithm', 'algorithms', 'introduction',
            'concept', 'concepts', 'method', 'methods', 'technique', 'techniques', 'impl', 'implementation',
            'implementations', 'module', 'topic', 'subtopic'
        ]);
        function getCleanWords(str) {
            return str.toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 0 && !STOP_WORDS.has(w));
        }

        const plannerWords = getCleanWords(subsectionTitle);
        let bestSubtopicMatch = null;
        let bestSubtopicScore = -1;

        if (plannerWords.length > 0) {
            for (const mod of structure.modules) {
                for (const topic of (mod.topics || [])) {
                    const subtopics = topic.subtopics || topic.prerequisites || [];
                    for (const sub of subtopics) {
                        if (sub.name) {
                            const subWords = getCleanWords(sub.name);
                            if (subWords.length > 0) {
                                const intersection = subWords.filter(w => plannerWords.includes(w));
                                if (intersection.length > 0) {
                                    const overlapRatioSub = intersection.length / subWords.length;
                                    const overlapRatioPlanner = intersection.length / plannerWords.length;
                                    
                                    // Match criteria:
                                    // - One title is a whole-word subset of the other (ratio === 1.0)
                                    // - OR both have > 50% overlap of clean words.
                                    const isSubset = overlapRatioSub === 1.0 || overlapRatioPlanner === 1.0;
                                    const isStrongOverlap = overlapRatioSub > 0.5 && overlapRatioPlanner > 0.5;

                                    if (isSubset || isStrongOverlap) {
                                        // Rank by number of matching words first, then combined overlap ratios
                                        const score = intersection.length * 10 + (overlapRatioSub + overlapRatioPlanner);
                                        if (score > bestSubtopicScore) {
                                            bestSubtopicScore = score;
                                            bestSubtopicMatch = {
                                                subtopicId: sub.id,
                                                topicId: topic.id,
                                                name: sub.name,
                                                intersectionLength: intersection.length,
                                                overlapRatioSub,
                                                overlapRatioPlanner
                                            };
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (bestSubtopicMatch) {
            log.info('REPORT', `Resolved strict subtopic match: "${bestSubtopicMatch.name}" (ID: ${bestSubtopicMatch.subtopicId}) for "${subsectionTitle}" (Overlap: ${bestSubtopicMatch.intersectionLength} words, ratios: sub=${bestSubtopicMatch.overlapRatioSub.toFixed(2)}, planner=${bestSubtopicMatch.overlapRatioPlanner.toFixed(2)})`);
            return { subtopicId: bestSubtopicMatch.subtopicId, topicId: bestSubtopicMatch.topicId };
        }

        // 3. Match against topic names as fallback
        for (const mod of structure.modules) {
            for (const topic of (mod.topics || [])) {
                if (topic.name) {
                    const nameLower = topic.name.toLowerCase().trim();
                    if (nameLower === subTitleLower) {
                        log.info('REPORT', `Resolved exact topic match: "${topic.name}" (ID: ${topic.id}) for "${subsectionTitle}"`);
                        return { topicId: topic.id };
                    }
                }
            }
        }

        let bestTopicMatch = null;
        let bestTopicScore = -1;

        if (plannerWords.length > 0) {
            for (const mod of structure.modules) {
                for (const topic of (mod.topics || [])) {
                    if (topic.name) {
                        const topicWords = getCleanWords(topic.name);
                        if (topicWords.length > 0) {
                            const intersection = topicWords.filter(w => plannerWords.includes(w));
                            if (intersection.length > 0) {
                                const overlapRatioTopic = intersection.length / topicWords.length;
                                const overlapRatioPlanner = intersection.length / plannerWords.length;
                                const isSubset = overlapRatioTopic === 1.0 || overlapRatioPlanner === 1.0;
                                const isStrongOverlap = overlapRatioTopic > 0.5 && overlapRatioPlanner > 0.5;

                                if (isSubset || isStrongOverlap) {
                                    const score = intersection.length * 10 + (overlapRatioTopic + overlapRatioPlanner);
                                    if (score > bestTopicScore) {
                                        bestTopicScore = score;
                                        bestTopicMatch = {
                                            topicId: topic.id,
                                            name: topic.name,
                                            intersectionLength: intersection.length,
                                            overlapRatioTopic,
                                            overlapRatioPlanner
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (bestTopicMatch) {
            log.info('REPORT', `Resolved strict topic match: "${bestTopicMatch.name}" (ID: ${bestTopicMatch.topicId}) for "${subsectionTitle}" (Overlap: ${bestTopicMatch.intersectionLength} words, ratios: topic=${bestTopicMatch.overlapRatioTopic.toFixed(2)}, planner=${bestTopicMatch.overlapRatioPlanner.toFixed(2)})`);
            return { topicId: bestTopicMatch.topicId };
        }

        log.info('REPORT', `No match resolved in curriculum for "${subsectionTitle}"`);
        return null;
    } catch (err) {
        log.warn('REPORT', `Error resolving subtopic ID for "${subsectionTitle}": ${err.message}`);
        return null;
    }
}

/**
 * Splits and groups planned sections so that every subsection in a section shares
 * the same real parent topic in the curriculum tree. If subsections in a planned
 * section have different parent topics, they are split into separate sections.
 */
async function splitAndAlignSectionsByCurriculum(sections, courseName) {
    if (!sections || sections.length === 0) return sections;
    try {
        const structure = await socraticTutorService.getCurriculumStructure(courseName);
        if (!structure || !structure.modules) return sections;

        // Map subtopic names (lowercase, trimmed) to their parent topic names
        const subtopicToTopicMap = new Map();
        for (const mod of structure.modules) {
            for (const topic of (mod.topics || [])) {
                const subtopics = topic.subtopics || topic.prerequisites || [];
                for (const sub of subtopics) {
                    if (sub.name) {
                        subtopicToTopicMap.set(sub.name.toLowerCase().trim(), topic.name);
                    }
                }
            }
        }

        const newSections = [];

        for (const sec of sections) {
            const subsections = sec.subsections || [];
            if (subsections.length === 0) continue;

            // Group subsections by their parent topic
            const groups = new Map();
            for (const sub of subsections) {
                const parentTopic = subtopicToTopicMap.get(sub.toLowerCase().trim());
                const key = parentTopic ? parentTopic.trim() : `fallback:${sub.trim()}`;
                if (!groups.has(key)) {
                    groups.set(key, []);
                }
                groups.get(key).push(sub);
            }

            // Create new sections from each parent topic group
            for (const [topicKey, subs] of groups.entries()) {
                let sectionTitle;
                if (topicKey.startsWith('fallback:')) {
                    sectionTitle = topicKey.substring('fallback:'.length);
                } else {
                    sectionTitle = topicKey;
                }

                newSections.push({
                    title: sectionTitle,
                    subsections: subs
                });
            }
        }

        return newSections;
    } catch (err) {
        log.warn('REPORT', `Error splitting and aligning sections: ${err.message}`);
        return sections;
    }
}

// ── Agent 1: PlannerAgent ────────────────────────────────────────────────────

async function planSections(userIntent, courseContext, validSubtopicTitles, llmConfig) {
    const systemPrompt = "You are an expert curriculum designer. Given a user's intent and the course context, break down the requested report into logical sections and subsections. Section titles must be highly descriptive, written in Title Case, and should match real curriculum topic names where possible. Return ONLY valid JSON.";

    // Build the allowlist block to inject into the prompt
    const allowlistBlock = validSubtopicTitles && validSubtopicTitles.length > 0
        ? `\nALLOWED SUBSECTION TITLES (you MUST use ONLY titles from this list for all subsections — do not invent new titles):\n${validSubtopicTitles.map(t => `  - ${t}`).join('\n')}`
        : '';

    const query = `User Intent: ${userIntent}
Course Outline Context:
${courseContext}
${allowlistBlock}

Task:
Produce a detailed plan of sections and subsections for the report.
You may freely choose section (top-level) titles that organise the content logically.
Section titles MUST be written in Title Case (e.g., "Model Evaluation Techniques", not "assessments" or "evaluation") and be descriptive, matching real curriculum topic names (from the Course Outline Context above) where possible.
However, every subsection title MUST be copied EXACTLY (word-for-word) from the ALLOWED SUBSECTION TITLES list above.
Do not paraphrase, abbreviate, or invent subsection titles that are not on that list.
Return ONLY valid JSON matching this schema:
{
  "sections": [
    {
      "title": "Descriptive Section Title in Title Case",
      "subsections": ["Exact Allowed Subsection Title 1", "Exact Allowed Subsection Title 2"]
    }
  ]
}`;

    // Always use the largest available Groq model for planning so the full allowlist fits
    // in the context window and coverage is maximised. Other agents can stay on the cheaper
    // 8b model for speed/cost.
    const plannerConfig = {
        ...llmConfig,
        groqModel: 'llama-3.3-70b-versatile',
    };
    return callAgentWithValidation([], query, systemPrompt, plannerConfig, PlanSchema, "PlannerAgent");
}

// ── Agent 2: WriterAgent ─────────────────────────────────────────────────────

async function writeBullets(subsectionTitle, courseName, subtopicId, topicId, courseContext, llmConfig) {
    let groundTruth = "";
    let matchedContext = null;

    if (courseName && (subtopicId || topicId)) {
        try {
            matchedContext = await socraticTutorService.getSubtopicContext(courseName, subtopicId, topicId);
        } catch (ctxErr) {
            log.warn('REPORT', `Could not fetch subtopic context for ${subtopicId}/${topicId}: ${ctxErr.message}`);
        }
    }

    if (matchedContext) {
        if (matchedContext.teaching_notes?.teaching_context) {
            groundTruth = matchedContext.teaching_notes.teaching_context;
        } else if (matchedContext.qdrant_chunks?.length > 0) {
            groundTruth = matchedContext.qdrant_chunks.map(c => c.text).join('\n\n');
        }
    }

    if (!groundTruth || groundTruth.trim().length === 0) {
        throw new Error(`No specific teaching context (STN or Qdrant) found for "${subsectionTitle}". Skipping to avoid empty or meta curriculum content.`);
    }

    const systemPrompt = "You are an assistant that summarizes course content into precise, teaching-focused bullet points explaining concepts. Ground your output ONLY in the provided ground truth context. Do not use outside knowledge. Return ONLY valid JSON.";
    const query = `Subsection Title: ${subsectionTitle}
Context Ground Truth:
${groundTruth}

Task:
Write 4 to 6 precise, fact-based bullet points explaining this subsection conceptually.
Ground them ONLY in the provided Context Ground Truth above. Do not hallucinate or include outside information.

CRITICAL INSTRUCTIONS:
- Explain what the concepts actually MEAN and how they work.
- Do NOT write meta-statements about the curriculum structure, hierarchy, modules, or topics (e.g. do NOT say "this is discussed in Module 2", "Module 1 covers X", "X is a topic in this course"). Ignore module/topic metadata in the context.
- NEGATIVE EXAMPLE: Do NOT write bullets like "X is covered in Module N" or "Y is a topic under Z". Instead, write what X actually IS (e.g., "X is a technique that...").

Return ONLY valid JSON matching this schema:
{
  "bullets": [
    "Concept-focused point 1 explaining the definition/mechanics",
    "Concept-focused point 2 explaining another detail"
  ]
}`;

    const parsed = await callAgentWithValidation([], query, systemPrompt, llmConfig, WriteBulletsSchema, `WriterAgent (${subsectionTitle})`);
    return {
        bullets: parsed.bullets,
        groundTruth
    };
}

// ── Agent 3: CriticAgent ─────────────────────────────────────────────────────

async function critiqueBullets(bullets, groundTruth, llmConfig) {
    const systemPrompt = "You are a factual accuracy checker. Compare each bullet point against the ground truth context. Return ONLY valid JSON. In the 'revised' list, you MUST return ONLY the final corrected bullet text itself, without any explanation of changes, reasoning, or meta-commentary.";
    const query = `Bullet Points to evaluate:
${bullets.map((b, idx) => `${idx + 1}. ${b}`).join('\n')}

Ground Truth Context:
${groundTruth}

Task:
Evaluate each bullet point and categorize them. Every bullet point must be classified into EXACTLY ONE of the following three categories (do not place a bullet or a variation of it in more than one category):

1. "approved": The bullet is factually supported by the Ground Truth.
   - Note: If a bullet is factually correct and clear, approve it as-is. Do NOT make trivial, cosmetic, or stylistic revisions (such as changing "described" to "explained" or minor punctuation tweaks).

2. "revised": The bullet is factually supported but has a clear factual inaccuracy, incorrect terminology, or serious clarity issue that requires correction.
   - In this list, you MUST provide ONLY the final corrected bullet text itself.
   - Do NOT include any parenthetical remarks, explanations, notes, or meta-commentary detailing what was changed (e.g. do NOT write "(minor correction)", "Original had...", or "(comma added)").

3. "flagged": The bullet is hallucinated, contradicts the Ground Truth, or has no support whatsoever in the Ground Truth (these will be dropped entirely).

Return ONLY valid JSON matching this schema:
{
  "approved": ["Exact original bullet text"],
  "revised": ["Final corrected bullet text only"],
  "flagged": ["Flagged bullet text to be deleted"]
}`;

    return callAgentWithValidation([], query, systemPrompt, llmConfig, CritiqueBulletsSchema, "CriticAgent");
}

// ── Agent 4: ExpanderAgent ───────────────────────────────────────────────────

async function expandToParagraph(finalBullets, subsectionTitle, llmConfig) {
    const systemPrompt = "You are an expert academic writer. Synthesize the provided bullets into a cohesive, professional paragraph.";
    const query = `Subsection Title: ${subsectionTitle}
Bullets to expand:
${finalBullets.map(b => `- ${b}`).join('\n')}

Task:
Write a cohesive paragraph of 3-6 sentences incorporating all facts in the bullets.
Do not invent any new facts or claims outside of the provided bullets.
Do not include any bullet points or markdown list syntax. Output only the paragraphs.`;

    const config = { sglangEndpoint: 'heavy', ...llmConfig };
    try {
        const responseText = await socraticTutorService.generateWithFallback(
            [],
            query,
            systemPrompt,
            config
        );
        return responseText.trim();
    } catch (err) {
        log.error('REPORT', `ExpanderAgent failed for '${subsectionTitle}': ${err.message}`);
        throw err;
    }
}

// ── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Generate a multi-agent structured report based on user intent and course curriculum.
 *
 * @param {string}   userIntent  - User's goal or intent
 * @param {string}   courseName  - Name of the course
 * @param {object}   llmConfig   - LLM configuration parameters
 * @param {function} onProgress  - Progress status callback
 * @returns {Promise<object>}    - { sections, warnings }
 */
async function generateReport(userIntent, courseName, llmConfig, onProgress) {
    const warnings = [];
    const reportData = { sections: [], warnings };

    try {
        if (onProgress) onProgress("Loading course curriculum structure...");
        const structure = await socraticTutorService.getCurriculumStructure(courseName);
        
        // Build general course outline context from modules/topics/subtopics
        let courseContext = "";
        
        // Guard: if the RAG service is down AND Redis has no cached structure, we have no
        // curriculum data at all. Proceeding with an empty allowlist would let the planner
        // hallucinate freely, producing an entirely unconstrained report. Fail fast instead.
        const hasModules = structure && structure.modules && structure.modules.length > 0;
        if (!hasModules) {
            throw new Error(
                `Cannot generate report: curriculum structure for "${courseName}" is unavailable ` +
                `(RAG service may be down and Redis cache is cold). Please ensure the Python RAG ` +
                `service is running at ${process.env.PYTHON_RAG_SERVICE_URL || '(PYTHON_RAG_SERVICE_URL not set)'}.`
            );
        }

        courseContext = structure.modules.map(mod => {
            const topicsStr = (mod.topics || []).map(t => {
                const subtopics = t.subtopics || t.prerequisites || [];
                const subtopicsStr = subtopics.map(s => `      - ${s.name}`).join('\n');
                return `    - Topic: ${t.name}\n${subtopicsStr}`;
            }).join('\n');
            return `  - Module: ${mod.name}\n${topicsStr}`;
        }).join('\n');

        // Build an allowlist of ONLY subtopics that have confirmed STN (teaching) content.
        // Topic-header nodes are intentionally excluded: they have no STN text, so any
        // planner title matched to them would produce filler/structural context.
        // We probe the STN cache for each subtopic using a lightweight HEAD-style GET
        // (same endpoint getSubtopicContext uses) and keep only cache-HIT subtopics.
        const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
        const validSubtopicTitles = [];
        const allSubtopicNames = [];
        let stnHitCount = 0, stnMissCount = 0;

        // Exclude practice-oriented, case study, and wrap-up placeholders from actual concepts
        const EXCLUDED_SUBTOPIC_NAMES = new Set(['tutorial', 'numericals', 'case studies', 'end-to-end ml pipeline']);

        for (const mod of structure.modules) {
            for (const topic of (mod.topics || [])) {
                const subtopics = topic.subtopics || topic.prerequisites || [];
                for (const sub of subtopics) {
                    if (!sub.name || !sub.id) continue;
                    const cleanName = sub.name.toLowerCase().trim();
                    if (EXCLUDED_SUBTOPIC_NAMES.has(cleanName)) {
                        continue;
                    }
                    allSubtopicNames.push(sub.name);
                }
            }
        }

        if (pythonServiceUrl && allSubtopicNames.length > 0) {
            const axios = require('axios');
            for (const mod of structure.modules) {
                for (const topic of (mod.topics || [])) {
                    const subtopics = topic.subtopics || topic.prerequisites || [];
                    for (const sub of subtopics) {
                        if (!sub.name || !sub.id) continue;
                        const cleanName = sub.name.toLowerCase().trim();
                        if (EXCLUDED_SUBTOPIC_NAMES.has(cleanName)) {
                            continue;
                        }
                        try {
                            // Probe STN cache — fast path only (3 s timeout)
                            const stnUrl = `${pythonServiceUrl}/stn/${encodeURIComponent(courseName)}/${encodeURIComponent(sub.id)}`;
                            const resp = await axios.get(stnUrl, { timeout: 3000 });
                            if (resp.data?.cached && resp.data?.data?.teaching_context) {
                                validSubtopicTitles.push(sub.name);
                                stnHitCount++;
                            } else {
                                stnMissCount++;
                                log.info('REPORT', `STN miss for allowlist — excluding subtopic "${sub.name}" (${sub.id})`);
                            }
                        } catch (_) {
                            // Network error / timeout → exclude conservatively from STN list
                            stnMissCount++;
                        }
                    }
                }
            }

            // Safety net: if ALL STN probes errored (e.g. STN endpoint down but structure
            // was served from Redis), fall back to all curriculum subtopics so the planner
            // is still constrained to real curriculum titles — just without STN filtering.
            if (validSubtopicTitles.length === 0 && allSubtopicNames.length > 0) {
                log.warn('REPORT', `All STN probes failed (${stnMissCount} misses). Falling back to all ${allSubtopicNames.length} curriculum subtopics as allowlist. Topic-headers still excluded.`);
                validSubtopicTitles.push(...allSubtopicNames);
            }
        } else {
            // No RAG service configured — include all curriculum subtopics (no STN filter)
            validSubtopicTitles.push(...allSubtopicNames);
        }

        log.info('REPORT', `Allowlist built: ${validSubtopicTitles.length} titles (${stnHitCount} STN-confirmed, ${stnMissCount} STN-miss/excluded). Topic-headers excluded.`);

        if (onProgress) onProgress("Planning report sections and subsections...");
        const plan = await planSections(userIntent, courseContext, validSubtopicTitles, llmConfig);

        // Validate, split, and align section titles to curriculum topics
        const validatedSections = await splitAndAlignSectionsByCurriculum(plan.sections || [], courseName);

        // Deduplicate and merge planned sections with identical titles
        const mergedSectionsMap = new Map();
        for (const sec of validatedSections) {
            const titleTrim = (sec.title || "").trim();
            if (!titleTrim) continue;
            const titleKey = titleTrim.toLowerCase();
            if (mergedSectionsMap.has(titleKey)) {
                const existing = mergedSectionsMap.get(titleKey);
                const combined = [...existing.subsections];
                for (const sub of (sec.subsections || [])) {
                    if (!combined.includes(sub)) {
                        combined.push(sub);
                    }
                }
                existing.subsections = combined;
            } else {
                mergedSectionsMap.set(titleKey, {
                    title: titleTrim,
                    subsections: [...(sec.subsections || [])]
                });
            }
        }
        const deduplicatedSections = Array.from(mergedSectionsMap.values());

        // ── Coverage check: warn about any allowlist subtopic the planner silently dropped ──
        // Build a normalised set of every subsection title actually present in the plan.
        const plannedSubsectionSet = new Set(
            deduplicatedSections
                .flatMap(sec => sec.subsections || [])
                .map(t => (typeof t === 'string' ? t : t.title || '').toLowerCase().trim())
        );

        const uncoveredTitles = validSubtopicTitles.filter(
            title => !plannedSubsectionSet.has(title.toLowerCase().trim())
        );

        if (uncoveredTitles.length > 0) {
            log.warn('REPORT', `Coverage gap: PlannerAgent omitted ${uncoveredTitles.length}/${validSubtopicTitles.length} allowlist subtopics: ${uncoveredTitles.join(', ')}`);
            for (const title of uncoveredTitles) {
                warnings.push(`Subtopic '${title}' was in the allowlist but not included in the generated report.`);
            }
        } else {
            log.info('REPORT', `Coverage: PlannerAgent used all ${validSubtopicTitles.length} allowlist subtopics — no gaps.`);
        }

        // Process sections sequentially
        for (let i = 0; i < deduplicatedSections.length; i++) {
            const plannedSection = deduplicatedSections[i];
            const sectionTitle = plannedSection.title;
            const subsectionTitles = plannedSection.subsections || [];

            if (onProgress) onProgress(`Generating Section ${i + 1}/${deduplicatedSections.length}: "${sectionTitle}"...`);

            // Process subsections in this section in series to avoid hitting LLM rate limits
            const subsectionsResults = [];
            for (const subTitle of subsectionTitles) {
                try {
                    // 1. Resolve subtopic ID for context lookup
                    const resolved = await resolveSubtopicId(courseName, subTitle);
                    const subtopicId = resolved?.subtopicId || null;
                    const topicId = resolved?.topicId || null;

                    // 2. WriterAgent generates initial bullets
                    const writeResult = await writeBullets(subTitle, courseName, subtopicId, topicId, courseContext, llmConfig);
                    
                    // 3. CriticAgent validates the bullets against ground truth
                    const critiqueResult = await critiqueBullets(writeResult.bullets, writeResult.groundTruth, llmConfig);
                    
                    if (critiqueResult.flagged && critiqueResult.flagged.length > 0) {
                        log.warn('REPORT', `Flagged (hallucinated) bullets detected and dropped in "${subTitle}":`, critiqueResult.flagged);
                    }

                    // Merge approved and revised bullets.
                    // `revised` items are normalised: LLM sometimes returns objects instead of strings.
                    const normalisedRevised = (critiqueResult.revised || []).map(normaliseRevisedItem);
                    const combinedBullets = [
                        ...(critiqueResult.approved || []),
                        ...normalisedRevised
                    ];
                    
                    // Deduplicate bullets to ensure no cosmetic/structural duplicates leak through
                    const finalBullets = Array.from(new Set(combinedBullets.map(b => b.trim()))).filter(b => b.length > 0);

                    if (finalBullets.length === 0) {
                        throw new Error(`All bullets were flagged or rejected in Critic check for subsection "${subTitle}".`);
                    }

                    // 4. ExpanderAgent synthesizes the final approved bullets into a paragraph
                    const paragraph = await expandToParagraph(finalBullets, subTitle, llmConfig);

                    subsectionsResults.push({
                        title: subTitle,
                        paragraph,
                        bulletsUsed: finalBullets,
                        flaggedCount: critiqueResult.flagged ? critiqueResult.flagged.length : 0
                    });
                } catch (subErr) {
                    const errMsg = `Subsection "${subTitle}" failed generation: ${subErr.message}`;
                    log.warn('REPORT', errMsg);
                    warnings.push(errMsg);
                }
            }

            // Filter out failed subsections
            const validSubsections = subsectionsResults.filter(sub => sub !== null);

            reportData.sections.push({
                title: sectionTitle,
                subsections: validSubsections
            });
        }

        if (onProgress) onProgress("Report generation complete!");
        return reportData;

    } catch (err) {
        log.error('REPORT', `Report orchestrator crashed: ${err.message}`, err);
        throw err;
    }
}

module.exports = {
    generateReport,
    planSections,
    writeBullets,
    critiqueBullets,
    expandToParagraph,
    resolveSubtopicId,
    splitAndAlignSectionsByCurriculum
};
