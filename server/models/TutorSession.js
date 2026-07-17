const mongoose = require('mongoose');

const TutorSessionSchema = new mongoose.Schema(
    {
        sessionId: { type: String, required: true, unique: true, index: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        topic: { type: String, default: null },
        title: { type: String, default: 'New Chat' },
        moduleId: { type: String, default: null },
        courseId: { type: String, default: null },
        cognitiveLevel: { type: String, default: 'L1_CONCEPT' },
        masteryScore: { type: Number, default: 0 },
        attemptHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
        state: { type: mongoose.Schema.Types.Mixed, default: {} },

        // Fields used by guidedLearningOrchestrator
        studentLevel: { type: String, default: 'unknown' },
        subject: { type: String, default: 'General Knowledge' },
        course: { type: String, default: 'General Course' },
        documentContext: { type: String, default: null },
        knowledgeGaps: [{
            concept: String,
            identified: { type: Date, default: Date.now },
            resolved: { type: Boolean, default: false }
        }],
        conversationContext: [{
            sender: { type: String, enum: ['student', 'tutor', 'system'] },
            message: String,
            comprehensionLevel: Number,
            timestamp: { type: Date, default: Date.now }
        }],
        previousHints: [String],
        progressTracking: {
            totalInteractions: { type: Number, default: 0 },
            successfulGuidance: { type: Number, default: 0 },
            conceptsUnderstood: [String],
            conceptsStruggling: [String]
        },
        struggleCount: { type: Number, default: 0 },
        emotionalState: { type: String, default: 'CURIOUS' },
        supportLevel: { type: String, default: 'MINIMAL' },
        status: { type: String, default: 'active' },
        learningGoal: { type: String, default: '' },

        // Socratic Learning Persistence Enhancements
        currentCourse: { type: String, default: null },
        currentModule: { type: String, default: null },
        currentTopic: { type: String, default: null },
        learningStage: { type: String, default: 'Beginner' },
        strongTopics: [{ type: String }],
        weakTopics: [{ type: String }],
        hintCount: { type: Number, default: 0 },
        consecutiveCorrect: { type: Number, default: 0 },
        consecutiveIncorrect: { type: Number, default: 0 },
        lastInteractionAt: { type: Date, default: Date.now },
        sessionDuration: { type: Number, default: 0 }
    },
    { timestamps: true }
);

// Method to record student/tutor interaction
TutorSessionSchema.methods.addInteraction = function (sender, message, comprehensionLevel = null) {
    this.conversationContext.push({
        sender,
        message,
        comprehensionLevel,
        timestamp: new Date()
    });
    this.progressTracking.totalInteractions += 1;
};

// Method to record hints
TutorSessionSchema.methods.recordHint = function (hint) {
    this.previousHints.push(hint);
};

// Method to assess student learning level dynamically
TutorSessionSchema.methods.assessStudentLevel = function () {
    let level = this.studentLevel || 'BEGINNER';

    // Simple heuristic calculation inside the session
    if (this.masteryScore >= 3.5 && this.struggleCount === 0) {
        level = 'ADVANCED';
    } else if (this.masteryScore >= 2.0 && this.struggleCount <= 1) {
        level = 'INTERMEDIATE';
    }

    if (this.userId) {
        // Asynchronous background evaluation to update User profile
        const User = mongoose.model('User');
        const StudentKnowledgeState = mongoose.model('StudentKnowledgeState');

        Promise.all([
            User.findById(this.userId),
            StudentKnowledgeState.findOne({ userId: this.userId })
        ]).then(([user, ks]) => {
            if (!user) return;

            // 1. Quiz performance
            let totalQuizzes = 0;
            let passedQuizzes = 0;
            if (user.curriculumProgress) {
                for (const [course, prog] of user.curriculumProgress.entries()) {
                    if (prog.quizResults) {
                        for (const score of prog.quizResults.values()) {
                            totalQuizzes++;
                            const parsedScore = parseFloat(score);
                            if (!isNaN(parsedScore) && parsedScore >= 80) {
                                passedQuizzes++;
                            }
                        }
                    }
                }
            }

            // 2. Concept mastery
            let totalConcepts = 0;
            let masteredConcepts = 0;
            if (ks && ks.concepts) {
                totalConcepts = ks.concepts.length;
                masteredConcepts = ks.concepts.filter(
                    c => c.masteryScore >= 85 || c.understandingLevel === 'mastered'
                ).length;
            }

            // 3. Interaction history
            const totalInteractions = this.progressTracking.totalInteractions || 0;
            const struggleRatio = totalInteractions > 0 ? (this.struggleCount / totalInteractions) : 0;

            // Determine final level
            let finalLevel = 'BEGINNER';
            let score = 0;
            if (totalQuizzes > 0) {
                score += (passedQuizzes / totalQuizzes) * 40;
            }
            if (totalConcepts > 0) {
                score += (masteredConcepts / totalConcepts) * 40;
            }
            score += Math.max(0, (1 - struggleRatio) * 20);

            if (score >= 75 || masteredConcepts >= 5) {
                finalLevel = 'ADVANCED';
            } else if (score >= 40 || masteredConcepts >= 2) {
                finalLevel = 'INTERMEDIATE';
            }

            // Update user profile dynamically if changed
            if (user.profile.learningLevel !== finalLevel) {
                user.profile.learningLevel = finalLevel;
                user.save().catch(err => console.error('Failed to save user learningLevel:', err));
            }
        }).catch(err => console.error('Error in background assessStudentLevel:', err));
    }

    return level;
};

module.exports = mongoose.models.TutorSession || mongoose.model('TutorSession', TutorSessionSchema);