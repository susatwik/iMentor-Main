const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { buildTemplateLecture } = require('../services/lectureTemplateBuilder');
const { validateLecture } = require('../services/lectureQualityValidator');
const Lecture = require('../models/Lecture');
const { redisClient, connectRedis } = require('../config/redisClient');

// ── Missing courses with their syllabus data ──────────────────────
const missingCourses = [
  // EE Elective
  { code: 'EE3751', name: 'New Venture Creation', credits: 3, category: 'DEC', semester: 6,
    modules: [
      { name: 'Module 1', topics: [
        { topic: 'Entrepreneurial Mindset and Opportunity Recognition', subtopics: ['Entrepreneurial mindset', 'Opportunity identification', 'Creativity and innovation', 'Problem-solution fit'] },
        { topic: 'Business Model Development', subtopics: ['Business model canvas', 'Value proposition design', 'Customer segments', 'Revenue models'] },
      ]},
      { name: 'Module 2', topics: [
        { topic: 'Market Analysis and Validation', subtopics: ['Market research methods', 'Customer discovery', 'Competitive analysis', 'Minimum viable product'] },
        { topic: 'Financial Planning for Startups', subtopics: ['Financial projections', 'Funding sources', 'Bootstrapping vs venture capital', 'Unit economics'] },
      ]},
      { name: 'Module 3', topics: [
        { topic: 'Legal and Operational Aspects', subtopics: ['Business registration', 'Intellectual property', 'Team building', 'Pitch deck creation'] },
        { topic: 'Growth and Scaling', subtopics: ['Growth strategies', 'Scaling operations', 'Exit strategies', 'Social entrepreneurship'] },
      ]},
    ]
  },

  // Engineering Science
  { code: 'ME1072', name: 'Engineering Graphics with CAD', credits: 1, category: 'ESC', semester: 2,
    modules: [
      { name: 'Module 1', topics: [
        { topic: 'Introduction to Engineering Drawing', subtopics: ['Drawing instruments', 'Sheet layout', 'Line types and dimensioning', 'Scales'] },
        { topic: 'Orthographic Projections', subtopics: ['Projection systems', 'First angle projection', 'Third angle projection', 'Multiple views'] },
      ]},
      { name: 'Module 2', topics: [
        { topic: 'Isometric and Pictorial Drawings', subtopics: ['Isometric projection', 'Oblique projection', 'Perspective drawing', 'Sectional views'] },
        { topic: 'CAD Fundamentals', subtopics: ['CAD interface', 'Drawing commands', 'Editing commands', 'Layer management and plotting'] },
      ]},
    ]
  },

  // NCC/Social Service
  { code: 'HS2052', name: 'National Service Scheme', credits: 1, category: 'HSC', semester: 7,
    modules: [
      { name: 'Module 1: Waste Management Services', topics: [
        { topic: 'Waste Segregation and Composting', subtopics: ['Waste segregation methods', 'Composting techniques', '3R concepts', 'Environmental awareness'] },
      ]},
      { name: 'Module 2: Community Engagement', topics: [
        { topic: 'Social Responsibility', subtopics: ['Health awareness programs', 'Consumer awareness', 'Women empowerment', 'Road safety and first aid'] },
      ]},
      { name: 'Module 3: Volunteerism and Citizenship', topics: [
        { topic: 'Community Service', subtopics: ['Blood donation camps', 'Tree plantation', 'Swachh Bharat initiatives', 'Digital literacy campaigns'] },
      ]},
    ]
  },
];

