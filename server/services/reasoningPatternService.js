const ReasoningLog = require('../models/ReasoningLog');

function round(num, p = 2) {
    const n = Number(num) || 0;
    const m = Math.pow(10, p);
    return Math.round(n * m) / m;
}

async function getReasoningMetrics(userId) {
    const match = userId ? { userId } : {};

    const [
        logs,
        contradictionSteps,
        lowConfidenceThemes,
        correctionStats,
        branchDepthStats
    ] = await Promise.all([
        ReasoningLog.find(match).select('steps confidenceScore correctionsTriggered telemetry').lean(),
        ReasoningLog.aggregate([
            { $match: match },
            { $unwind: '$steps' },
            {
                $match: {
                    $or: [
                        { 'steps.uncertaintyFactors': 'possible-contradiction' },
                        { 'steps.content': { $regex: 'contradict|inconsistent|conflict', $options: 'i' } }
                    ]
                }
            },
            { $group: { _id: '$steps.stepId', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),
        ReasoningLog.aggregate([
            { $match: match },
            { $unwind: '$steps' },
            { $match: { 'steps.stepConfidence': { $ne: null, $lt: 45 } } },
            { $group: { _id: '$steps.stepId', count: { $sum: 1 }, avgConf: { $avg: '$steps.stepConfidence' } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),
        ReasoningLog.aggregate([
            { $match: match },
            { $group: { _id: null, avgCorrections: { $avg: '$correctionsTriggered' }, totalCorrections: { $sum: '$correctionsTriggered' } } }
        ]),
        ReasoningLog.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    avgBranchDepth: { $avg: '$telemetry.dynamicBranchCount' },
                    avgBranchesPruned: { $avg: '$telemetry.branchesPruned' }
                }
            }
        ])
    ]);

    const totalQueries = logs.length;
    const totalSteps = logs.reduce((sum, l) => sum + (Array.isArray(l.steps) ? l.steps.length : 0), 0);
    const averageStepsPerQuery = totalQueries > 0 ? round(totalSteps / totalQueries) : 0;

    const strengths = [];
    const weak = [];

    logs.forEach(log => {
        (log.steps || []).forEach(step => {
            const sc = Number(step.stepConfidence);
            if (Number.isFinite(sc)) {
                if (sc >= 75) strengths.push(step.stepId || 'unknown');
                if (sc < 45) weak.push(step.stepId || 'unknown');
            }
        });
    });

    const top = (arr, n = 10) => {
        const map = new Map();
        arr.forEach(v => map.set(v, (map.get(v) || 0) + 1));
        return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ key: k, count: c }));
    };

    return {
        totalQueries,
        averageStepsPerQuery,
        averageFinalConfidence: totalQueries > 0
            ? round(logs.reduce((sum, l) => sum + (Number(l.confidenceScore) || 0), 0) / totalQueries)
            : 0,
        frequentReasoningStrengths: top(strengths),
        frequentLowConfidenceThemes: lowConfidenceThemes.map(i => ({ theme: i._id, count: i.count, avgConfidence: round(i.avgConf) })),
        commonContradictionTriggers: contradictionSteps.map(i => ({ trigger: i._id, count: i.count })),
        correctionLoopStats: correctionStats[0] || { avgCorrections: 0, totalCorrections: 0 },
        branchDepthStats: branchDepthStats[0] || { avgBranchDepth: 0, avgBranchesPruned: 0 }
    };
}

async function getSystemReasoningMetrics() {
    return getReasoningMetrics(null);
}

module.exports = {
    getReasoningMetrics,
    getSystemReasoningMetrics
};
