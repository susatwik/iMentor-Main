/**
 * server/models/StudentProfile.js
 * 
 * Student Learning Profile Model
 * 
 * Tracks:
 * - Mastery levels per topic (0-1 scale)
 * - Weak areas and struggle history
 * - Confidence levels and cognitive level
 * - Progress through curriculum
 * - Completed and skipped topics
 * - Quiz performance and streaks
 */

const mongoose = require('mongoose');

const StudentProfileSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },

    // Mastery tracking per topic (0.0 = novice, 1.0 = expert)
    mastery: {
        type: Map,
        of: {
            level: { type: Number, min: 0, max: 1, default: 0 },
            lastUpdated: { type: Date, default: Date.now },
            numAttempts: { type: Number, default: 0 },
            numCorrect: { type: Number, default: 0 }
        },
        default: new Map()
    },

    // Retry tracking (how many times failed before succeeding)
    retries: {
        type: Map,
        of: Number,
        default: new Map()
    },

    // Topics the student completed
    completedTopics: [{
        topicId: String,
        topicName: String,
        masteredAt: { type: Date, default: Date.now },
        masteryScore: { type: Number, min: 0, max: 1 }
    }],

    // Topics skipped due to high mastery
    skippedTopics: [{
        topicId: String,
        topicName: String,
        reason: String, // 'high_mastery' | 'prerequisite_missing' | 'user_requested'
        skippedAt: { type: Date, default: Date.now }
    }],

    // Topics the student struggles with
    weakAreas: [{
        conceptName: String,
        masteryLevel: { type: Number, min: 0, max: 1 },
        lastAttemptDate: Date,
        failureCount: { type: Number, default: 0 }
    }],

    // Overall learning profile
    confidenceLevel: {
        type: String,
        enum: ['beginner', 'intermediate', 'advanced', 'expert'],
        default: 'beginner'
    },

    // Cognitive level (Bloom's taxonomy)
    cognitiveLevel: {
        type: String,
        enum: ['L1_RECALL', 'L2_UNDERSTAND', 'L3_APPLY', 'L4_ANALYZE', 'L5_EVALUATE', 'L6_CREATE'],
        default: 'L1_RECALL'
    },

    // Learning speed (how quickly mastery increases)
    learningSpeed: {
        type: String,
        enum: ['slow', 'normal', 'fast'],
        default: 'normal'
    },

    // Curriculum progress
    curriculumProgress: {
        currentModule: String,
        currentTopic: String,
        currentSubtopic: String,
        progressPercentage: { type: Number, min: 0, max: 100, default: 0 }
    },

    // Performance metrics
    performance: {
        totalQuizzes: { type: Number, default: 0 },
        quizzesPassed: { type: Number, default: 0 },
        averageQuizScore: { type: Number, min: 0, max: 1, default: 0 },
        currentStreak: { type: Number, default: 0 },
        longestStreak: { type: Number, default: 0 },
        correctAnswers: { type: Number, default: 0 },
        totalAnswers: { type: Number, default: 0 }
    },

    // Adaptive learning recommendations
    recommendations: [{
        type: String,
        priority: { type: String, enum: ['high', 'medium', 'low'] },
        createdAt: { type: Date, default: Date.now }
    }],

    // Learning preferences
    preferences: {
        preferredDifficulty: {
            type: String,
            enum: ['easy', 'medium', 'hard'],
            default: 'medium'
        },
        preferredTopicSpeed: {
            type: String,
            enum: ['slow', 'medium', 'fast'],
            default: 'medium'
        },
        disableHints: { type: Boolean, default: false },
        enableSpacedRepetition: { type: Boolean, default: true }
    },

    // Metadata
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now, index: true },
    lastActiveDate: { type: Date, default: Date.now }
});

// Indexes for efficient querying
StudentProfileSchema.index({ userId: 1, 'mastery.level': -1 });
StudentProfileSchema.index({ userId: 1, updatedAt: -1 });

/**
 * Calculate overall mastery across all topics
 */
StudentProfileSchema.methods.calculateOverallMastery = function () {
    if (this.mastery.size === 0) return 0;

    let total = 0;
    let count = 0;

    this.mastery.forEach(topic => {
        total += topic.level;
        count++;
    });

    return count > 0 ? total / count : 0;
};

