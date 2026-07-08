const mongoose = require('mongoose');

const ResourceSchema = new mongoose.Schema({
    type: { type: String, enum: ['lecture', 'video', 'reading', 'practice', 'external', 'discussion', 'revision'], default: 'reading' },
    title: { type: String },
    url: { type: String },
    description: { type: String }
}, { _id: false });

const MiniAssessmentSchema = new mongoose.Schema({
    questions: [{
        id: { type: String },
        type: { type: String, enum: ['mcq', 'scenario', 'fill_blank', 'match', 'short_answer', 'reasoning', 'case_study'], default: 'mcq' },
        question: { type: String },
        options: [{ type: String }],
        correctAnswer: { type: mongoose.Schema.Types.Mixed },
        explanation: { type: String },
        bloomsLevel: { type: String, enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'], default: 'understand' },
        difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' }
    }],
    passingScore: { type: Number, default: 70 },
    maxAttempts: { type: Number, default: 3 }
}, { _id: false });

const AiTutorPromptSchema = new mongoose.Schema({
    systemPrompt: { type: String },
    suggestedQuestions: [{ type: String }],
    teachingApproach: { type: String, enum: ['socratic', 'direct', 'exploratory', 'scaffolded'], default: 'socratic' },
    contextHints: [{ type: String }]
}, { _id: false });

const KnowledgeGapSchema = new mongoose.Schema({
    nodeId: { type: String },
    nodeName: { type: String },
    gapType: { type: String, enum: ['conceptual', 'procedural', 'reasoning', 'application', 'prerequisite'], default: 'conceptual' },
    severity: { type: Number, min: 0, max: 1, default: 0.5 },
    description: { type: String },
    detectedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    suggestedReviewOrder: { type: Number },
    suggestedResources: [{ type: String }]
}, { _id: false });

const NodeAttemptSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    quizScore: { type: Number },
    reflection: { type: String },
    agentFeedback: { type: String },
    confidence: { type: Number, min: 0, max: 1 },
    misconceptions: [{ type: String }],
    timeSpent: { type: Number },
    evaluation: {
        correctness: { type: Number, min: 0, max: 1 },
        reasoning: { type: Number, min: 0, max: 1 },
        depth: { type: Number, min: 0, max: 1 },
        communication: { type: Number, min: 0, max: 1 },
        application: { type: Number, min: 0, max: 1 }
    }
}, { _id: false });

const SkillTreeNodeSchema = new mongoose.Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    module: { type: String },
    topic: { type: String },
    difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' },
    prerequisites: [{ type: String }],
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    tier: { type: Number, default: 0 },
    // Rich node content
    learningObjective: { type: String },
    estimatedTime: { type: Number, default: 30 },
    outcomes: [{ type: String }],
    successCriteria: [{ type: String }],
    aiTutorPrompt: AiTutorPromptSchema,
    miniAssessment: MiniAssessmentSchema,
    relatedResources: [ResourceSchema],
    relatedNodes: [{ type: String }],

    // Mastery system
    masteryThreshold: { type: Number, default: 70 },
    masteryScore: { type: Number, default: 0 },
    masteryStatus: {
        type: String,
        enum: ['locked', 'available', 'started', 'practicing', 'mastered', 'expert'],
        default: 'locked'
    },
    unlocked: { type: Boolean, default: false },
    mastered: { type: Boolean, default: false },
    stars: { type: Number, default: 0, min: 0, max: 3 },
    xpAwarded: { type: Number, default: 0 },
    completedAt: { type: Date },

    // Assessment tracking
    quizScore: { type: Number },
    bestQuizScore: { type: Number },
    lastQuizScore: { type: Number },
    quizAttempts: { type: Number, default: 0 },
    reflection: { type: String },
    agentFeedback: { type: String },
    agentEvaluations: [{
        correctness: { type: Number },
        reasoning: { type: Number },
        confidence: { type: Number },
        depth: { type: Number },
        misconceptions: [{ type: String }],
        communication: { type: Number },
        application: { type: Number },
        feedback: { type: String },
        timestamp: { type: Date, default: Date.now }
    }],
    attempts: { type: Number, default: 0 },
    attemptHistory: [NodeAttemptSchema],

    // Time tracking
    timeInvested: { type: Number, default: 0 },

    // Knowledge gaps detected in this node
    detectedGaps: [KnowledgeGapSchema]
}, { _id: false });

const AssessmentResultSchema = new mongoose.Schema({
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' },
    weightedScore: { type: Number, default: 0 },
    rawScore: { type: Number, default: 0 },
    mcqScore: { type: Number, default: 0 },
    scenarioScore: { type: Number, default: 0 },
    reasoningScore: { type: Number, default: 0 },
    reflectionScore: { type: Number, default: 0 },
    conceptUnderstanding: { type: Number },
    confidence: { type: Number },
    misconceptions: [{ type: String }],
    strengths: [{ type: String }],
    improvements: [{ type: String }],
    recommendations: [{ type: String }],
    knowledgeGaps: [{ type: String }],
    summary: { type: String },
    evaluatedBy: { type: String, default: 'ai' },
    answers: { type: mongoose.Schema.Types.Mixed },
    completedAt: { type: Date },
    // Per-question breakdown
    questionResults: [{
        questionId: { type: String },
        questionType: { type: String },
        correct: { type: Boolean },
        score: { type: Number },
        bloomsLevel: { type: String },
        difficulty: { type: String },
        feedback: { type: String }
    }]
}, { _id: false });

