const log = require('../utils/logger');
// server/routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/authMiddleware');
require('dotenv').config();
const otpGenerator = require('otp-generator');
const { sendOtpEmail, sendPasswordResetEmail, isEmailServiceConfigured } = require('../services/emailService');
const bcrypt = require('bcryptjs');
const { redisClient } = require('../config/redisClient');

// Development mode flag: skip email verification requirement
const EMAIL_VERIFICATION_REQUIRED = process.env.EMAIL_VERIFICATION_REQUIRED !== 'false';

const router = express.Router();
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '7d';
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_SECONDS = 900; // 15 minutes

/**
 * Check and increment brute-force counter for OTP verification.
 * Returns { allowed: boolean, remaining: number }
 */
async function checkOtpBruteForce(email) {
    const key = `otp_attempts:${email}`;
    if (!redisClient || !redisClient.isOpen) {
        return { allowed: true, remaining: OTP_MAX_ATTEMPTS }; // fallback: no Redis = no counter
    }
    try {
        const attempts = parseInt(await redisClient.get(key) || '0', 10);
        if (attempts >= OTP_MAX_ATTEMPTS) {
            return { allowed: false, remaining: 0 };
        }
        await redisClient.multi()
            .incr(key)
            .expire(key, OTP_LOCKOUT_SECONDS)
            .exec();
        return { allowed: true, remaining: OTP_MAX_ATTEMPTS - attempts - 1 };
    } catch (err) {
        log.warn('AUTH', `Redis brute-force check failed: ${err.message}`);
        return { allowed: true, remaining: OTP_MAX_ATTEMPTS };
    }
}

async function clearOtpBruteForce(email) {
    if (redisClient && redisClient.isOpen) {
        try { await redisClient.del(`otp_attempts:${email}`); } catch (_) {}
    }
}

router.post('/signup', async (req, res) => {
    const {
        email, otp,
        name, college, universityNumber, degreeType, branch, year,
        learningStyle, currentGoals,
        apiKey, ollamaUrl, preferredLlmProvider, requestAdminKey
    } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required to complete signup.' });
    }
    if (!name || !college || !universityNumber || !degreeType || !branch || !year || !learningStyle) {
        const missing = [!name && 'name', !college && 'college', !universityNumber && 'universityNumber', !degreeType && 'degreeType', !branch && 'branch', !year && 'year', !learningStyle && 'learningStyle'].filter(Boolean);
        log.warn('AUTH', `SIGNUP_MISSING_FIELDS for ${email}: ${missing.join(', ')}`);
        return res.status(400).json({ message: `Missing profile fields: ${missing.join(', ')}` });
    }

    try {
        // Look up the pending registration (not the User table — no ghost user exists)
        const PendingRegistration = require('../models/PendingRegistration');
        const pending = await PendingRegistration.findOne({ email });
        if (!pending) {
            return res.status(404).json({ message: 'Signup process not started for this email. Please try again.' });
        }

        // Brute-force protection: limit OTP verification attempts
        const bruteForceCheck = await checkOtpBruteForce(email);
        if (!bruteForceCheck.allowed) {
            log.warn('AUTH', `OTP brute-force lockout for ${email}`);
            return res.status(429).json({ message: 'Too many OTP attempts. Please wait 15 minutes and request a new code.' });
        }

        const isOtpValid = pending.hashedOtp ? await bcrypt.compare(otp, pending.hashedOtp) : false;
        if (!isOtpValid || pending.otpExpires < new Date()) {
            log.info('AUTH', `USER_SIGNUP_FAILURE: ${email}, reason: Invalid or expired OTP (${bruteForceCheck.remaining} attempts remaining)`);
            return res.status(400).json({ message: 'Invalid or expired OTP.' });
        }
        await clearOtpBruteForce(email); // Reset counter on success

        // Create the real User only now (no ghost user existed before)
        const user = new User({
            email,
            password: pending.hashedPassword,
            username: email.split('@')[0] + require('uuid').v4().substring(0, 4),
            hasCompletedOnboarding: false
        });

        // CRITICAL: Mark password as NOT modified so pre-save hook doesn't double-hash
        user.markModified('password');
        user.$__setValue('password', pending.hashedPassword);
        user.unmarkModified('password');

        user.profile = { name, college, universityNumber, degreeType, branch, year, learningStyle, currentGoals: currentGoals || '' };
        // LLM provider is required — no silent default
        if (!preferredLlmProvider) {
            return res.status(400).json({ message: 'Please select your LLM provider to continue.' });
        }
        user.preferredLlmProvider = preferredLlmProvider;
        user.apiKeyRequestStatus = requestAdminKey ? 'pending' : 'none';
        // local_llm uses vLLM/Ollama on the server — no API key needed
        if (preferredLlmProvider === 'local_llm' || preferredLlmProvider === 'ollama') {
            user.ollamaUrl = (ollamaUrl || '').trim() || process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434';
            user.encryptedApiKey = null;
        } else if (preferredLlmProvider === 'gemini') {
            user.encryptedApiKey = requestAdminKey ? null : (apiKey || null);
            user.ollamaUrl = '';
        } else {
            // groq or other cloud providers
            user.encryptedApiKey = requestAdminKey ? null : (apiKey || null);
            user.ollamaUrl = '';
        }

        // Mark email as verified
        user.emailVerified = true;

        await user.save();

        // Clean up the pending registration
        await PendingRegistration.deleteOne({ email });

        log.info('AUTH', `USER_SIGNUP_SUCCESS: ${user.email}, userId: ${user._id.toString()}`);

        const payload = { userId: user._id, email: user.email, username: user.username };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRATION });

        res.status(201).json({
            token,
            _id: user._id,
            email: user.email,
            username: user.username,
            hasCompletedOnboarding: user.hasCompletedOnboarding,
            message: "User registered successfully",
        });

    } catch (error) {
        log.error('AUTH', `Signup finalization error: ${error.message}`);
        res.status(500).json({ message: 'Server error during signup finalization.' });
    }
});

