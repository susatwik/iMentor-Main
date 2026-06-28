const JSON5 = require('json5');

function stripCodeFences(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function sanitizeControlCharacters(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function parseStructuredContentSections(text) {
  const source = String(text || '');
  const result = {};

  const notesMatch = source.match(/(?:^|\n)\s*(?:notes?|study notes|content)\s*:\s*([\s\S]*?)(?=\n\s*(?:flashcards?|learning objectives?|objectives?|key points?|notes?|study notes|content)\s*:|$)/i);
  if (notesMatch?.[1]) {
    const notes = notesMatch[1]
      .replace(/^[*-]\s*/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (notes) result.notes = notes;
  }

  const objectivesMatch = source.match(/(?:^|\n)\s*(?:learning objectives?|objectives?|goals?)\s*:\s*([\s\S]*?)(?=\n\s*(?:flashcards?|notes?|study notes|content|learning objectives?|objectives?)\s*:|$)/i);
  if (objectivesMatch?.[1]) {
    const objectives = objectivesMatch[1]
      .split(/\n+/)
      .map(line => line.replace(/^[*-]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter(Boolean);
    if (objectives.length > 0) result.learningObjectives = objectives;
  }

  const flashcardsMatch = source.match(/(?:^|\n)\s*(?:flashcards?|cards?)\s*:\s*([\s\S]*?)(?=\n\s*(?:notes?|study notes|learning objectives?|objectives?|goals?)\s*:|$)/i);
  if (flashcardsMatch?.[1]) {
    const block = flashcardsMatch[1].trim();
    const cards = [];

    const jsonCards = extractFirstJsonValue(block);
    if (jsonCards) {
      const parsedCards = tryParse('json5', jsonCards) || tryParse('json', jsonCards);
      if (Array.isArray(parsedCards)) {
        for (const card of parsedCards) {
          const front = card?.front ?? card?.question ?? card?.term ?? '';
          const back = card?.back ?? card?.answer ?? card?.definition ?? '';
          if (String(front).trim() || String(back).trim()) {
            cards.push({
              front: String(front).trim(),
              back: String(back).trim()
            });
          }
        }
      }
    }

    if (cards.length === 0) {
      const lines = block.split(/\n+/).map(line => line.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const pairMatch = line.match(/^(?:[-*]\s*)?(.*?)\s*(?:=>|:|-) \s*(.*)$/);
        if (pairMatch) {
          cards.push({
            front: pairMatch[1].trim(),
            back: pairMatch[2].trim()
          });
          continue;
        }
        const nextLine = lines[i + 1];
        if (nextLine && /^(?:[-*]\s*)?(?:answer|back|definition|explanation)\s*:/i.test(nextLine)) {
          const front = line.replace(/^[*-]\s*/, '').trim();
          const back = nextLine.replace(/^(?:[-*]\s*)?(?:answer|back|definition|explanation)\s*:\s*/i, '').trim();
          if (front || back) {
            cards.push({ front, back });
            i += 1;
          }
        }
      }
    }

    if (cards.length > 0) result.flashcards = cards;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function extractFirstJsonValue(text) {
  const source = String(text || '');
  const objectStart = source.indexOf('{');
  const arrayStart = source.indexOf('[');

  let start = -1;
  if (objectStart === -1) start = arrayStart;
  else if (arrayStart === -1) start = objectStart;
  else start = Math.min(objectStart, arrayStart);

  if (start === -1) return null;

  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function tryParse(strategy, raw) {
  if (!raw) return null;
  try {
    if (strategy === 'json') return JSON.parse(raw);
    if (strategy === 'json5') return JSON5.parse(raw);
    return null;
  } catch {
    return null;
  }
}

function safeExtractJson(rawResponse) {
  const cleaned = sanitizeControlCharacters(stripCodeFences(rawResponse));
  const extracted = extractFirstJsonValue(cleaned);
  const candidates = [
    cleaned,
    extracted
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = tryParse('json', candidate) || tryParse('json5', candidate);
    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function safeParseLLMJson(rawResponse, { topic = '' } = {}) {
  const cleaned = stripCodeFences(rawResponse);
  const strategies = [
    ['json', cleaned],
    ['json5', cleaned],
  ];

  const extracted = extractFirstJsonValue(cleaned);
  if (extracted) {
    strategies.push(['json', extracted]);
    strategies.push(['json5', extracted]);
  }

  const sanitized = sanitizeControlCharacters(cleaned);
  if (sanitized !== cleaned) {
    strategies.push(['json', sanitized]);
    strategies.push(['json5', sanitized]);
    const sanitizedExtracted = extractFirstJsonValue(sanitized);
    if (sanitizedExtracted) {
      strategies.push(['json', sanitizedExtracted]);
      strategies.push(['json5', sanitizedExtracted]);
    }
  }

  for (const [strategy, payload] of strategies) {
    const parsed = tryParse(strategy, payload);
    if (parsed != null) {
      console.log('[CONTENT PARSE]', {
        strategy,
        success: true,
        topic
      });
      console.log('[CONTENT PARSE SUCCESS]', {
        strategy,
        topic
      });
      return parsed;
    }
  }

  const structured = parseStructuredContentSections(cleaned);
  if (structured) {
    console.log('[CONTENT PARSE]', {
      strategy: 'structured_sections',
      success: true,
      topic
    });
    console.log('[CONTENT PARSE SUCCESS]', {
      strategy: 'structured_sections',
      topic
    });
    return structured;
  }

  console.log('[CONTENT PARSE]', {
    strategy: 'all-failed',
    success: false,
    topic
  });
  console.log('[CONTENT PARSE FAILURE]', {
    strategy: 'all-failed',
    topic
  });
  return null;
}

module.exports = {
  safeParseLLMJson,
  stripCodeFences,
  sanitizeControlCharacters,
  extractFirstJsonValue,
  safeExtractJson
};
