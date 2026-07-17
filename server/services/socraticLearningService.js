<<<<<<< HEAD
const StudentLearningProfile = require('../models/StudentLearningProfile');
const log = require('../utils/logger');
 
const SKIP_THRESHOLD = 80;
const MEDIUM_THRESHOLD = 50;
const HARD_THRESHOLD = 75;
 
async function getOrCreateProfile(userId, courseId, subject) {
  let profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) {
    profile = new StudentLearningProfile({ userId, courseId, subject, subtopicProgress: [] });
    await profile.save();
    log.info('SOCRATIC', `Created learning profile for user ${userId}`);
  }
  return profile;
}
 
async function recordAnswer(userId, subtopicId, subtopicName, isCorrect) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) throw new Error('Learning profile not found');
 
  let subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) {
    subtopic = {
      subtopicId,
      subtopicName,
      correctAnswers: 0,
      totalAttempts: 0,
      currentScore: 0,
      difficulty: 'easy',
      status: 'in_progress'
    };
    profile.subtopicProgress.push(subtopic);
  }
 
  subtopic.totalAttempts += 1;
  if (isCorrect) subtopic.correctAnswers += 1;
  subtopic.currentScore = Math.round((subtopic.correctAnswers / subtopic.totalAttempts) * 100);
  subtopic.lastAttemptDate = new Date();
 
  if (subtopic.currentScore >= HARD_THRESHOLD && subtopic.difficulty !== 'hard') {
    subtopic.difficulty = 'hard';
    log.info('SOCRATIC', `Student ${userId} progressed to HARD on ${subtopicName}`);
  } else if (subtopic.currentScore >= MEDIUM_THRESHOLD && subtopic.difficulty === 'easy') {
    subtopic.difficulty = 'medium';
    log.info('SOCRATIC', `Student ${userId} progressed to MEDIUM on ${subtopicName}`);
  }
 
  if (subtopic.currentScore >= SKIP_THRESHOLD) {
    subtopic.status = 'completed';
    log.info('SOCRATIC', `Student ${userId} COMPLETED ${subtopicName} with ${subtopic.currentScore}%`);
  }
 
  profile.learningCurve.push({
    date: new Date(),
    score: subtopic.currentScore,
    difficulty: subtopic.difficulty
  });
 
  profile.updatedAt = new Date();
  await profile.save();
  return subtopic;
}
 
async function shouldSkipSubtopic(userId, subtopicId) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return false;
  const subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) return false;
  return subtopic.currentScore >= SKIP_THRESHOLD && subtopic.status === 'completed';
}
 
async function getNextSubtopic(userId, allSubtopics) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return allSubtopics[0];
  for (const subtopic of allSubtopics) {
    const progress = profile.subtopicProgress.find(s => s.subtopicId === subtopic.id);
    if (!progress || progress.status !== 'completed') {
      return subtopic;
    }
  }
  return allSubtopics[0];
}
 
async function getStudentProgress(userId) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return null;
  const completedCount = profile.subtopicProgress.filter(s => s.status === 'completed').length;
  const totalCount = profile.subtopicProgress.length;
  const overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  profile.overallProgress = overallProgress;
  await profile.save();
  return {
    userId,
    overallProgress,
    subtopics: profile.subtopicProgress,
    learningCurve: profile.learningCurve.slice(-20)
  };
}
 
async function getAdaptivePrompt(userId, subtopicId, subtopicName) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return null;
  const subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) return null;
 
  const difficulty = subtopic.difficulty;
  const score = subtopic.currentScore;
 
  let systemPrompt = `You are a Socratic tutor teaching about "${subtopicName}".
Student's current score on this topic: ${score}%
Current difficulty level: ${difficulty}
 
`;
 
  if (difficulty === 'easy') {
    systemPrompt += `Ask SIMPLE, FOUNDATIONAL questions. Build confidence first.
Focus on basic concepts and definitions.
Encourage student to explain in their own words.`;
  } else if (difficulty === 'medium') {
    systemPrompt += `Ask INTERMEDIATE questions. Push deeper understanding.
Require students to apply concepts to new situations.
Ask "why" and "how" questions.`;
  } else {
    systemPrompt += `Ask CHALLENGING questions. Test advanced understanding.
Require critical thinking and synthesis of concepts.
Present edge cases and exceptions.
Ask them to defend their reasoning.`;
  }
 
  if (score >= 80) {
    systemPrompt += `\n\nSTUDENT IS EXCELLING - Start introducing advanced topics or related concepts.`;
  } else if (score < 30) {
    systemPrompt += `\n\nSTUDENT IS STRUGGLING - Simplify further and provide more scaffolding.`;
  }
 
  return systemPrompt;
}
 
