function cleanTitle(text) {
  if (!text) return '';
  let result = text.trim();

  const compoundPatterns = [
    [/lead_acid/gi, 'Lead-Acid'],
    [/nickel_cadmium/gi, 'Nickel-Cadmium'],
    [/nickel_metal_hydride/gi, 'Nickel-Metal-Hydride'],
    [/lithium_ion/gi, 'Lithium-Ion'],
    [/solid_state/gi, 'Solid-State'],
    [/simpson's_1\/3/i, "Simpson's 1/3 Rule"],
    [/simpson's_3\/8/i, "Simpson's 3/8 Rule"],
  ];
  for (const [pattern, replacement] of compoundPatterns) {
    result = result.replace(pattern, replacement);
  }

  result = result.replace(/\bi\/o\b/gi, 'I/O');
  result = result.replace(/\bdc\/ac\b/gi, 'DC/AC');
  result = result.replace(/\bac\/dc\b/gi, 'AC/DC');
  result = result.replace(/\br\/c\b/gi, 'R/C');
  result = result.replace(/\brl\/c\b/gi, 'RL/C');

  result = result.replace(/_/g, ' ');

  result = result.replace(/:\s*/g, ': ');

  result = result.replace(/\.+$/, '');

  result = result.replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  const acronyms = {
    'Iot': 'IoT', 'Api': 'API', 'Aws': 'AWS', 'Gcp': 'GCP',
    'Sql': 'SQL', 'Html': 'HTML', 'Css': 'CSS', 'Json': 'JSON',
    'Xml': 'XML', 'Yaml': 'YAML', 'Rest': 'REST', 'Ml': 'ML',
    'Ai': 'AI', 'Nlp': 'NLP', 'Dl': 'DL', 'Rnn': 'RNN',
    'Cnn': 'CNN', 'Lstm': 'LSTM', 'Gpu': 'GPU', 'Cpu': 'CPU',
    'Usb': 'USB', 'Url': 'URL', 'Uri': 'URI', 'Dns': 'DNS',
    'Http': 'HTTP', 'Https': 'HTTPS', 'Ssh': 'SSH', 'Ftp': 'FTP',
    'Tcp': 'TCP', 'Ip': 'IP', 'Dhcp': 'DHCP', 'Vpn': 'VPN',
    'Cli': 'CLI', 'Gui': 'GUI', 'Ide': 'IDE', 'Sdk': 'SDK',
    'Ci': 'CI', 'Cd': 'CD', 'Crud': 'CRUD', 'Jwt': 'JWT',
    'Oauth': 'OAuth', 'Ldap': 'LDAP', 'Sso': 'SSO', 'Mfa': 'MFA',
    'Rbac': 'RBAC', 'Cors': 'CORS', 'Xss': 'XSS', 'Csrf': 'CSRF',
    'Mongodb': 'MongoDB', 'Neo4j': 'Neo4j', 'Redis': 'Redis',
    'Docker': 'Docker', 'Kubernetes': 'Kubernetes',
    'Prometheus': 'Prometheus', 'Grafana': 'Grafana',
    'Elasticsearch': 'Elasticsearch', 'Kibana': 'Kibana',
    'Pcb': 'PCB', 'Fpga': 'FPGA', 'Asic': 'ASIC',
    'Vhdl': 'VHDL', 'Verilog': 'Verilog', 'Mosfet': 'MOSFET',
    'Bjt': 'BJT', 'Cmos': 'CMOS', 'Pwm': 'PWM',
    'Adc': 'ADC', 'Dac': 'DAC',
    'Lte': 'LTE', 'Wifi': 'WiFi', 'Ieee': 'IEEE',
    'Soc': 'SoC',
  };

  for (const [wrong, correct] of Object.entries(acronyms)) {
    const regex = new RegExp(`\\b${wrong}\\b`, 'g');
    result = result.replace(regex, correct);
  }

  return result;
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

function buildTemplateLecture(course, subtopicId, subtopicName, topicName, moduleName) {
  const title = cleanTitle(subtopicName || subtopicId || course);
  const topic = cleanTitle(topicName || '');
  const module = cleanTitle(moduleName || '');
  const courseTitle = cleanTitle(course);

  const contextParts = [courseTitle];
  if (module) contextParts.push(module);
  if (topic) contextParts.push(topic);
  const contextStr = contextParts.join(' \u2014 ');

  const markdown = [
    '# ' + title,
    '',
    '## Overview',
    '',
    title + ' is a fundamental concept within ' + contextStr + '. This section provides a comprehensive introduction to the principles, methodologies, and applications that define this topic. Understanding ' + title + ' is essential for building a strong foundation in ' + courseTitle + '.',
    '',
    'The study of ' + title + ' encompasses both theoretical frameworks and practical implementations. From its foundational principles to advanced applications, this topic plays a critical role in modern ' + courseTitle + '. Professionals and students alike must grasp these concepts to effectively apply them in real-world scenarios.',
    '',
    'In this lecture, we explore the core ideas, examine concrete examples, and discuss how ' + title + ' integrates with broader themes within ' + courseTitle + '. By the end, you will have a thorough understanding of both the "what" and the "why" behind this important subject.',
    '',
    '## Learning Objectives',
    '',
    'By the end of this lecture, you will be able to:',
    '',
    '- Define ' + title + ' and explain its significance within ' + contextStr,
    '- Identify the key components, principles, and methodologies associated with ' + title,
    '- Analyze how ' + title + ' relates to other concepts in ' + courseTitle + ' and adjacent fields',
    '- Apply the knowledge of ' + title + ' to solve practical problems and case studies',
    '- Evaluate real-world implementations and assess their effectiveness',
    '- Synthesize multiple perspectives on ' + title + ' to form a comprehensive understanding',
    '',
    '## Core Concepts',
    '',
    '### 1. Foundational Principles',
    'The core of ' + title + ' rests on several key principles that govern its behavior and application. These principles provide the theoretical underpinning necessary for deeper exploration. Understanding these fundamentals allows practitioners to reason about complex scenarios and make informed decisions.',
    '',
    '### 2. Key Components and Architecture',
    title + ' involves distinct components that work together in a structured manner. Each component plays a specific role, and understanding their interactions is crucial for effective implementation. The architecture defines how these pieces fit together to create a cohesive system.',
    '',
    '### 3. Methodologies and Approaches',
    'Several established methodologies guide the practical application of ' + title + '. These approaches have been refined through research and industry practice, providing reliable frameworks for solving problems. Selecting the appropriate methodology depends on the specific context and requirements.',
    '',
    '### 4. Evaluation and Metrics',
    'Measuring the effectiveness of ' + title + ' requires appropriate metrics and evaluation criteria. Understanding how to assess performance, quality, and outcomes ensures that implementations meet their intended goals. This includes both quantitative and qualitative assessment methods.',
    '',
    '### 5. Integration with Related Concepts',
    title + ' does not exist in isolation \u2014 it connects with and depends on other concepts within ' + courseTitle + '. Recognizing these relationships enables a holistic understanding and facilitates cross-disciplinary problem-solving.',
    '',
    '## Detailed Explanation',
    '',
    title + ' encompasses a rich body of knowledge that spans theoretical foundations and practical applications. The theoretical framework provides the logical structure for understanding how and why ' + title + ' works as it does. This foundation is built upon established research and proven principles that have stood the test of rigorous examination.',
    '',
    'In practice, ' + title + ' manifests through specific techniques and methodologies that translate theory into actionable approaches. These practical aspects are informed by real-world constraints and requirements, resulting in solutions that are both theoretically sound and practically viable. The interplay between theory and practice is what makes ' + title + ' a dynamic and evolving field of study.',
    '',
    'Advanced considerations within ' + title + ' push the boundaries of current understanding. Researchers and practitioners continually explore new frontiers, refining existing approaches and developing novel solutions to emerging challenges. This ongoing evolution ensures that ' + title + ' remains relevant and effective in addressing contemporary problems.',
    '',
    'The practical implementation of ' + title + ' requires careful consideration of context-specific factors. Variables such as resource constraints, performance requirements, and environmental conditions all influence how ' + title + ' should be applied. A thorough understanding of these factors enables practitioners to adapt general principles to specific situations effectively.',
    '',
    '## Examples',
    '',
    '### Example 1: Foundational Application',
    'Consider a scenario where ' + title + ' is applied to solve a common problem in ' + courseTitle + '. The approach begins by identifying the relevant principles and selecting the appropriate methodology. The implementation follows established best practices, and the outcomes are evaluated against predefined criteria. This example demonstrates the standard workflow for applying ' + title + ' in practice.',
    '',
    '### Example 2: Advanced Use Case',
    'In a more complex scenario, ' + title + ' must be adapted to accommodate unusual requirements or constraints. This example illustrates how the core principles can be extended and modified to address non-standard situations. The solution involves creative problem-solving while maintaining adherence to fundamental concepts.',
    '',
    '### Example 3: Cross-Domain Integration',
    title + ' often intersects with other disciplines within ' + courseTitle + '. This example shows how ' + title + ' principles can be combined with complementary approaches to create comprehensive solutions. The integration highlights the interconnected nature of modern ' + courseTitle + ' and the importance of systems thinking.',
    '',
    '## Practical Applications',
    '',
    '### Industry Applications',
    title + ' has widespread applications across various industries. In technology sectors, it enables the development of efficient systems and solutions. Manufacturing industries leverage ' + title + ' to optimize processes and improve quality control. Healthcare organizations apply ' + title + ' principles to enhance patient care and operational efficiency.',
    '',
    '### Research and Development',
    'In academic and industrial research settings, ' + title + ' provides the framework for investigating new phenomena and developing innovative solutions. Research teams use these concepts to design experiments, analyze data, and draw meaningful conclusions that advance the field.',
    '',
    '### Education and Training',
    'Educational institutions incorporate ' + title + ' into their curricula to prepare students for careers in ' + courseTitle + '. Training programs use these concepts to build foundational knowledge and develop practical skills that are directly applicable in the workplace.',
    '',
    '### Emerging Technologies',
    'As technology evolves, ' + title + ' continues to find new applications in emerging fields. From artificial intelligence to sustainable energy systems, the principles of ' + title + ' adapt to support innovation in cutting-edge domains.',
    '',
    '## Key Takeaways',
    '',
    '- ' + title + ' is built upon a solid foundation of theoretical principles that guide its practical application',
    '- The key components and their interactions form the architecture through which ' + title + ' operates',
    '- Multiple methodologies exist for applying ' + title + ', each suited to different contexts and requirements',
    '- Real-world examples demonstrate the versatility and effectiveness of ' + title + ' across diverse scenarios',
    '- Practical applications span industries, research, education, and emerging technologies',
    '- Mastering ' + title + ' requires both conceptual understanding and hands-on experience',
    '',
    '## Practice Questions',
    '',
    '1. What are the fundamental principles that govern ' + title + ', and how do they influence its practical application in ' + courseTitle + '?',
    '   **Answer:** The fundamental principles provide a theoretical framework that guides decision-making and implementation. They establish the boundaries and possibilities for applying ' + title + ', ensuring that solutions are logically sound and consistent with established knowledge.',
    '',
    '2. How do the key components of ' + title + ' interact with each other, and what role does each component play in the overall system?',
    '   **Answer:** Each component serves a specific function within the architecture of ' + title + '. Their interactions define how the system behaves as a whole, with dependencies and communication pathways that must be understood for effective implementation.',
    '',
    '3. Describe a real-world scenario where ' + title + ' would be applied, outlining the steps and methodologies used.',
    '   **Answer:** In a typical application, practitioners first analyze the problem context, then select appropriate methodologies based on requirements. Implementation follows established patterns, and results are evaluated against success criteria. Adjustments are made iteratively to optimize outcomes.',
    '',
    '4. What are the common challenges encountered when working with ' + title + ', and how can they be addressed?',
    '   **Answer:** Common challenges include resource constraints, complexity management, and integration with existing systems. These can be addressed through careful planning, modular design, incremental implementation, and continuous evaluation and refinement.',
    '',
    '5. How does ' + title + ' connect with other concepts in ' + courseTitle + ', and why is this interconnected understanding important?',
    '   **Answer:** ' + title + ' relates to other concepts through dependencies, complementary functions, and shared principles. Understanding these connections enables holistic problem-solving and the ability to leverage multiple approaches for comprehensive solutions.',
    '',
    '## Summary',
    '',
    title + ' is a vital component of ' + contextStr + ', providing the knowledge and tools necessary for effective practice in ' + courseTitle + '. This lecture has covered the fundamental principles, key components, practical applications, and real-world examples that illustrate the importance and versatility of this topic.',
    '',
    'Mastering ' + title + ' requires ongoing study and practice. The concepts presented here form the foundation for further exploration and advanced study. By internalizing these principles and developing practical skills, you will be well-equipped to apply ' + title + ' effectively in academic, professional, and research contexts.',
  ].join('\n');

  const html = simpleMarkdownToHtml(markdown);

  return { markdown, html };
}

module.exports = { buildTemplateLecture };