/**
 * Update mastery for a specific topic
 */
StudentProfileSchema.methods.updateTopicMastery = function (topicId, topicName, correct, total) {
    if (!this.mastery.has(topicId)) {
        this.mastery.set(topicId, {
            level: 0,
            numAttempts: 0,
            numCorrect: 0,
            lastUpdated: new Date()
        });
    }

    const topicMastery = this.mastery.get(topicId);
    topicMastery.numAttempts += total;
    topicMastery.numCorrect += correct;
    topicMastery.lastUpdated = new Date();

    // Calculate mastery as percentage of correct answers
    topicMastery.level = Math.min(1.0, topicMastery.numCorrect / topicMastery.numAttempts);

    // Update weak areas if mastery is low
    if (topicMastery.level < 0.5) {
        const existingWeak = this.weakAreas.find(w => w.conceptName === topicName);
        if (existingWeak) {
            existingWeak.masteryLevel = topicMastery.level;
            existingWeak.lastAttemptDate = new Date();
            existingWeak.failureCount++;
        } else {
            this.weakAreas.push({
                conceptName: topicName,
                masteryLevel: topicMastery.level,
                lastAttemptDate: new Date(),
                failureCount: 1
            });
        }
    }

    // Remove from weak areas if mastery improves
    if (topicMastery.level > 0.8) {
        this.weakAreas = this.weakAreas.filter(w => w.conceptName !== topicName);
    }

    // Update confidence level based on overall mastery
    const overall = this.calculateOverallMastery();
    if (overall < 0.3) {
        this.confidenceLevel = 'beginner';
    } else if (overall < 0.6) {
        this.confidenceLevel = 'intermediate';
    } else if (overall < 0.85) {
        this.confidenceLevel = 'advanced';
    } else {
        this.confidenceLevel = 'expert';
    }

    return this;
};

/**
 * Mark a topic as completed
 */
StudentProfileSchema.methods.completeTopic = function (topicId, topicName, masteryScore) {
    // Remove from skipped if it was there
    this.skippedTopics = this.skippedTopics.filter(t => t.topicId !== topicId);

    // Add to completed
    const completed = this.completedTopics.find(t => t.topicId === topicId);
    if (!completed) {
        this.completedTopics.push({
            topicId,
            topicName,
            masteredAt: new Date(),
            masteryScore: masteryScore || 1.0
        });
    }

    return this;
};

/**
 * Mark a topic as skipped (dynamic skip based on mastery)
 */
StudentProfileSchema.methods.skipTopic = function (topicId, topicName, reason = 'high_mastery') {
    // Remove from completed if it was there
    this.completedTopics = this.completedTopics.filter(t => t.topicId !== topicId);

    // Add to skipped
    const skipped = this.skippedTopics.find(t => t.topicId === topicId);
    if (!skipped) {
        this.skippedTopics.push({
            topicId,
            topicName,
            reason,
            skippedAt: new Date()
        });
    }

    return this;
};

/**
 * Get recommended next topics based on mastery and curriculum
 */
StudentProfileSchema.methods.getRecommendedTopics = function (allAvailableTopics, limit = 5) {
    if (!allAvailableTopics || allAvailableTopics.length === 0) return [];

    // Sort topics by:
    // 1. Not yet mastered
    // 2. Prerequisite satisfied
    // 3. Increasing difficulty
    return allAvailableTopics
        .filter(t => {
            const completed = this.completedTopics.some(c => c.topicId === t.id);
            const skipped = this.skippedTopics.some(s => s.topicId === t.id);
            return !completed && !skipped;
        })
        .sort((a, b) => {
            const masteryA = this.mastery.get(a.id)?.level || 0;
            const masteryB = this.mastery.get(b.id)?.level || 0;
            return masteryA - masteryB;
        })
        .slice(0, limit);
};

/**
 * Determine if student should skip a topic based on mastery
 */
StudentProfileSchema.methods.shouldSkipTopic = function (topicId) {
    const topicMastery = this.mastery.get(topicId);
    if (!topicMastery) return false;

    // Skip if already mastered (>80%)
    if (topicMastery.level > 0.8) return true;

    // Skip if already completed recently
    const completed = this.completedTopics.find(t => t.topicId === topicId);
    if (completed) return true;

    return false;
};

