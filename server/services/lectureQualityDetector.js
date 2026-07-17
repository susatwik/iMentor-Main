const log = require('../utils/logger');

const TEMPLATE_SENTINELS = [
  'is a fundamental concept within',
  'this section provides a comprehensive introduction',
  'the study of ',
  'encompasses both theoretical frameworks and practical implementations',
  'in this lecture, we explore',
  'does not exist in isolation',
  'encompasses a rich body of knowledge',
  'consider a scenario where',
  'built upon a solid foundation of theoretical principles',
];

function isTemplateQuality(lectureData) {
  if (!lectureData || !lectureData.markdown) return true;

  const md = lectureData.markdown;
  const lower = md.toLowerCase();
  const wordCount = md.split(/\s+/).filter(Boolean).length;

  const reasons = [];

  const isTemplateSource = lectureData.source === 'template' || lectureData.source === 'template_fallback';

  if (wordCount < 200) {
    reasons.push(`word_count: ${wordCount} < 200`);
    const isTemplate = true;
    log.info('QUALITY', `Template detection: ${reasons.join(', ')}`);
    return isTemplate;
  }

  for (const sentinel of TEMPLATE_SENTINELS) {
    if (lower.includes(sentinel)) {
      reasons.push(`template_sentinel: "${sentinel.substring(0, 40)}"`);
      break;
    }
  }

  if (isTemplateSource) reasons.push('source_is_template');

  if (wordCount < 1200) reasons.push(`word_count: ${wordCount} < 1200`);

  if (wordCount >= 1200 && !reasons.some(r => r.startsWith('template_sentinel') || r === 'source_is_template')) {
    return false;
  }

  if (!/### (Overview|Learning Objectives|Core Concepts|Detailed Explanation)/im.test(md)) {
    reasons.push('missing_rich_sections');
  }

  if (!/### (Worked Examples|Example|Applications|Practice Questions)/im.test(md)) {
    reasons.push('missing_practice_sections');
  }

  const h2Count = (md.match(/^## /gm) || []).length;
  if (h2Count <= 2) reasons.push('too_few_sections');

  const isTemplate = reasons.length > 0;
  if (isTemplate) {
    log.info('QUALITY', `Template detection: ${reasons.join(', ')}`);
  }
  return isTemplate;
}

module.exports = { isTemplateQuality };