// Strict Socratic formatter used to enforce iMentor Study Mode output constraints.
// Guarantees:
// - Clean prose only: no bullets/lists, no headings, no code fences, no Mermaid, no <thinking>
// - Preserves an explicit question when the model provides one
// - Does not invent a follow-up question when the response should remain explanation-first

function cleanResponse(text) {
  if (!text) return "";
  return String(text)
    .replace(/^(Thinking Process|Thought|Analysis|Reasoning|Internal Monologue|Thought Process):?\s*/i, '')
    .replace(/\n(Thinking Process|Thought|Analysis|Reasoning|Internal Monologue|Thought Process):?\s*/i, '\n')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]?/g)
    ?.map(s => s.trim())
    .filter(Boolean) || [];
}

function formatSocraticStrict(text) {
  const raw = cleanResponse(text);

  // Remove fences, mermaid, and thinking blocks
  let t = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```/g, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\bmermaid\b[\s\S]*?/gi, '');

  // Strip bullet/list/heading-like lines
  t = t
    .split('\n')
    .filter(line => {
      const s = line.trim();
      // Preserve blank lines so paragraph boundaries survive for later splitting.
      if (!s) return true;
      if (/^(#+|SECTION\s*\d*\s*:)/i.test(s)) return false;
      if (/^[-*]\s+/.test(s)) return false;
      if (/^\d+[\.)]\s+/.test(s)) return false;
      if (/^\u2022\s+/.test(s)) return false;
      return true;
    })
    .join('\n');

  const paras = t
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !/^\([^()\n]+(?:\n[^()\n]+)*\)$/.test(p));

  // Prefer an explicit question, but do not manufacture one if the model only gave teaching text.
  let qIndex = -1;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (paras[i] && paras[i].includes('?')) {
      qIndex = i;
      break;
    }
  }

  if (qIndex === -1) {
    return paras
      .slice(0, 3)
      .map(p => String(p || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  const q = paras[qIndex];

  const normalizeQuestion = (p) => {
    const s = String(p || '').trim();
    if (!s) return '?';
    const questionSentence = splitSentences(s)
      .filter(sentence => sentence.includes('?'))
      .pop();
    if (questionSentence) {
      return questionSentence.replace(/\s+/g, ' ').trim();
    }
    const fallbackSentence = splitSentences(s).pop() || s;
    return fallbackSentence.replace(/[.?!]+$/g, '').trim() + '?';
  };

  const teaching = paras.filter((_, idx) => idx !== qIndex);
  const teachingSentences = teaching.flatMap(splitSentences);
  const p1 = teachingSentences[0]
    || (paras.length === 1 ? '' : (splitSentences(raw)[0] || raw || ''));
  const p2 = teachingSentences[1] || '';
  const p3 = teaching.length > 2
    ? (splitSentences(teaching[teaching.length - 1])[0] || '')
    : '';
  const p4 = normalizeQuestion(q);

  return [p1, p2, p3, p4]
    .filter(Boolean)    
    .slice(0, 4)
    .map(p => String(p || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n\n')
    .trim();
}

module.exports = { cleanResponse, formatSocraticStrict };
