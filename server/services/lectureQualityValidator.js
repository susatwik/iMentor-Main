function validateLecture(markdown, subtopicId, subtopicName, course) {
  const reasons = [];
  const lower = (markdown || '').toLowerCase();

  if (!markdown || typeof markdown !== 'string') {
    return { valid: false, reasons: ['Markdown is empty or not a string'] };
  }

  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  if (wordCount < 100) reasons.push(`Word count too low: ${wordCount} words (minimum 100)`);

  if (!/^## /m.test(markdown)) reasons.push('Missing ## heading');

  if (!/^## (Overview|Introduction)/m.test(markdown)) reasons.push('Missing Overview or Introduction section');

  if (!/^## (Learning Objectives|Key Takeaways)/m.test(markdown)) reasons.push('Missing Learning Objectives or Key Takeaways section');

  const placeholderPatterns = [
    'lecture note covers',
    'this lecture covers',
    'being generated',
    'please try again',
  ];
  for (const pattern of placeholderPatterns) {
    if (lower.includes(pattern)) reasons.push(`Contains placeholder text: "${pattern}"`);
  }

  const headingLines = markdown.match(/^#+ .+$/gm) || [];
  for (const heading of headingLines) {
    const headingText = heading.replace(/^#+\s*/, '');
    if (/[a-z]+_[a-z]+/i.test(headingText)) {
      reasons.push(`Snake_case found in heading: "${headingText}"`);
      break;
    }
  }

  if (markdown.includes('__')) reasons.push('Contains double underscores');

  const fenceMatches = markdown.match(/```/g);
  if (fenceMatches && fenceMatches.length > 0) {
    const fencePattern = /```([a-zA-Z]*)/g;
    let fm;
    let hasNonMermaid = false;
    while ((fm = fencePattern.exec(markdown)) !== null) {
      const lang = (fm[1] || '').toLowerCase();
      if (lang && lang !== 'mermaid') {
        hasNonMermaid = true;
        break;
      }
    }
    if (hasNonMermaid) reasons.push('Contains non-mermaid markdown code fences');
  }

  if (lower.includes('llm failure') || lower.includes('provider error')) {
    reasons.push('Contains provider error message');
  }
  if (lower.includes('api key') || lower.includes('providers are unavailable')) {
    reasons.push('Contains fallback error message');
  }

  const paragraphs = markdown.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  if (paragraphs.length <= 1) reasons.push('Markdown is just 1 paragraph (no structured sections)');

  if (subtopicId && markdown.includes(subtopicId)) reasons.push('Contains subtopicId as raw text');

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

module.exports = { validateLecture };
