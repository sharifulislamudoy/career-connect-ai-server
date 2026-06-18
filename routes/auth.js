const express = require("express");
const nodemailer = require("nodemailer");

module.exports = (db) => {
  const router = express.Router();

  const verificationCodesCollection = db.collection("verification_codes");
  const usersCollection = db.collection("users");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const normalizeEmail = (email) => {
    return String(email || "").trim().toLowerCase();
  };

  const escapeRegex = (value) => {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  const generateCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  const isValidType = (type) => {
    return type === "login" || type === "signup";
  };

  const getUserByEmail = async (email) => {
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) return null;

    return usersCollection.findOne({
      email: {
        $regex: `^${escapeRegex(normalizedEmail)}$`,
        $options: "i",
      },
    });
  };

  router.get("/check-email", async (req, res) => {
    try {
      const email = normalizeEmail(req.query.email);

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required",
        });
      }

      const user = await getUserByEmail(email);

      return res.json({
        success: true,
        exists: !!user,
      });
    } catch (error) {
      console.error("Error checking email:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to check email",
      });
    }
  });

  router.post("/send-code", async (req, res) => {
    try {
      const { email, type, userData } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!normalizedEmail || !type) {
        return res.status(400).json({
          success: false,
          message: "Email and type are required",
        });
      }

      if (!isValidType(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification type",
        });
      }

      const existingUser = await getUserByEmail(normalizedEmail);

      if (type === "signup" && existingUser) {
        return res.status(409).json({
          success: false,
          message: "This email already has an account. Please login instead.",
        });
      }

      await verificationCodesCollection.deleteMany({
        email: normalizedEmail,
        type,
        verified: false,
      });

      const code = generateCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const verificationData = {
        email: normalizedEmail,
        code,
        type,
        userData: userData || null,
        createdAt: new Date(),
        expiresAt,
        verified: false,
        consumed: false,
        attempts: 0,
      };

      await verificationCodesCollection.insertOne(verificationData);

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: normalizedEmail,
        subject: "Your Verification Code - Creative Career AI",
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

      return res.json({
        success: true,
        message: "Verification code sent to your email",
      });
    } catch (error) {
      console.error("Error sending code:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send verification code",
      });
    }
  });

  router.post("/verify-code", async (req, res) => {
    try {
      const { email, code, type } = req.body;

      const normalizedEmail = normalizeEmail(email);
      const cleanCode = String(code || "").trim();

      if (!normalizedEmail || !cleanCode || !type) {
        return res.status(400).json({
          success: false,
          message: "Email, code and type are required",
        });
      }

      if (!isValidType(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification type",
        });
      }

      const verification = await verificationCodesCollection.findOne({
        email: normalizedEmail,
        code: cleanCode,
        type,
        verified: false,
        expiresAt: { $gt: new Date() },
      });

      if (!verification) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification code",
        });
      }

      await verificationCodesCollection.updateOne(
        { _id: verification._id },
        {
          $inc: { attempts: 1 },
          $set: {
            lastVerifiedAt: new Date(),
          },
        }
      );

      return res.json({
        success: true,
        message: "Code verified successfully",
        userData: verification.userData || null,
      });
    } catch (error) {
      console.error("Error verifying code:", error);

      return res.status(500).json({
        success: false,
        message: "Verification failed",
      });
    }
  });

  router.post("/consume-code", async (req, res) => {
    try {
      const { email, code, type } = req.body;

      const normalizedEmail = normalizeEmail(email);
      const cleanCode = String(code || "").trim();

      if (!normalizedEmail || !cleanCode || !type) {
        return res.status(400).json({
          success: false,
          message: "Email, code and type are required",
        });
      }

      if (!isValidType(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification type",
        });
      }

      const result = await verificationCodesCollection.updateOne(
        {
          email: normalizedEmail,
          code: cleanCode,
          type,
          verified: false,
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            verified: true,
            consumed: true,
            consumedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification code",
        });
      }

      return res.json({
        success: true,
        message: "Verification code consumed successfully",
      });
    } catch (error) {
      console.error("Error consuming code:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to consume verification code",
      });
    }
  });

  return router;
};