module.exports = {
  getOrCreateProfile,
  recordAnswer,
  shouldSkipSubtopic,
  getNextSubtopic,
  getStudentProgress,
  getAdaptivePrompt
=======
const StudentLearningProfile = require('../models/StudentLearningProfile');
const log = require('../utils/logger');
 
const SKIP_THRESHOLD = 80;
const MEDIUM_THRESHOLD = 50;
const HARD_THRESHOLD = 75;
 
async function getOrCreateProfile(userId, courseId, subject) {
  let profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) {
    profile = new StudentLearningProfile({ userId, courseId, subject, subtopicProgress: [] });
    await profile.save();
    log.info('SOCRATIC', `Created learning profile for user ${userId}`);
  }
  return profile;
}
 
async function recordAnswer(userId, subtopicId, subtopicName, isCorrect) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) throw new Error('Learning profile not found');
 
  let subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) {
    subtopic = {
      subtopicId,
      subtopicName,
      correctAnswers: 0,
      totalAttempts: 0,
      currentScore: 0,
      difficulty: 'easy',
      status: 'in_progress'
    };
    profile.subtopicProgress.push(subtopic);
  }
 
  subtopic.totalAttempts += 1;
  if (isCorrect) subtopic.correctAnswers += 1;
  subtopic.currentScore = Math.round((subtopic.correctAnswers / subtopic.totalAttempts) * 100);
  subtopic.lastAttemptDate = new Date();
 
  if (subtopic.currentScore >= HARD_THRESHOLD && subtopic.difficulty !== 'hard') {
    subtopic.difficulty = 'hard';
    log.info('SOCRATIC', `Student ${userId} progressed to HARD on ${subtopicName}`);
  } else if (subtopic.currentScore >= MEDIUM_THRESHOLD && subtopic.difficulty === 'easy') {
    subtopic.difficulty = 'medium';
    log.info('SOCRATIC', `Student ${userId} progressed to MEDIUM on ${subtopicName}`);
  }
 
  if (subtopic.currentScore >= SKIP_THRESHOLD) {
    subtopic.status = 'completed';
    log.info('SOCRATIC', `Student ${userId} COMPLETED ${subtopicName} with ${subtopic.currentScore}%`);
  }
 
  profile.learningCurve.push({
    date: new Date(),
    score: subtopic.currentScore,
    difficulty: subtopic.difficulty
  });
 
  profile.updatedAt = new Date();
  await profile.save();
  return subtopic;
}
 
async function shouldSkipSubtopic(userId, subtopicId) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return false;
  const subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) return false;
  return subtopic.currentScore >= SKIP_THRESHOLD && subtopic.status === 'completed';
}
 
async function getNextSubtopic(userId, allSubtopics) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return allSubtopics[0];
  for (const subtopic of allSubtopics) {
    const progress = profile.subtopicProgress.find(s => s.subtopicId === subtopic.id);
    if (!progress || progress.status !== 'completed') {
      return subtopic;
    }
  }
  return allSubtopics[0];
}
 
async function getStudentProgress(userId) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return null;
  const completedCount = profile.subtopicProgress.filter(s => s.status === 'completed').length;
  const totalCount = profile.subtopicProgress.length;
  const overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  profile.overallProgress = overallProgress;
  await profile.save();
  return {
    userId,
    overallProgress,
    subtopics: profile.subtopicProgress,
    learningCurve: profile.learningCurve.slice(-20)
  };
}
 
async function getAdaptivePrompt(userId, subtopicId, subtopicName) {
  const profile = await StudentLearningProfile.findOne({ userId });
  if (!profile) return null;
  const subtopic = profile.subtopicProgress.find(s => s.subtopicId === subtopicId);
  if (!subtopic) return null;
 
  const difficulty = subtopic.difficulty;
  const score = subtopic.currentScore;
 
  let systemPrompt = `You are a Socratic tutor teaching about "${subtopicName}".
Student's current score on this topic: ${score}%
Current difficulty level: ${difficulty}
 
`;
 
  if (difficulty === 'easy') {
    systemPrompt += `Ask SIMPLE, FOUNDATIONAL questions. Build confidence first.
Focus on basic concepts and definitions.
Encourage student to explain in their own words.`;
  } else if (difficulty === 'medium') {
    systemPrompt += `Ask INTERMEDIATE questions. Push deeper understanding.
Require students to apply concepts to new situations.
Ask "why" and "how" questions.`;
  } else {
    systemPrompt += `Ask CHALLENGING questions. Test advanced understanding.
Require critical thinking and synthesis of concepts.
Present edge cases and exceptions.
Ask them to defend their reasoning.`;
  }
 
  if (score >= 80) {
    systemPrompt += `\n\nSTUDENT IS EXCELLING - Start introducing advanced topics or related concepts.`;
  } else if (score < 30) {
    systemPrompt += `\n\nSTUDENT IS STRUGGLING - Simplify further and provide more scaffolding.`;
  }
 
  return systemPrompt;
}
 
module.exports = {
  getOrCreateProfile,
  recordAnswer,
  shouldSkipSubtopic,
  getNextSubtopic,
  getStudentProgress,
  getAdaptivePrompt
>>>>>>> upstream/master
};