router.post('/send-otp', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(email) || !password || password.length < 6) {
        return res.status(400).json({ message: 'A valid email and a password of at least 6 characters are required.' });
    }

    try {        // Development mode: skip email verification
        if (!EMAIL_VERIFICATION_REQUIRED) {
            log.info('AUTH', `DEV_MODE: Skipping OTP for ${email}`);
            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return res.status(409).json({ message: 'An account with this email already exists.' });
            }

            // In dev mode, generate a dummy OTP (or could return it for testing)
            const devOtp = '123456';
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            const hashedOtp = await bcrypt.hash(devOtp, 10);

            const PendingRegistration = require('../models/PendingRegistration');
            await PendingRegistration.findOneAndUpdate(
                { email },
                {
                    email,
                    hashedPassword,
                    hashedOtp,
                    otpExpires: new Date(Date.now() + 10 * 60 * 1000),
                    attempts: 0
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            log.info('AUTH', `USER_SIGNUP_INITIATED_DEV: ${email} (dev mode - email verification skipped)`);
            return res.status(200).json({ 
                message: 'Development mode: Email verification skipped. Use OTP "123456" to complete signup.',
                devMode: true,
                devOtp: devOtp
            });
        }
        const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && isEmailServiceConfigured());
        if (!emailConfigured) {
            log.error('AUTH', 'OTP send blocked: email verification service not configured');
            return res.status(503).json({
                success: false,
                message: 'Email verification service not configured'
            });
        }

        // <<< THIS IS THE FIX >>>
        // Perform a single, definitive check for an existing user at the very beginning.
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }
        // <<< END OF FIX >>>

        log.info('AUTH', `Sending OTP to ${email}`);
        const otp = otpGenerator.generate(6, { upperCaseAlphabets: false, specialChars: false, lowerCaseAlphabets: false });
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const hashedOtp = await bcrypt.hash(otp, 10); // Hash OTP before storing

        // Store in PendingRegistration (TTL-indexed, auto-cleaned) instead of ghost User
        const PendingRegistration = require('../models/PendingRegistration');
        await PendingRegistration.findOneAndUpdate(
            { email },
            {
                email,
                hashedPassword,
                hashedOtp,
                otpExpires,
                attempts: 0
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await sendOtpEmail(email, otp); // Send plaintext OTP to user's email
        log.info('AUTH', `USER_OTP_SENT: ${email}`);
        res.status(200).json({ message: 'Verification OTP sent to your email.' });
    } catch (error) {
        log.error('AUTH', `Initial signup error: ${error.message}`);
        res.status(500).json({ message: error.message || 'Server error during the initial signup step.' });
    }
});