// ── Liberal Arts / HSC Courses ───────────────────────────────────
const hsCourses = [
  { code: 'HS3031', name: 'Indian Philosophy', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Indian Philosophy', subtopics: ['Veda and Upanishads', 'Origin of Indian Philosophy'] },
      { topic: 'Schools of Philosophy', subtopics: ['Charvaka Philosophy', 'Samkhya Philosophy', 'Yoga Philosophy', 'Nyaya Philosophy', 'Mimansa Philosophy', 'Vaisesika Philosophy'] },
    ]}] },
  { code: 'HS3041', name: 'Introduction to Psychology', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Foundations of Psychology', subtopics: ['Meaning and definitions', 'History of Psychology', 'Learning theories', 'Memory and motivation'] },
      { topic: 'Interpersonal Relationships', subtopics: ['Importance for engineers', 'Communication skills', 'Conflict resolution'] },
      { topic: 'Stress Management', subtopics: ['Understanding stress', 'Coping strategies', 'Mental health awareness'] },
    ]}] },
  { code: 'HS3051', name: 'Psychology of Wellbeing', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Health Psychology', subtopics: ['Health and wellbeing', 'Models of health', 'Holistic health'] },
      { topic: 'Stress and Coping', subtopics: ['Nature of stress', 'Personal mediators', 'Coping mechanisms'] },
      { topic: 'Health Management', subtopics: ['Exercise and nutrition', 'Meditation and yoga', 'Health protective behaviors'] },
      { topic: 'Human Strengths', subtopics: ['Identifying strengths', 'Hope and optimism', 'Life enhancement'] },
    ]}] },
  { code: 'HS3061', name: 'Introduction to Mass Communication', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Foundations of Mass Communication', subtopics: ['Communication models', 'Functions of mass media', 'Evolution of mass media'] },
      { topic: 'Media Industries', subtopics: ['Ownership structures', 'Media concentration', 'Regulation and policy'] },
      { topic: 'Media Effects', subtopics: ['Audience analysis', 'Media effects theories', 'Agenda setting', 'Digital media'] },
    ]}] },
  { code: 'HS3071', name: 'Introduction to Media Studies', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Foundations of Media Studies', subtopics: ['Key concepts', 'Media ecology', 'Historical development'] },
      { topic: 'Media Theories', subtopics: ['Frankfurt School', 'Cultural studies', 'Medium theory'] },
      { topic: 'Media Representation', subtopics: ['Semiotics', 'Identity representation', 'Stereotyping'] },
      { topic: 'Digital Media', subtopics: ['Social media platforms', 'Participatory culture', 'Algorithmic culture'] },
    ]}] },
  { code: 'HS3091', name: 'Indian Heritage and Culture', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Indian Cultural Heritage', subtopics: ['Religious diversity', 'Philosophical traditions', 'Festivals and traditions'] },
      { topic: 'Modern Indian Society', subtopics: ['Social harmony', 'Gender sensitivity', 'National integration'] },
      { topic: 'Scientific Development', subtopics: ['Industry and agriculture', 'Medicine and space', 'Communication technology'] },
    ]}] },
  { code: 'HS3101', name: 'Indian Business History', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Historical Evolution', subtopics: ['East India Company', 'Industrial houses', 'Swadeshi movement'] },
      { topic: 'Post-Independence Era', subtopics: ['Industrial planning', 'PSU evolution', 'License Raj'] },
      { topic: 'Modern Business', subtopics: ['Liberalization', 'Contemporary trends', 'Oil diplomacy'] },
    ]}] },
  { code: 'HS3111', name: 'Post-Harvest Technology', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Postharvest Fundamentals', subtopics: ['Importance of postharvest technology', 'Maturity indices', 'Harvesting and handling'] },
      { topic: 'Quality Management', subtopics: ['Quality parameters', 'Storage methods', 'Ripening processes'] },
      { topic: 'Processing Technologies', subtopics: ['Grading and sorting', 'Packaging', 'Cold chain management'] },
    ]}] },
  { code: 'HS3121', name: 'Ethics in Technology', credits: 1, category: 'HSC', semester: 6,
    modules: [
      { name: 'Module 1: Foundations of Ethics and Technology', topics: [
        { topic: 'Ethical Theories', subtopics: ['Utilitarianism', 'Deontology', 'Virtue ethics', 'Ethical reasoning'] },
      ]},
      { name: 'Module 2: Data Privacy and Surveillance', topics: [
        { topic: 'Privacy in Digital Age', subtopics: ['Data collection', 'Consent', 'GDPR', 'Surveillance'] },
      ]},
      { name: 'Module 3: AI and Automation', topics: [
        { topic: 'AI Ethics', subtopics: ['Algorithmic bias', 'Automation ethics', 'Autonomous systems'] },
      ]},
      { name: 'Module 4: Society and Future', topics: [
        { topic: 'Responsible Technology', subtopics: ['Inclusive design', 'E-waste', 'Misinformation', 'Tech for social good'] },
      ]},
    ]
  },
  { code: 'HS3131', name: 'Financial Marketing', credits: 1, category: 'HSC', semester: 6,
    modules: [
      { name: 'Module 1: Indian Financial System', topics: [{ topic: 'Financial Markets', subtopics: ['Primary and secondary markets', 'Stock exchanges', 'NSE and BSE'] }] },
      { name: 'Module 2: Capital Market', topics: [{ topic: 'Capital Markets', subtopics: ['New issue market', 'IPO process', 'Debt market'] }] },
      { name: 'Module 3: Money Market', topics: [{ topic: 'Money Markets', subtopics: ['Treasury bills', 'Commercial paper', 'Repo market'] }] },
      { name: 'Module 4: Commodity Market', topics: [{ topic: 'Commodities', subtopics: ['Commodity exchanges', 'Derivatives', 'Global commodities'] }] },
    ]
  },
  { code: 'HS3141', name: 'Bharatiya Nyaya Sanhita: Indian Judicial Code Overview', credits: 1, category: 'HSC', semester: 6,
    modules: [
      { name: 'Module 1: Introduction to BNS', topics: [{ topic: 'Historical Development', subtopics: ['IPC to BNS', 'Structure of BNS', 'Role of criminal law'] }] },
      { name: 'Module 2: Judicial Principles', topics: [{ topic: 'Legal Principles', subtopics: ['Natural justice', 'Rule of law', 'Legal maxims'] }] },
      { name: 'Module 3: Judicial Procedures', topics: [{ topic: 'Court System', subtopics: ['Court structure', 'Trial process', 'Legal remedies'] }] },
      { name: 'Module 4: Rights and Duties', topics: [{ topic: 'Constitutional Rights', subtopics: ['Fundamental rights', 'Criminal procedure', 'Industrial law'] }] },
    ]
  },
  { code: 'HS3151', name: 'Introduction to the Constitution of India', credits: 1, category: 'HSC', semester: 6,
    modules: [
      { name: 'Module 1: Historical Context', topics: [{ topic: 'Constitutional Development', subtopics: ['Constituent Assembly', 'Preamble', 'Basic structure doctrine'] }] },
      { name: 'Module 2: Fundamental Rights', topics: [{ topic: 'Rights and Duties', subtopics: ['Fundamental Rights', 'Directive Principles', 'Fundamental Duties'] }] },
      { name: 'Module 3: Institutional Framework', topics: [{ topic: 'Government Structure', subtopics: ['Union-State relations', 'Parliamentary system', 'Judiciary'] }] },
    ]
  },
  { code: 'HS3162', name: 'Photography', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Fundamentals of Photography', subtopics: ['Camera basics', 'Exposure triangle', 'Composition principles', 'Lighting techniques'] },
      { topic: 'Digital Photography', subtopics: ['Digital sensors', 'Image processing', 'Post-production', 'Portfolio development'] },
    ]}] },
  { code: 'HS3172', name: 'Pottery', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Pottery', subtopics: ['Clay types and preparation', 'Hand building techniques', 'Wheel throwing', 'Glazing and firing'] },
    ]}] },
  { code: 'HS3182', name: 'Painting', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Fundamentals of Painting', subtopics: ['Color theory', 'Painting techniques', 'Mediums and materials', 'Art history overview'] },
    ]}] },
  { code: 'HS3192', name: 'Music', credits: 1, category: 'HSC', semester: 6,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Music', subtopics: ['Music theory basics', 'Indian classical music', 'Western music', 'Vocal and instrumental practice'] },
    ]}] },
  { code: 'HS3501', name: 'Sanskrit', credits: 3, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Sanskrit Linguistics', subtopics: ['Linguistic features', 'Phonetics and script', 'Basic conversation skills'] },
      { topic: 'Grammar and Verb Structures', subtopics: ['Noun usage and gender', 'Vibhakthi', 'Verb conjugation', 'Tenses'] },
      { topic: 'Panini Grammar', subtopics: ['Astadhyayi', 'Sound patterns', 'Sandhi rules', 'Compound words'] },
      { topic: 'Sanskrit Literature', subtopics: ['Prose and poetry', 'Mahabharata and Ramayana', 'Philosophical texts'] },
    ]}] },
  { code: 'HS3511', name: 'Introduction to Academic Writing', credits: 1, category: 'HSC', semester: 7,
    modules: [
      { name: 'Module 1', topics: [
        { topic: 'Principles of Effective Writing', subtopics: ['Writing process', 'Structuring paragraphs', 'Thesis statements', 'IMRaD structure'] },
      ]},
      { name: 'Module 2', topics: [
        { topic: 'Editing and Revision', subtopics: ['Global editing', 'Style and voice', 'Source citation', 'Avoiding plagiarism'] },
      ]},
    ]
  },
  { code: 'HS3521', name: 'Contemporary Issues in Philosophy of Mind & Cognition', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Philosophy of Mind', subtopics: ['Cartesian dualism', 'Behaviorism', 'Identity theory', 'Functionalism'] },
      { topic: 'Minds and Machines', subtopics: ['Computationalism', 'Connectionism', 'Artificial intelligence', 'Consciousness'] },
      { topic: 'Language and Representation', subtopics: ['Mental representation', 'Intentionality', 'Qualia'] },
    ]}] },
  { code: 'HS3531', name: 'Psychology and Mental Health', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Psychology', subtopics: ['Definition and history', 'Psychological perspectives', 'Fields of psychology'] },
      { topic: 'Mental Health Literacy', subtopics: ['Mental health definition', 'Common myths', 'Strategies for wellbeing'] },
      { topic: 'Stress Management', subtopics: ['Sources of stress', 'Cognitive distortions', 'Grounding techniques'] },
      { topic: 'Psychological Counseling', subtopics: ['Counseling goals', 'Mental health professionals', 'Therapeutic relationship'] },
    ]}] },
  { code: 'HS3541', name: 'Psychology at Work', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Work Psychology', subtopics: ['Individual differences', 'Cognitive ability', 'Personality'] },
      { topic: 'Motivation and Goals', subtopics: ['Theories of motivation', 'Goal setting', 'Performance'] },
      { topic: 'Stress at Workplace', subtopics: ['Types of stress', 'Work stressors', 'Stress management'] },
      { topic: 'Group Behavior', subtopics: ['Group dynamics', 'Team coordination', 'Decision making'] },
    ]}] },
  { code: 'HS3551', name: 'Introduction to Journalism', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Foundations of Journalism', subtopics: ['Role in society', 'Core principles', 'News values'] },
      { topic: 'Research and Sourcing', subtopics: ['Source evaluation', 'Interview techniques', 'Public records'] },
      { topic: 'News Writing', subtopics: ['Headlines and leads', 'Story structure', 'Attribution'] },
      { topic: 'Media Ethics', subtopics: ['Ethical codes', 'Privacy', 'Misinformation'] },
    ]}] },
  { code: 'HS3561', name: 'Introduction to Film Studies', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Film Language', subtopics: ['Mise-en-scene', 'Cinematography', 'Editing', 'Sound design'] },
      { topic: 'Film History', subtopics: ['Early cinema', 'Classical Hollywood', 'World cinema movements'] },
      { topic: 'Genre and Representation', subtopics: ['Genre theory', 'Representation studies', 'Cultural analysis'] },
    ]}] },
  { code: 'HS3571', name: 'Introduction to Anthropology', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Meaning and Nature', subtopics: ['Definition and scope', 'Bio-social nature', 'Holistic perspective'] },
      { topic: 'Development of Anthropology', subtopics: ['Historical roots', 'Major branches', 'Field work tradition'] },
      { topic: 'Core Concepts', subtopics: ['Culture and society', 'Kinship', 'Religion and magic', 'Language and communication'] },
    ]}] },
  { code: 'HS3581', name: 'Ethics for AI', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Responsible AI', subtopics: ['Responsible AI principles', 'Explainable AI', 'Transparency'] },
      { topic: 'AI Ethics Issues', subtopics: ['Privacy concerns', 'Algorithmic bias', 'Fairness', 'Accountability'] },
      { topic: 'AI Regulation', subtopics: ['EU AI Act', 'Indian AI regulation', 'Global frameworks'] },
    ]}] },
  { code: 'HS3591', name: 'Introduction to Sociology', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Sociological Perspective', subtopics: ['Sociological imagination', 'Micro and macro analysis'] },
      { topic: 'Sociological Theory', subtopics: ['Marx, Durkheim, Weber', 'Functionalism', 'Conflict theory'] },
      { topic: 'Social Structure', subtopics: ['Culture and socialization', 'Social institutions', 'Stratification'] },
    ]}] },
  { code: 'HS3601', name: 'Personal Finance', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Behavioral Finance', subtopics: ['Expected utility', 'Time value of money', 'Biases in finance'] },
      { topic: 'Personal Financial Planning', subtopics: ['Budgeting', 'Insurance', 'Investment strategies'] },
      { topic: 'Investment Vehicles', subtopics: ['Stocks and bonds', 'Mutual funds', 'FDs and securities'] },
    ]}] },
  { code: 'HS3611', name: 'Introductory Economics', credits: 1, category: 'HSC', semester: 7,
    modules: [
      { name: 'Module I: Basics', topics: [{ topic: 'Economic Fundamentals', subtopics: ['Definitions', 'Micro vs Macro', 'Basic problems'] }] },
      { name: 'Module II: Demand and Supply', topics: [{ topic: 'Market Mechanics', subtopics: ['Demand and supply', 'Elasticity', 'Equilibrium price'] }] },
      { name: 'Module III: Production', topics: [{ topic: 'Production Theory', subtopics: ['Factors of production', 'Production function', 'Economies of scale'] }] },
      { name: 'Module IV: National Income', topics: [{ topic: 'National Income', subtopics: ['Concepts', 'Measurement', 'Significance'] }] },
    ]
  },
  { code: 'HS3621', name: 'Cyber Law for Engineers', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Cyber Law Framework', subtopics: ['IT Act overview', 'Cyber crimes', 'Jurisdiction issues'] },
      { topic: 'Cyber Crimes', subtopics: ['Hacking', 'Identity theft', 'Cyber stalking', 'Cyber terrorism'] },
      { topic: 'Data Protection', subtopics: ['Data privacy', 'GDPR', 'DPDP Act 2023', 'Emerging issues'] },
    ]}] },
  { code: 'HS3631', name: 'Food and Nutrition', credits: 1, category: 'HSC', semester: 7,
    modules: [
      { name: 'Module 1: Introduction', topics: [{ topic: 'Food and Nutrition Basics', subtopics: ['Human biology', 'Vital parameters', 'Health check'] }] },
      { name: 'Module 2: Nutrients', topics: [{ topic: 'Macro and Micro Nutrients', subtopics: ['Carbohydrates', 'Proteins', 'Fats', 'Vitamins', 'Minerals'] }] },
      { name: 'Module 3: Energy Metabolism', topics: [{ topic: 'Energy and Digestion', subtopics: ['BMR', 'Digestion', 'Absorption'] }] },
      { name: 'Module 4: Diet and Health', topics: [{ topic: 'Dietary Planning', subtopics: ['Balanced diet', 'Deficiency diseases', 'Therapeutic nutrition'] }] },
    ]
  },
  { code: 'HS3641', name: 'Youth, Gender and Identity', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Youth and Identity', subtopics: ['Transition to adulthood', 'Family relationships', 'Peer identity', 'Youth culture'] },
      { topic: 'Gender and Identity', subtopics: ['Gender concepts', 'Sexuality issues', 'Gender discrimination', 'Women empowerment'] },
      { topic: 'Legal Framework', subtopics: ['Juvenile Justice', 'LGBT rights', 'UNICEF programs'] },
    ]}] },
  { code: 'HS3652', name: 'Dance', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Dance', subtopics: ['Dance forms', 'Basic movements', 'Choreography', 'Performance'] },
    ]}] },
  { code: 'HS3662', name: 'Theatre Arts', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Theatre', subtopics: ['Theatre history', 'Acting techniques', 'Stagecraft', 'Play production'] },
    ]}] },
  { code: 'HS3672', name: 'Sculpture', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Introduction to Sculpture', subtopics: ['Sculpting materials', 'Modeling techniques', 'Carving', 'Installation art'] },
    ]}] },
  { code: 'HS3682', name: 'Introduction to Animation', credits: 1, category: 'HSC', semester: 7,
    modules: [{ name: 'Module 1', topics: [
      { topic: 'Fundamentals of Animation', subtopics: ['2D animation', 'Character design', 'Storyboarding', 'Digital tools'] },
      { topic: 'Animation Production', subtopics: ['Digital art', 'Sound design', 'Video editing', 'Portfolio development'] },
    ]}] },
];

