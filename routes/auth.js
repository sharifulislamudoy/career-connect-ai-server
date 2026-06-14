// backend/routes/auth.js
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const router = express.Router();

// MongoDB collection for temporary verification codes
let verificationCodesCollection;

module.exports = (db) => {
    verificationCodesCollection = db.collection('verification_codes');

    // Configure email transporter
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    // Generate 6-digit code
    const generateCode = () => {
        return Math.floor(100000 + Math.random() * 900000).toString();
    };

    // Send verification code (for login or signup)
    router.post('/send-code', async (req, res) => {
        try {
            const { email, type, userData } = req.body; // type: 'login' or 'signup'
            if (!email || !type) {
                return res.status(400).json({ success: false, message: 'Email and type are required' });
            }

            const code = generateCode();
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

            // Store verification request in DB
            const verificationData = {
                email,
                code,
                type,
                userData: userData || null,
                createdAt: new Date(),
                expiresAt,
                verified: false,
            };
            await verificationCodesCollection.insertOne(verificationData);

            // Send email
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: email,
                subject: 'Your Verification Code - Creative Career AI',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #2563eb;">Creative Career AI</h2>
                        <p>Hello,</p>
                        <p>Your verification code is:</p>
                        <div style="background: #f3f4f6; padding: 15px; font-size: 32px; font-weight: bold; text-align: center; letter-spacing: 5px; border-radius: 12px;">
                            ${code}
                        </div>
                        <p>This code will expire in 10 minutes.</p>
                        <p>If you didn't request this, please ignore this email.</p>
                        <hr style="margin: 20px 0;" />
                        <p style="color: #6b7280; font-size: 12px;">Creative Career AI - Your gateway to career success</p>
                    </div>
                `,
            };

            await transporter.sendMail(mailOptions);

            res.json({ success: true, message: 'Verification code sent to your email' });
        } catch (error) {
            console.error('Error sending code:', error);
            res.status(500).json({ success: false, message: 'Failed to send verification code' });
        }
    });

    // Verify code and return pending data
    router.post('/verify-code', async (req, res) => {
        try {
            const { email, code, type } = req.body;
            if (!email || !code || !type) {
                return res.status(400).json({ success: false, message: 'Email, code and type are required' });
            }

            const verification = await verificationCodesCollection.findOne({
                email,
                code,
                type,
                verified: false,
                expiresAt: { $gt: new Date() },
            });

            if (!verification) {
                return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
            }

            // Mark as verified
            await verificationCodesCollection.updateOne(
                { _id: verification._id },
                { $set: { verified: true } }
            );

            // Return the stored userData (for signup) or just success for login
            res.json({
                success: true,
                message: 'Code verified successfully',
                userData: verification.userData || null,
            });
        } catch (error) {
            console.error('Error verifying code:', error);
            res.status(500).json({ success: false, message: 'Verification failed' });
        }
    });

    return router;
};