router.post('/signin', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Please provide email and password.' });
    }

    try {
        const user = await User.findOne({ email }).select('+password');
        if (!user) {
            log.info('AUTH', `LOGIN_FAILURE: ${email}, reason: User not found`);
            return res.status(401).json({ message: 'Invalid email address or password.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            log.info('AUTH', `LOGIN_FAILURE: ${email}, reason: Invalid password`);
            return res.status(401).json({ message: 'Invalid email address or password.' });
        }

        if (user.isAdmin) {
            log.info('AUTH', `ADMIN_LOGIN_SUCCESS: ${user.email}`);
            const payload = { userId: user._id, email: user.email, isAdmin: true };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRATION });
            return res.status(200).json({ isAdminLogin: true, token: token, message: 'Admin login successful' });
        }

        log.info('AUTH', `USER_LOGIN_SUCCESS: ${user.email}`);
        const payload = { userId: user._id, email: user.email, isAdmin: false };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRATION });

        res.status(200).json({
            token,
            _id: user._id,
            email: user.email,
            username: user.username,
            isAdmin: !!user.isAdmin,
            hasCompletedOnboarding: user.hasCompletedOnboarding,
            message: "Login successful",
        });
    } catch (error) {
        log.error('AUTH', `Signin error: ${error.message}`);
        res.status(500).json({ message: 'Server error during signin.' });
    }
});

// --- Password Reset Flow ---
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email || !/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    try {
        const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && isEmailServiceConfigured());
        if (!emailConfigured) {
            log.error('AUTH', 'Password reset blocked: email service not configured');
            return res.status(503).json({ message: 'Email service not configured. Please contact the administrator.' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            // Return success even if user not found to prevent email enumeration
            log.info('AUTH', `PASSWORD_RESET_REQUEST: ${email}, reason: User not found (silent)`);
            return res.status(200).json({ message: 'If an account with this email exists, a reset code has been sent.' });
        }

        const otp = otpGenerator.generate(6, { upperCaseAlphabets: false, specialChars: false, lowerCaseAlphabets: false });
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        const hashedOtp = await bcrypt.hash(otp, 10); // Hash OTP before storing

        await User.updateOne({ _id: user._id }, { $set: { otp: hashedOtp, otpExpires } });

        await sendPasswordResetEmail(email, otp); // Send plaintext OTP to user's email
        log.info('AUTH', `PASSWORD_RESET_OTP_SENT: ${email}`);
        res.status(200).json({ message: 'If an account with this email exists, a reset code has been sent.' });
    } catch (error) {
        log.error('AUTH', `Forgot password error: ${error.message}`);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
});

router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
        return res.status(400).json({ message: 'Email, OTP, and new password are required.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters long.' });
    }

    try {
        const user = await User.findOne({ email }).select('+otp +otpExpires');
        if (!user) {
            return res.status(400).json({ message: 'Invalid request. Please try again.' });
        }

        // Brute-force protection
        const bruteForceCheck = await checkOtpBruteForce(email);
        if (!bruteForceCheck.allowed) {
            log.warn('AUTH', `OTP brute-force lockout for ${email}`);
            return res.status(429).json({ message: 'Too many attempts. Please wait 15 minutes and request a new code.' });
        }

        const isOtpValid = user.otp ? await bcrypt.compare(otp, user.otp) : false;
        if (!user.otp || !isOtpValid || user.otpExpires < new Date()) {
            log.info('AUTH', `PASSWORD_RESET_FAILURE: ${email}, reason: Invalid or expired OTP`);
            return res.status(400).json({ message: 'Invalid or expired reset code.' });
        }
        await clearOtpBruteForce(email);

        // Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password and clear OTP fields
        await User.updateOne(
            { _id: user._id },
            { $set: { password: hashedPassword }, $unset: { otp: 1, otpExpires: 1 } }
        );

        log.info('AUTH', `PASSWORD_RESET_SUCCESS: ${email}`);
        res.status(200).json({ message: 'Password has been reset successfully. You can now login with your new password.' });
    } catch (error) {
        log.error('AUTH', `Reset password error: ${error.message}`);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
});

