// server/routes/user.js
const express = require('express');
const router = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const User = require('../models/User');
const UserFeedback = require('../models/UserFeedback');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');
const { auditLog } = require('../utils/logger');

// ─── Feedback attachment upload config ───────────────────────────────────────
const FEEDBACK_DIR = path.join(__dirname, '../uploads/feedback');
if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

const feedbackStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FEEDBACK_DIR),
    filename:    (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
});

const ALLOWED_MIME = ['image/jpeg','image/png','image/gif','image/webp','image/bmp','application/pdf'];

const feedbackUpload = multer({
    storage: feedbackStorage,
    limits:  { fileSize: 5 * 1024 * 1024, files: 3 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Only images (jpg, png, gif, webp) and PDF files are allowed.'));
    },
});

router.get('/profile', async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('profile hasCompletedOnboarding');
        if (!user) {
            return res.status(404).json({message: 'User not found.' });
        }

        const profileData = user.profile ? user.profile.toObject() : { };
        profileData.hasCompletedOnboarding = user.hasCompletedOnboarding;

        res.json(profileData);
    } catch (error) {
            log.error('AUTH', `Profile fetch error: ${error.message}`);
        res.status(500).json({message: 'Server error while fetching profile.' });
    }
});

router.put('/profile', async (req, res) => {
    const {name, college, universityNumber, degreeType, branch, year, learningStyle, currentGoals} = req.body;

        if (!name || !college || !universityNumber || !degreeType || !branch || !year || !learningStyle) {
        return res.status(400).json({message: 'All profile fields except goals are required.' });
    }

        try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({message: 'User not found.' });
        }

        user.profile = {
            name,
            college,
            universityNumber,
            degreeType,
            branch,
            year,
            learningStyle,
            currentGoals: currentGoals || ''
        };

        await user.save();

        auditLog(req, 'USER_PROFILE_UPDATE_SUCCESS', {
            updatedFields: Object.keys(req.body) // Log which fields were included in the update
        });

        if (redisClient && redisClient.isOpen) {
            const cacheKey = `user:${req.user._id}`;
        await redisClient.del(cacheKey);
        log.info('AUTH', `Invalidated cache for user ${req.user._id}`);
        }
        res.json({
            message: 'Profile updated successfully!',
        profile: user.profile
        });

    } catch (error) {
            log.error('AUTH', `Profile update error: ${error.message}`);
        res.status(500).json({message: 'Server error while updating profile.' });
    }
});

// ─── User Product Feedback ─────────────────────────────────────────────────────

/**
 * GET /api/user/feedback/attachment/:filename
 * Serve a previously uploaded feedback attachment (auth-gated).
 */
router.get('/feedback/attachment/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^[\w.-]+$/.test(filename)) return res.status(400).json({ message: 'Invalid filename.' });
    const filePath = path.join(FEEDBACK_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Attachment not found.' });
    res.sendFile(filePath);
});

/**
 * POST /api/user/feedback
 * Submit product feedback (bugs, feature requests, general comments).
 * Accepts multipart/form-data with optional 'attachments' files (up to 3).
 */
router.post('/feedback', feedbackUpload.array('attachments', 3), async (req, res) => {
    const { type, category, message } = req.body;

    if (!message || message.trim().length < 10) {
        return res.status(400).json({ message: 'Feedback message must be at least 10 characters.' });
    }
    if (message.trim().length > 1000) {
        return res.status(400).json({ message: 'Feedback message must be 1000 characters or fewer.' });
    }
    const validTypes      = ['bug', 'feature', 'general'];
    const validCategories = ['UI', 'Performance', 'Content', 'AI Quality', 'Other'];

    const attachments = (req.files || []).map(f => ({
        filename:     f.filename,
        originalName: f.originalname,
        mimetype:     f.mimetype,
        size:         f.size,
    }));

    try {
        const feedback = await UserFeedback.create({
            userId:      req.user._id,
            type:        validTypes.includes(type) ? type : 'general',
            category:    validCategories.includes(category) ? category : 'Other',
            message:     message.trim(),
            attachments,
        });
        log.info('USER', `Feedback submitted by ${req.user._id}: [${feedback.type}/${feedback.category}] attachments=${attachments.length}`);
        return res.status(201).json({ message: 'Thank you for your feedback!', id: feedback._id });
    } catch (err) {
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: Object.values(err.errors).map(e => e.message).join('. ') });
        }
        log.error('USER', `Feedback save error: ${err.message}`);
        return res.status(500).json({ message: 'Server error. Please try again.' });
    }
});

/**
 * GET /api/user/feedback
 * Returns the current user's submitted feedback entries.
 */
router.get('/feedback', async (req, res) => {
    try {
        const items = await UserFeedback.find({userId: req.user._id })
        .sort({createdAt: -1 })
        .limit(50)
        .select('-adminNote -__v')
        .lean();
        return res.json({feedback: items });
    } catch (err) {
            log.error('USER', `Feedback fetch error: ${err.message}`);
        return res.status(500).json({message: 'Server error.' });
    }
});

        module.exports = router;