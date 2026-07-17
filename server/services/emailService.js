const log = require('../utils/logger');
// server/services/emailService.js
const nodemailer = require('nodemailer');
require('dotenv').config();

let isEmailServiceReady = false;

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: parseInt(process.env.EMAIL_PORT, 10) === 465, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

/**
 * Verifies the email transporter credentials on application startup.
 * Sets a global flag indicating if the email service is operational.
 */
const checkEmailCredentials = async () => {
    // Check if essential .env variables are missing or are still placeholders
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || process.env.EMAIL_USER === 'your-email@gmail.com' || process.env.EMAIL_PASS === 'your-app-password') {
        log.warn('AUTH', "Email credentials not configured. OTP disabled.");
        isEmailServiceReady = false;
        return;
    }
    try {
        await transporter.verify();
        log.info('AUTH', "Email service ready");
        isEmailServiceReady = true;
    } catch (error) {
        log.error('AUTH', `Email verification failed: ${error.message}`);
        isEmailServiceReady = false;
    }
};

const sendOtpEmail = async (to, otp) => {
    if (!isEmailServiceReady) {
        // This check prevents attempts to send mail if the service is known to be down.
        throw new Error("Email service is not configured correctly on the server.");
    }

    const mailOptions = {
        from: `"iMentor AI" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: 'Your iMentor Verification Code',
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                <h2 style="color: #3b82f6;">Welcome to iMentor!</h2>
                <p>Thank you for signing up. Please use the following One-Time Password (OTP) to complete your registration:</p>
                <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1e293b; background-color: #f1f5f9; padding: 10px 20px; border-radius: 8px; display: inline-block;">
                    ${otp}
                </p>
                <p>This code will expire in 10 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>
                <br>
                <p>Best regards,</p>
                <p>The iMentor Team</p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        log.success('AUTH', `OTP sent to ${to}`);
    } catch (error) {
        log.error('AUTH', `Failed to send OTP to ${to}: ${error.message}`);
        throw new Error('Failed to send verification email.');
    }
};

const sendPasswordResetEmail = async (to, otp) => {
    if (!isEmailServiceReady) {
        throw new Error("Email service is not configured correctly on the server.");
    }

    const mailOptions = {
        from: `"iMentor AI" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: 'iMentor Password Reset Code',
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                <h2 style="color: #ef4444;">Password Reset Request</h2>
                <p>We received a request to reset the password for your iMentor account. Use the following code to reset your password:</p>
                <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1e293b; background-color: #fef2f2; padding: 10px 20px; border-radius: 8px; display: inline-block;">
                    ${otp}
                </p>
                <p>This code will expire in 10 minutes.</p>
                <p>If you did not request a password reset, please ignore this email. Your password will remain unchanged.</p>
                <br>
                <p>Best regards,</p>
                <p>The iMentor Team</p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        log.success('AUTH', `Password reset OTP sent to ${to}`);
    } catch (error) {
        log.error('AUTH', `Failed to send password reset OTP to ${to}: ${error.message}`);
        throw new Error('Failed to send password reset email.');
    }
};

module.exports = {
    sendOtpEmail,
    sendPasswordResetEmail,
    checkEmailCredentials,
    isEmailServiceConfigured: () => isEmailServiceReady
};