module.exports = mongoose.model('StudentProfile', StudentProfileSchema);
/**
 * server/models/StudentProfile.js
 * 
 * Student Learning Profile Model
 * 
 * Tracks:
 * - Mastery levels per topic (0-1 scale)
 * - Weak areas and struggle history
 * - Confidence levels and cognitive level
 * - Progress through curriculum
 * - Completed and skipped topics
 * - Quiz performance and streaks
 */

const mongoose = require('mongoose');

const StudentProfileSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },

    // Mastery tracking per topic (0.0 = novice, 1.0 = expert)
    mastery: {
        type: Map,
        of: {
            level: { type: Number, min: 0, max: 1, default: 0 },
            lastUpdated: { type: Date, default: Date.now },
            numAttempts: { type: Number, default: 0 },
            numCorrect: { type: Number, default: 0 }
        },
        default: new Map()
    },

    // Retry tracking (how many times failed before succeeding)
    retries: {
        type: Map,
        of: Number,
        default: new Map()
    },

    // Topics the student completed
    completedTopics: [{
        topicId: String,
        topicName: String,
        masteredAt: { type: Date, default: Date.now },
        masteryScore: { type: Number, min: 0, max: 1 }
    }],

    // Topics skipped due to high mastery
    skippedTopics: [{
        topicId: String,
        topicName: String,
        reason: String, // 'high_mastery' | 'prerequisite_missing' | 'user_requested'
        skippedAt: { type: Date, default: Date.now }
    }],

    // Topics the student struggles with
    weakAreas: [{
        conceptName: String,
        masteryLevel: { type: Number, min: 0, max: 1 },
        lastAttemptDate: Date,
        failureCount: { type: Number, default: 0 }
    }],

    // Overall learning profile
    confidenceLevel: {
        type: String,
        enum: ['beginner', 'intermediate', 'advanced', 'expert'],
        default: 'beginner'
    },

    // Cognitive level (Bloom's taxonomy)
    cognitiveLevel: {
        type: String,
        enum: ['L1_RECALL', 'L2_UNDERSTAND', 'L3_APPLY', 'L4_ANALYZE', 'L5_EVALUATE', 'L6_CREATE'],
        default: 'L1_RECALL'
    },

    // Learning speed (how quickly mastery increases)
    learningSpeed: {
        type: String,
        enum: ['slow', 'normal', 'fast'],
        default: 'normal'
    },

    // Curriculum progress
    curriculumProgress: {
        currentModule: String,
        currentTopic: String,
        currentSubtopic: String,
        progressPercentage: { type: Number, min: 0, max: 100, default: 0 }
    },

    // Performance metrics
    performance: {
        totalQuizzes: { type: Number, default: 0 },
        quizzesPassed: { type: Number, default: 0 },
        averageQuizScore: { type: Number, min: 0, max: 1, default: 0 },
        currentStreak: { type: Number, default: 0 },
        longestStreak: { type: Number, default: 0 },
        correctAnswers: { type: Number, default: 0 },
        totalAnswers: { type: Number, default: 0 }
    },

    // Adaptive learning recommendations
    recommendations: [{
        type: String,
        priority: { type: String, enum: ['high', 'medium', 'low'] },
        createdAt: { type: Date, default: Date.now }
    }],

    // Learning preferences
    preferences: {
        preferredDifficulty: {
            type: String,
            enum: ['easy', 'medium', 'hard'],
            default: 'medium'
        },
        preferredTopicSpeed: {
            type: String,
            enum: ['slow', 'medium', 'fast'],
            default: 'medium'
        },
        disableHints: { type: Boolean, default: false },
        enableSpacedRepetition: { type: Boolean, default: true }
    },

    // Metadata
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now, index: true },
    lastActiveDate: { type: Date, default: Date.now }
});

// Indexes for efficient querying
StudentProfileSchema.index({ userId: 1, 'mastery.level': -1 });
StudentProfileSchema.index({ userId: 1, updatedAt: -1 });

/**
 * Calculate overall mastery across all topics
 */
StudentProfileSchema.methods.calculateOverallMastery = function () {
    if (this.mastery.size === 0) return 0;

    let total = 0;
    let count = 0;

    this.mastery.forEach(topic => {
        total += topic.level;
        count++;
    });

    return count > 0 ? total / count : 0;
};

/**
 * Update mastery for a specific topic
 */
