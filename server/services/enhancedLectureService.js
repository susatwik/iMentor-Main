const { callWithFallback, parallelCallWithFallback, separateThinking, resolveModelForProvider } = require('./llmFallbackService');

function getServiceForProvider(provider) {
  switch (provider) {
    case 'gemini': return require('./geminiService');
    case 'groq': return require('./groqService');
    case 'openai': return require('./openaiService');
    case 'ollama': return require('./ollamaService');
    case 'sglang': return require('./sglangService');
    default: return null;
  }
}
const { validateLecture } = require('./lectureQualityValidator');
const { isTemplateQuality } = require('./lectureQualityDetector');
const { buildTemplateLecture } = require('./lectureTemplateBuilder');
const Lecture = require('../models/Lecture');
const { redisClient } = require('../config/redisClient');
const providerHealth = require('./providerHealthCache');
const axios = require('axios');
const log = require('../utils/logger');

const CACHE_TTL = 7 * 24 * 3600;
const PIPELINE_VERSION = 'v2.1';

const OLLAMA_PREFERRED_ORDER = [
  'llama3:8b',
  'llama3.1:8b',
  'phi3:mini',
  'mistral:7b',
  'gemma2:9b',
  'qwen2.5:7b',
  'qwen2.5-coder:7b',
];

let _discoveredModel = null;
let _discoveryDone = false;

async function discoverOllamaModel() {
  if (_discoveryDone) return _discoveredModel;
  _discoveryDone = true;

  const ollamaUrl = process.env.OLLAMA_URL || `http://localhost:${process.env.OLLAMA_PORT || 11434}`;
  try {
    const resp = await axios.get(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { timeout: 5000 });
    const installed = (resp.data?.models || []).map(m => m.name);
    if (!installed.length) {
      log.warn('OLLAMA', 'No models installed');
      _discoveredModel = null;
      return null;
    }

    const configured = process.env.LECTURE_OLLAMA_MODEL;
    if (configured) {
      const normalized = configured.trim();
      if (installed.some(m => m === normalized || m.startsWith(normalized.replace(/:.*$/, '') + ':'))) {
        _discoveredModel = normalized;
        log.info('OLLAMA', `Using configured model LECTURE_OLLAMA_MODEL=${normalized}`);
        return _discoveredModel;
      }
      log.warn('OLLAMA', `Configured LECTURE_OLLAMA_MODEL=${normalized} not installed, auto-selecting...`);
    }

    for (const preferred of OLLAMA_PREFERRED_ORDER) {
      const match = installed.find(m => m === preferred || m.startsWith(preferred.replace(/:.*$/, '') + ':'));
      if (match) {
        _discoveredModel = match;
        log.info('OLLAMA', `Selected model ${match} (preferred order)`);
        return _discoveredModel;
      }
    }

    _discoveredModel = installed[0];
    log.warn('OLLAMA', `No preferred model found, using ${_discoveredModel} (first installed)`);
    return _discoveredModel;
  } catch (e) {
    log.warn('OLLAMA', `Model discovery failed: ${e.message}`);
    _discoveredModel = null;
    return null;
  }
}

