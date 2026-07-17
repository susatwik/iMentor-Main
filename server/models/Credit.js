const mongoose = require('mongoose');

const CreditSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    source: { type: String, default: 'learning_credit' },
    reason: { type: String, default: 'learning progress' },
    topic: { type: String, default: 'general' },
    sessionId: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Credit', CreditSchema);
const mongoose = require('mongoose');

const CreditSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    source: { type: String, default: 'learning_credit' },
    reason: { type: String, default: 'learning progress' },
    topic: { type: String, default: 'general' },
    sessionId: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Credit', CreditSchema);