const allMissing = [...missingCourses, ...hsCourses];

// ── Helper ────────────────────────────────────────────────────────
function slugify(text) {
  return text.replace(/[^a-zA-Z0-9_ ]/g, ' ').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function generateSyllabusCSV(course) {
  const lines = ['Course Code,Course Name,Module,Lecture Topic,Subtopics,Prerequisites'];
  for (const mod of course.modules) {
    for (const topic of mod.topics) {
      const subtopics = (topic.subtopics || []).join('; ');
      lines.push(`${course.code},${course.name},${mod.name},"${topic.topic}","${subtopics}",None`);
    }
  }
  return lines.join('\n');
}

function generateModulesCSV(course) {
  const lines = ['Module,Topics,Subtopics'];
  for (const mod of course.modules) {
    for (const topic of mod.topics) {
      const subtopics = (topic.subtopics || []).join('; ');
      lines.push(`${mod.name}|${topic.topic}|${subtopics}`);
    }
  }
  return lines.join('\n');
}

async function createBootstrap(course) {
  const dir = path.join(__dirname, '..', 'course_bootstrap', course.code);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'syllabus.csv'), generateSyllabusCSV(course));
  console.log(`  Created bootstrap/${course.code}/syllabus.csv`);
}

async function generateLecture(course) {
  // For each subtopic in each module, generate a lecture
  const lectureData = {
    course: course.code,
    courseName: course.name,
    modules: course.modules,
  };

  for (const mod of course.modules) {
    for (const topic of mod.topics) {
      for (const sub of (topic.subtopics || [])) {
        const subId = slugify(sub);
        const cacheKey = `lecture:${course.code}:${subId}`;

        // Check if already cached
        if (redisClient && redisClient.isOpen) {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            console.log(`  [SKIP] ${course.code}/${subId} already cached`);
            continue;
          }
        }

        // Check MongoDB
        const existing = await Lecture.findOne({ course: course.code, subtopicId: subId }).lean();
        if (existing) {
          const validation = validateLecture(existing.markdown, subId, sub, course.code);
          if (validation.valid) {
            console.log(`  [SKIP] ${course.code}/${subId} already in Mongo (valid)`);
            continue;
          }
        }

        // Generate template lecture
        const result = buildTemplateLecture(course.code, subId, sub, topic.topic, mod.name);
        const validation = validateLecture(result.markdown, subId, sub, course.code);

        if (validation.valid) {
          const doc = {
            course: course.code,
            subtopicId: subId,
            subtopicName: sub || '',
            topicName: topic.topic || '',
            moduleName: mod.name || '',
            markdown: result.markdown,
            html: result.html || '',
            conceptMap: '',
            contentType: 'subtopic',
            source: 'template_fallback',
          };
          await Lecture.findOneAndUpdate(
            { course: course.code, subtopicId: subId },
            { $set: doc },
            { upsert: true }
          );
          if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(cacheKey, 7 * 24 * 3600, JSON.stringify(doc));
          }
          const wc = result.markdown.split(/\s+/).filter(Boolean).length;
          console.log(`  [GEN]  ${course.code}/${subId} (${wc}w)`);
        } else {
          console.log(`  [FAIL] ${course.code}/${subId}: ${validation.reasons.join(', ')}`);
        }
      }
    }
  }
}

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');
  await connectRedis();

  console.log(`\n=== Importing ${allMissing.length} missing courses ===\n`);

  let imported = 0;
  for (const course of allMissing) {
    console.log(`\n--- ${course.code}: ${course.name} (${course.credits}cr, ${course.category}) ---`);

    // STEP A: Create bootstrap directory + syllabus.csv
    await createBootstrap(course);

    // STEP B: Generate lectures for each subtopic
    await generateLecture(course);

    imported++;
  }

  // Final count
  const bootstrapDir = path.join(__dirname, '..', 'course_bootstrap');
  const dirs = fs.readdirSync(bootstrapDir).filter(d => {
    const p = path.join(bootstrapDir, d);
    return fs.statSync(p).isDirectory() && !d.startsWith('.') && d !== 'topics' && d !== 'syllabus.pdf';
  });

  const totalLectures = await Lecture.countDocuments({});
  console.log(`\n=== IMPORT COMPLETE ===`);
  console.log(`Courses imported: ${imported}`);
  console.log(`Total bootstrap directories: ${dirs.length}`);
  console.log(`Total lectures in MongoDB: ${totalLectures}`);

  await mongoose.disconnect();
  if (redisClient && redisClient.isOpen) await redisClient.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