function estimateLectureSize(prompt) {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const targetSections = (prompt.match(/^## /gm) || []).length;
  const complexity = targetSections >= 7 ? 'large' : wordCount > 300 ? 'medium' : 'small';
  const timeouts = { small: 120_000, medium: 240_000, large: 300_000, very_large: 300_000 };
  const label = targetSections >= 7 ? 'very_large' : complexity;
  const timeout = timeouts[label];
  log.info('PIPELINE', `[ADAPTIVE_TIMEOUT] ${label} lecture (${wordCount}w prompt, ${targetSections} sections) → ${timeout/1000}s`);
  return { timeout, label };
}

function logPipeline(step, detail) {
  log.info('PIPELINE', `[${step}] ${detail}`);
}

function buildEnhancedPrompt(course, subtopicId, subtopicName, topicName, moduleName) {
  const name = subtopicName || subtopicId?.replace(/[_-]/g, ' ') || course;
  const topic = topicName || '';
  const module = moduleName || '';

  const subjectHints = [];
  const lowerName = name.toLowerCase();
  const lowerCourse = course.toLowerCase();

  if (/\bmath|algebra|calculus|differential|integral|matrix|vector|numerical\b/.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include formula derivations, proof intuition, solved problems, and alternate methods');
    subjectHints.push('- Use mathematical notation with LaTeX where appropriate');
  } else if (/\bprogram|coding|algorithm|software|data structure|computing|java|python|javascript|sql\b/.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include working code examples with syntax highlighting');
    subjectHints.push('- Add complexity analysis and edge case discussion');
    subjectHints.push('- Cover best practices and common pitfalls');
  } else if (/\bcircuit|power|motor|machine|signal|electronics|electrical|embedded|control\b/.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include formula derivations and numerical examples');
    subjectHints.push('- Use tables and signal/block diagrams via Mermaid where relevant');
    subjectHints.push('- Add step-by-step calculations with intermediate values');
    subjectHints.push('- Include circuit or system diagrams via Mermaid');
  } else if (/\bmanagement|entrepreneur|business|economic|marketing|finance\b/.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include case studies and business scenarios');
    subjectHints.push('- Add SWOT analysis or frameworks where relevant');
    subjectHints.push('- Reference industry practices and real-world examples');
  } else if (/\bphysics|chemistry|biology|material|science\b/.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include formula derivations and experimental context');
    subjectHints.push('- Use tables for comparative data');
    subjectHints.push('- Connect theory to observable phenomena');
  } else if (/\blanguage|english|french|german|sanskrit\b/i.test(lowerName + ' ' + lowerCourse)) {
    subjectHints.push('- Include usage examples and grammatical explanations');
    subjectHints.push('- Provide practice exercises with answers');
    subjectHints.push('- Connect to cultural context where relevant');
  }

  const hintsSection = subjectHints.length > 0
    ? '\nSubject-specific requirements:\n' + subjectHints.join('\n') + '\n'
    : '';

  return `You are an expert university professor creating a detailed, engaging lecture note.

Course: ${course}${module ? `\nModule: ${module}` : ''}${topic ? `\nTopic: ${topic}` : ''}
Lecture subject: ${name}

Write a comprehensive lecture note in Markdown.

Include the following sections using EXACTLY these Markdown headings:
## Overview
## Learning Objectives
## Core Concepts
## Worked Examples
## Practical Applications
## Key Takeaways
## Summary

For each section write meaningful content. The lecture should be 300-700 words total. Use bullet lists, examples, and clear explanations.${hintsSection}`;
}

const PROVIDER_HARD_TIMEOUTS = {
  groq: 10_000,
  gemini: 12_000,
  openai: 15_000,
  ollama: 60_000,
  sglang: 5_000,
};

async function upgradeLecture(course, subtopicId, subtopicName, topicName, moduleName) {
  const cacheKey = `lecture:${course}:${subtopicId || 'full'}`;
  const ollamaModel = await discoverOllamaModel();

  logPipeline('ENHANCED_GEN', `Upgrading lecture for ${course}/${subtopicId} (ollama_model=${ollamaModel || 'none'})`);
  const prompt = buildEnhancedPrompt(course, subtopicId, subtopicName, topicName, moduleName);

  const { timeout: adaptiveTimeout } = estimateLectureSize(prompt);

  if (ollamaModel) {
    process.env.OLLAMA_DEFAULT_MODEL = ollamaModel;
  }

  try {
    const startTime = Date.now();

    const baseOpts = { temperature: 0.7, maxOutputTokens: 1536 };
    const chain = ['sglang', 'groq', 'gemini', 'openai', 'ollama'];
    const healthyProviders = providerHealth.getHealthyProviders(chain);

    logPipeline('HEALTHY_PROVIDERS', `${course}/${subtopicId}: ${healthyProviders.join(', ') || 'none (falling back to sequential)'}`);

    let result;
    if (healthyProviders.length === 1) {
      const single = healthyProviders[0];
      const timeout = PROVIDER_HARD_TIMEOUTS[single] || adaptiveTimeout;
      logPipeline('SINGLE_DISPATCH', `${course}/${subtopicId}: direct call to ${single} (timeout=${timeout}ms)`);
      const svc = getServiceForProvider(single);
      if (svc) {
        const model = resolveModelForProvider(single, baseOpts);
        const startSingle = Date.now();
        try {
          const raw = await svc.generateContentWithHistory([], prompt,
            'You are an expert university professor creating detailed lecture notes in Markdown. Write substantive, original content with concrete examples. Do NOT use placeholder language.',
            { ...baseOpts, model, timeout, temperature: 0.7, maxOutputTokens: 1536 }
          );
          const text = typeof raw === 'string' ? raw : String(raw || '');
          const { content } = separateThinking(text);
          result = { text: content, provider: single, model, wasFailover: false };
        } catch (e) {
          log.warn('PIPELINE', `Direct call to ${single} failed: ${e.message}`);
          result = null;
        }
      }
      if (!result) {
        logPipeline('SINGLE_FAILED_FALLBACK', `${course}/${subtopicId}: direct call failed, using full chain`);
        result = await callWithFallback({
          userQuery: prompt,
          systemPrompt: 'You are an expert university professor creating detailed lecture notes in Markdown. Write substantive, original content with concrete examples. Do NOT use placeholder language.',
          chatHistory: [],
          preferredProvider: 'sglang',
          options: { ...baseOpts, timeout: Math.max(timeout, adaptiveTimeout) },
        });
      }
    } else if (healthyProviders.length > 1) {
      logPipeline('PARALLEL_DISPATCH', `${course}/${subtopicId}: ${healthyProviders.join(', ')}`);
      result = await parallelCallWithFallback({
        userQuery: prompt,
        systemPrompt: 'You are an expert university professor creating detailed lecture notes in Markdown. Write substantive, original content with concrete examples. Do NOT use placeholder language.',
        chatHistory: [],
        parallelProviders: healthyProviders,
        staggerMs: 200,
        preferredProvider: 'sglang',
        options: { ...baseOpts, timeout: adaptiveTimeout },
      });
    } else {
      logPipeline('NO_HEALTHY_PROVIDERS', `${course}/${subtopicId}: falling back to full chain`);
      result = await callWithFallback({
        userQuery: prompt,
        systemPrompt: 'You are an expert university professor creating detailed lecture notes in Markdown. Write substantive, original content with concrete examples. Do NOT use placeholder language.',
        chatHistory: [],
        preferredProvider: 'sglang',
        options: { ...baseOpts, timeout: adaptiveTimeout },
      });
    }

    const generationTime = Date.now() - startTime;
    const provider = result?.provider || 'unknown';
    const model = result?.model || 'unknown';

    if (result?.provider === 'none' || !result?.text || result.text.length < 200) {
      logPipeline('ENHANCED_FAIL', `All providers exhausted for ${course}/${subtopicId}`);
      providerHealth.recordFailure('sglang', 'Skipped in health check');
      providerHealth.recordFailure('groq', 'Skipped in health check');
      providerHealth.recordFailure('gemini', 'API key missing');
      providerHealth.recordFailure('openai', 'API key missing');
      providerHealth.recordFailure('ollama', 'Slow or timed out');
      return null;
    }

    let text = result.text;
    text = stripNonMermaidCodeFences(text);
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    providerHealth.recordSuccess(provider, generationTime);

    const validation = validateLecture(text, subtopicId, subtopicName, course);
    const validationOk = validation.valid ? 'PASS' : `FAIL: ${validation.reasons.join('; ')}`;

    logPipeline('ENHANCED_OK',
      `${course} | ${moduleName || '-'} | ${topicName || '-'} | ${subtopicId} | ` +
      `provider=${provider} model=${model} time=${generationTime}ms words=${wordCount} validation=${validationOk}`
    );

    if (!validation.valid) {
      logPipeline('ENHANCED_VALIDATION_FAIL', `${course}/${subtopicId}: ${validation.reasons.join(', ')}`);
      providerHealth.recordFailure(provider, `Validation failed: ${validation.reasons.join(', ')}`);
      return null;
    }

    const html = simpleMarkdownToHtml(text);
    const lectureData = {
      course,
      subtopicId: subtopicId || null,
      subtopicName: subtopicName || '',
      topicName: topicName || '',
      moduleName: moduleName || '',
      markdown: text,
      html,
      conceptMap: '',
      contentType: subtopicId ? 'subtopic' : 'full_lecture',
      source: provider,
      generatedBy: provider,
      model,
      pipelineVersion: PIPELINE_VERSION,
      generatedAt: new Date().toISOString(),
      metadata: {
        wordCount,
        generatedBy: provider,
        model,
        pipelineVersion: PIPELINE_VERSION,
        isEnhanced: true,
      },
    };

    await Lecture.findOneAndUpdate(
      { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') }, subtopicId: subtopicId || null },
      { $set: lectureData },
      { upsert: true }
    );
    logPipeline('ENHANCED_SAVED', `MongoDB updated for ${course}/${subtopicId}`);

    try {
      if (redisClient && redisClient.isOpen) {
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(lectureData));
        logPipeline('ENHANCED_CACHED', `Redis updated for ${cacheKey}`);
      }
    } catch (e) {
      log.warn('PIPELINE', `Redis cache write failed for ${cacheKey}: ${e.message}`);
    }

    logPipeline('UPGRADE_SUCCESS', `${course}/${subtopicId} → ${provider}/${model} (${wordCount} words, ${generationTime}ms)`);
    return { ...lectureData, _source: 'enhanced_' + provider };
  } catch (e) {
    log.warn('PIPELINE', `Enhanced generation failed for ${course}/${subtopicId}: ${e.message}`);
    logPipeline('UPGRADE_FAIL', `${course}/${subtopicId}: ${e.message}`);
    return null;
  }
}

async function tryUpgradeOnRetrieval(lectureData, course, subtopicId, subtopicName, topicName, moduleName) {
  if (!lectureData || !lectureData.markdown) return lectureData;

  const needsUpgrade = isTemplateQuality(lectureData);
  if (!needsUpgrade) return lectureData;

  logPipeline('UPGRADE_NEEDED', `${course}/${subtopicId} — triggering enhanced generation`);
  const upgraded = await upgradeLecture(course, subtopicId, subtopicName, topicName, moduleName);
  if (upgraded) {
    logPipeline('UPGRADE_SUCCESS', `${course}/${subtopicId} replaced template with enhanced content`);
    return upgraded;
  }

  logPipeline('UPGRADE_SKIP', `${course}/${subtopicId} — keeping existing content`);
  return lectureData;
}

function simpleMarkdownToHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(.+)$/gm, (m) => m.startsWith('<') ? m : `<p>${m}</p>`);
  return `<div class="lecture-content">${html}</div>`;
}

function stripNonMermaidCodeFences(text) {
  let cleaned = text.trim();
  const markdownBlockMatch = cleaned.match(/^```(?:markdown|md)\s*\n([\s\S]*?)```(?:\s*\n|$)/i);
  if (markdownBlockMatch) {
    cleaned = markdownBlockMatch[1].trim();
  }
  cleaned = cleaned.replace(/```(?!mermaid\b)[\s\S]*?```/g, '');
  return cleaned;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { upgradeLecture, tryUpgradeOnRetrieval, buildEnhancedPrompt, discoverOllamaModel, estimateLectureSize, stripNonMermaidCodeFences, PROVIDER_HARD_TIMEOUTS };