/**
 * POST /api/auth/verify-otp
 * Validates the signup OTP before the user fills in their profile.
 * This prevents users from advancing to step 2 with a wrong code.
 */
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required.' });
    }
    try {
        const PendingRegistration = require('../models/PendingRegistration');
        const pending = await PendingRegistration.findOne({ email });
        if (!pending) {
            return res.status(404).json({ message: 'No pending signup found for this email. Please request a new code.' });
        }
        // Brute-force protection
        const bruteForceCheck = await checkOtpBruteForce(email);
        if (!bruteForceCheck.allowed) {
            return res.status(429).json({ message: 'Too many OTP attempts. Please wait 15 minutes and request a new code.' });
        }
        const isOtpValid = pending.hashedOtp ? await bcrypt.compare(String(otp), pending.hashedOtp) : false;
        if (!isOtpValid) {
            log.warn('AUTH', `OTP verify failed for ${email}`);
            return res.status(400).json({ valid: false, message: 'Incorrect verification code. Please try again.' });
        }
        await clearOtpBruteForce(email);
        log.info('AUTH', `OTP pre-verified for ${email}`);
        return res.status(200).json({ valid: true, message: 'OTP verified successfully.' });
    } catch (err) {
        log.error('AUTH', `verify-otp error: ${err.message}`);
        return res.status(500).json({ message: 'Server error. Please try again.' });
    }
});

/**
 * POST /api/auth/verify-forgot-otp
 * Validates the forgot-password OTP before showing the new-password form.
 */
router.post('/verify-forgot-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required.' });
    }
    try {
        const user = await User.findOne({ email }).select('+otp +otpExpires');
        if (!user) {
            return res.status(404).json({ message: 'No account found with that email.' });
        }
        log.info('AUTH', `verify-forgot-otp DEBUG: email=${email}, hasOtp=${!!user.otp}, otpExpires=${user.otpExpires}, isExpired=${user.otpExpires < new Date()}`);
        const bruteForceCheck = await checkOtpBruteForce(`forgot:${email}`);
        if (!bruteForceCheck.allowed) {
            return res.status(429).json({ message: 'Too many attempts. Please wait 15 minutes.' });
        }
        const isOtpValid = user.otp ? await bcrypt.compare(String(otp), user.otp) : false;
        log.info('AUTH', `verify-forgot-otp DEBUG: providedOtp=${otp}, isOtpValid=${isOtpValid}`);
        if (!isOtpValid || user.otpExpires < new Date()) {
            return res.status(400).json({ valid: false, message: 'Invalid or expired reset code.' });
        }
        await clearOtpBruteForce(`forgot:${email}`);
        return res.status(200).json({ valid: true, message: 'Code verified.' });
    } catch (err) {
        log.error('AUTH', `verify-forgot-otp error: ${err.message}`);
        return res.status(500).json({ message: 'Server error. Please try again.' });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Not authorized.' });
    }
    res.status(200).json({
        _id: req.user._id,
        email: req.user.email,
        username: req.user.username,
        isAdmin: !!req.user.isAdmin,
        hasCompletedOnboarding: req.user.hasCompletedOnboarding
    });
});

router.post('/complete-onboarding', authMiddleware, async (req, res) => {
    try {
        // Use $set to avoid triggering full-document validation on fields not in scope
        const result = await User.findByIdAndUpdate(
            req.user._id,
            { $set: { hasCompletedOnboarding: true } },
            { new: true, runValidators: false }
        );
        if (!result) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({ message: 'Onboarding marked as complete.' });
    } catch (error) {
        log.error('AUTH', `Onboarding error: ${error.message}`);
        res.status(500).json({ message: 'Server error.' });
    }
});

// @route   POST /api/auth/validate-llm-key
// @desc    Public endpoint — validate a Gemini or Groq API key before signup (no auth required)
// @access  Public
router.post('/validate-llm-key', async (req, res) => {
    const { provider, apiKey } = req.body || {};
    if (!provider || !apiKey) {
        return res.status(400).json({ ok: false, message: 'provider and apiKey are required.' });
    }
    if (!['gemini', 'groq'].includes(provider)) {
        return res.status(400).json({ ok: false, message: 'Only gemini or groq can be validated here.' });
    }
    try {
        const { validateProviderConnection } = require('../services/providerValidationService');
        const result = await validateProviderConnection({ provider, apiKey });
        return res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
        log.warn('AUTH', `Public LLM key validation error: ${err.message}`);
        return res.status(500).json({ ok: false, message: err.message });
    }
});

module.exports = router;