const KnowledgeGapReportSchema = new mongoose.Schema({
    analysisVersion: { type: Number, default: 1 },
    analyzedAt: { type: Date, default: Date.now },
    overallAssessment: { type: String },
    strongAreas: [{
        nodeId: { type: String },
        nodeName: { type: String },
        masteryScore: { type: Number },
        strengths: [{ type: String }]
    }],
    weakAreas: [{
        nodeId: { type: String },
        nodeName: { type: String },
        masteryScore: { type: Number },
        gaps: [{ type: String }],
        severity: { type: Number, min: 0, max: 1 },
        suggestedReviewOrder: { type: Number }
    }],
    commonMisconceptions: [{ type: String }],
    recommendations: [{
        action: { type: String },
        priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
        details: { type: String },
        relatedNodes: [{ type: String }]
    }],
    suggestedReviewOrder: [{ type: String }],
    suggestedVideos: [{ type: String }],
    suggestedReading: [{ type: String }],
    suggestedPractice: [{ type: String }]
}, { _id: false });

const SkillTreeAnalyticsSchema = new mongoose.Schema({
    overallProgress: { type: Number, default: 0 },
    completionPercentage: { type: Number, default: 0 },
    masteryPercentage: { type: Number, default: 0 },
    weakAreas: [{ type: String }],
    strongAreas: [{ type: String }],
    timeInvested: { type: Number, default: 0 },
    averageQuizScore: { type: Number },
    averageAgentScore: { type: Number },
    learningVelocity: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    projectedCompletion: { type: Date },
    lastActivityDate: { type: Date },
    lastGapReport: KnowledgeGapReportSchema
}, { _id: false });

const UserSkillTreeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    curriculumId: { type: mongoose.Schema.Types.ObjectId, ref: 'UploadedCurriculum', default: null },
    courseName: { type: String },
    title: { type: String, required: true },
    source: { type: String, enum: ['course', 'csv'], required: true },
    version: { type: Number, default: 1 },
    graphJson: { type: mongoose.Schema.Types.Mixed },
    nodes: [SkillTreeNodeSchema],
    generatedBy: { type: String, default: 'deterministic' },
    nodeCount: { type: Number, default: 0 },
    dependencyCount: { type: Number, default: 0 },
    generationTimeMs: { type: Number },
    status: {
        type: String,
        enum: ['generating', 'ready', 'failed', 'assessing', 'active', 'completed'],
        default: 'generating'
    },
    generationLog: [{ type: String }],
    assessmentResult: AssessmentResultSchema,
    knowledgeGapReport: KnowledgeGapReportSchema,
    analytics: SkillTreeAnalyticsSchema,
    totalXpEarned: { type: Number, default: 0 },
    totalStarsEarned: { type: Number, default: 0 },
    nodesUnlocked: { type: Number, default: 0 },
    nodesMastered: { type: Number, default: 0 },
    lastOpenedNode: { type: String },
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'SkillTreeGame', default: null },
    providerUsed: { type: String },
    generationProviderLog: { type: String },
    // Scoring weights configurable per course
    scoringWeights: {
        mcq: { type: Number, default: 0.3 },
        scenario: { type: Number, default: 0.2 },
        reasoning: { type: Number, default: 0.3 },
        reflection: { type: Number, default: 0.2 },
        application: { type: Number, default: 0.15 },
        confidence: { type: Number, default: 0.05 }
    },
    resumeState: {
        lastNodeId: { type: String },
        lastAssessmentId: { type: String },
        lastConversationId: { type: String },
        mapPosition: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
            zoom: { type: Number, default: 1 }
        },
        activeNodeId: { type: String },
        activeTutorSession: { type: Boolean, default: false },
        updatedAt: { type: Date }
    }
}, { timestamps: true });

UserSkillTreeSchema.index({ userId: 1, courseName: 1, version: 1 }, { sparse: true });
UserSkillTreeSchema.index({ userId: 1, curriculumId: 1, version: 1 }, { sparse: true });
UserSkillTreeSchema.index({ userId: 1, status: 1 });

UserSkillTreeSchema.methods.calculateMasteryScore = function (node) {
    if (!node) return 0;
    const hasQuiz = node.bestQuizScore != null;
    const hasReflection = node.reflection && node.reflection.length > 10;
    const hasFeedback = node.agentFeedback && node.agentFeedback.length > 10;
    const attemptsScore = Math.min(node.attempts / 3, 1) * 0.1;

    let quizComponent = 0;
    if (hasQuiz) quizComponent = (node.bestQuizScore / 100) * 0.5;

    let reflectionComponent = 0;
    if (hasReflection) reflectionComponent = 0.15;

    let feedbackComponent = 0;
    if (hasFeedback) feedbackComponent = 0.25;

    const total = quizComponent + reflectionComponent + feedbackComponent + attemptsScore;
    return Math.min(Math.round(total * 100), 100);
};

UserSkillTreeSchema.methods.determineMasteryStatus = function (masteryScore, threshold) {
    if (masteryScore >= 95) return 'expert';
    if (masteryScore >= threshold) return 'mastered';
    if (masteryScore >= threshold * 0.6) return 'practicing';
    if (masteryScore >= threshold * 0.3) return 'started';
    return 'available';
};

module.exports = mongoose.model('UserSkillTree', UserSkillTreeSchema);
