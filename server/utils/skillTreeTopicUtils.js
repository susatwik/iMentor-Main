const skillTreeAcronymMap = {
  AI: 'Artificial Intelligence',
  ML: 'Machine Learning',
  XAI: 'Explainable Artificial Intelligence',
  DL: 'Deep Learning',
  NLP: 'Natural Language Processing',
  CV: 'Computer Vision',
  OS: 'Operating Systems',
  CN: 'Computer Networks',
  DBMS: 'Database Management Systems',
  RAG: 'Retrieval-Augmented Generation',
  GRAPHRAG: 'Graph Retrieval-Augmented Generation',
  SE: 'Software Engineering',
  SPM: 'Software Project Management',
  DSA: 'Data Structures and Algorithms',
  MCP: 'Model Context Protocol',
  MAS: 'Multi-Agent Systems',
  API: 'Application Programming Interface',
  ST: 'Software Testing',
  QA: 'Quality Assurance',
  REST: 'REST API Development',
  CICD: 'Continuous Integration and Continuous Deployment',
  CPP: 'C++',
  CSHARP: 'C#',
  DOTNET: '.NET',
  NET: '.NET',
  ASPNET: 'ASP.NET',
  EXPRESSJS: 'Express.js',
  REASONINGANDAPTITUDE: 'Aptitude & Reasoning',
  APTITUDEANDREASONING: 'Aptitude & Reasoning',
  LOGICALREASONING: 'Reasoning',
  QUANTITATIVEAPTITUDE: 'Aptitude'
};

function normalizeSkillTreeTopic(topic) {
  if (topic && typeof topic === 'object') {
    return String(topic.value || topic.label || topic.name || topic.topic || topic.title || '').trim();
  }
  return String(topic || '').trim();
}

function canonicalizeSkillTreeTopic(topic) {
  const normalized = normalizeSkillTreeTopic(topic);
  const normalizedUpper = normalized.toUpperCase();
  const compactUpper = normalizedUpper.replace(/[^A-Z0-9]/g, '');
  return skillTreeAcronymMap[normalizedUpper] ||
    skillTreeAcronymMap[compactUpper] ||
    skillTreeAcronymMap[normalized.toLowerCase()] ||
    normalized;
}

module.exports = {
  normalizeSkillTreeTopic,
  canonicalizeSkillTreeTopic,
  skillTreeAcronymMap
};