StudentProfileSchema.methods.updateTopicMastery = function (topicId, topicName, correct, total) {
    if (!this.mastery.has(topicId)) {
        this.mastery.set(topicId, {
            level: 0,
            numAttempts: 0,
            numCorrect: 0,
            lastUpdated: new Date()
        });
    }

    const topicMastery = this.mastery.get(topicId);
    topicMastery.numAttempts += total;
    topicMastery.numCorrect += correct;
    topicMastery.lastUpdated = new Date();

    // Calculate mastery as percentage of correct answers
    topicMastery.level = Math.min(1.0, topicMastery.numCorrect / topicMastery.numAttempts);

    // Update weak areas if mastery is low
    if (topicMastery.level < 0.5) {
        const existingWeak = this.weakAreas.find(w => w.conceptName === topicName);
        if (existingWeak) {
            existingWeak.masteryLevel = topicMastery.level;
            existingWeak.lastAttemptDate = new Date();
            existingWeak.failureCount++;
        } else {
            this.weakAreas.push({
                conceptName: topicName,
                masteryLevel: topicMastery.level,
                lastAttemptDate: new Date(),
                failureCount: 1
            });
        }
    }

    // Remove from weak areas if mastery improves
    if (topicMastery.level > 0.8) {
        this.weakAreas = this.weakAreas.filter(w => w.conceptName !== topicName);
    }

    // Update confidence level based on overall mastery
    const overall = this.calculateOverallMastery();
    if (overall < 0.3) {
        this.confidenceLevel = 'beginner';
    } else if (overall < 0.6) {
        this.confidenceLevel = 'intermediate';
    } else if (overall < 0.85) {
        this.confidenceLevel = 'advanced';
    } else {
        this.confidenceLevel = 'expert';
    }

    return this;
};

/**
 * Mark a topic as completed
 */
StudentProfileSchema.methods.completeTopic = function (topicId, topicName, masteryScore) {
    // Remove from skipped if it was there
    this.skippedTopics = this.skippedTopics.filter(t => t.topicId !== topicId);

    // Add to completed
    const completed = this.completedTopics.find(t => t.topicId === topicId);
    if (!completed) {
        this.completedTopics.push({
            topicId,
            topicName,
            masteredAt: new Date(),
            masteryScore: masteryScore || 1.0
        });
    }

    return this;
};

/**
 * Mark a topic as skipped (dynamic skip based on mastery)
 */
StudentProfileSchema.methods.skipTopic = function (topicId, topicName, reason = 'high_mastery') {
    // Remove from completed if it was there
    this.completedTopics = this.completedTopics.filter(t => t.topicId !== topicId);

    // Add to skipped
    const skipped = this.skippedTopics.find(t => t.topicId === topicId);
    if (!skipped) {
        this.skippedTopics.push({
            topicId,
            topicName,
            reason,
            skippedAt: new Date()
        });
    }

    return this;
};

/**
 * Get recommended next topics based on mastery and curriculum
 */
StudentProfileSchema.methods.getRecommendedTopics = function (allAvailableTopics, limit = 5) {
    if (!allAvailableTopics || allAvailableTopics.length === 0) return [];

    // Sort topics by:
    // 1. Not yet mastered
    // 2. Prerequisite satisfied
    // 3. Increasing difficulty
    return allAvailableTopics
        .filter(t => {
            const completed = this.completedTopics.some(c => c.topicId === t.id);
            const skipped = this.skippedTopics.some(s => s.topicId === t.id);
            return !completed && !skipped;
        })
        .sort((a, b) => {
            const masteryA = this.mastery.get(a.id)?.level || 0;
            const masteryB = this.mastery.get(b.id)?.level || 0;
            return masteryA - masteryB;
        })
        .slice(0, limit);
};

/**
 * Determine if student should skip a topic based on mastery
 */
StudentProfileSchema.methods.shouldSkipTopic = function (topicId) {
    const topicMastery = this.mastery.get(topicId);
    if (!topicMastery) return false;

    // Skip if already mastered (>80%)
    if (topicMastery.level > 0.8) return true;

    // Skip if already completed recently
    const completed = this.completedTopics.find(t => t.topicId === topicId);
    if (completed) return true;

    return false;
};

module.exports = mongoose.model('StudentProfile', StudentProfileSchema);
