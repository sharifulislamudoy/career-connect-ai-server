const express = require("express");
const multer = require("multer");
const PDFParser = require("pdf2json");
const { Groq } = require("groq-sdk");

const router = express.Router();

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

module.exports = (atsScoresCollection) => {
  // ATS Score Check endpoint
  router.post("/check-score", upload.single("resume"), async (req, res) => {
    try {
      const { userEmail, jobDescription } = req.body;
      
      if (!req.file) {
        return res.status(400).json({ error: "No resume file uploaded" });
      }

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" });
      }

      // Extract text from PDF using pdf2json
      const resumeText = await parsePDF(req.file.buffer);

      if (!resumeText || resumeText.trim().length === 0) {
        return res.status(400).json({ error: "Could not extract text from resume. The PDF might be scanned or image-based." });
      }

      // Analyze resume with Groq AI
      const analysisResult = await analyzeResumeWithAI(resumeText, jobDescription);

      // Save to database
      const atsScoreDoc = {
        userEmail,
        resumeText: resumeText.substring(0, 1000), // Store first 1000 chars
        fileName: req.file.originalname,
        fileSize: req.file.size,
        jobDescription: jobDescription || "",
        score: analysisResult.score,
        suggestions: analysisResult.suggestions,
        strengths: analysisResult.strengths,
        weaknesses: analysisResult.weaknesses,
        keywords: analysisResult.keywords,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await atsScoresCollection.insertOne(atsScoreDoc);

      res.json({
        success: true,
        scoreId: result.insertedId,
        score: analysisResult.score,
        suggestions: analysisResult.suggestions,
        strengths: analysisResult.strengths,
        weaknesses: analysisResult.weaknesses,
        keywords: analysisResult.keywords,
        resumePreview: resumeText.substring(0, 500) + "..."
      });

    } catch (error) {
      console.error("ATS Score check error:", error);
      res.status(500).json({ 
        error: "Failed to analyze resume",
        details: error.message 
      });
    }
  });

  // Get user's ATS score history
  router.get("/history/:userEmail", async (req, res) => {
    try {
      const { userEmail } = req.params;
      
      const scores = await atsScoresCollection
        .find({ userEmail })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();

      res.json({
        success: true,
        scores: scores.map(score => ({
          id: score._id,
          fileName: score.fileName,
          score: score.score,
          jobDescription: score.jobDescription,
          createdAt: score.createdAt,
          suggestions: score.suggestions
        }))
      });

    } catch (error) {
      console.error("Get score history error:", error);
      res.status(500).json({ 
        error: "Failed to fetch score history",
        details: error.message 
      });
    }
  });

  // Get specific ATS score details
  router.get("/score/:scoreId", async (req, res) => {
    try {
      const { scoreId } = req.params;
      
      const score = await atsScoresCollection.findOne({
        _id: new ObjectId(scoreId)
      });

      if (!score) {
        return res.status(404).json({ error: "Score not found" });
      }

      res.json({
        success: true,
        score: {
          id: score._id,
          userEmail: score.userEmail,
          fileName: score.fileName,
          score: score.score,
          jobDescription: score.jobDescription,
          suggestions: score.suggestions,
          strengths: score.strengths,
          weaknesses: score.weaknesses,
          keywords: score.keywords,
          createdAt: score.createdAt
        }
      });

    } catch (error) {
      console.error("Get score details error:", error);
      res.status(500).json({ 
        error: "Failed to fetch score details",
        details: error.message 
      });
    }
  });

  return router;
};

// PDF parsing function using pdf2json
function parsePDF(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();
    
    pdfParser.on("pdfParser_dataError", errData => {
      reject(new Error(errData.parserError));
    });

    pdfParser.on("pdfParser_dataReady", pdfData => {
      try {
        let text = "";
        pdfData.Pages.forEach(page => {
          page.Texts.forEach(textItem => {
            text += decodeURIComponent(textItem.R[0].T) + " ";
          });
          text += "\n";
        });
        resolve(text.trim());
      } catch (error) {
        reject(error);
      }
    });

    pdfParser.parseBuffer(pdfBuffer);
  });
}

// AI Analysis Function (same as before)
async function analyzeResumeWithAI(resumeText, jobDescription = "") {
  const prompt = `
    Analyze this resume for ATS (Applicant Tracking System) compatibility and provide a detailed assessment.

    RESUME TEXT:
    ${resumeText.substring(0, 4000)}

    ${jobDescription ? `TARGET JOB DESCRIPTION: ${jobDescription}` : ''}

    Please provide a comprehensive analysis in the following JSON format:
    {
      "score": 85,
      "suggestions": [
        "Add more quantifiable achievements",
        "Include relevant keywords from job description",
        "Improve formatting consistency"
      ],
      "strengths": [
        "Clear work experience timeline",
        "Relevant technical skills",
        "Good education background"
      ],
      "weaknesses": [
        "Missing quantifiable results",
        "Limited industry-specific keywords",
        "Formatting issues"
      ],
      "keywords": {
        "found": ["JavaScript", "React", "Node.js"],
        "missing": ["TypeScript", "AWS", "CI/CD"]
      }
    }

    Scoring Guidelines:
    - 90-100: Excellent ATS optimization
    - 80-89: Good, minor improvements needed
    - 70-79: Average, several areas need improvement
    - 60-69: Below average, significant improvements needed
    - Below 60: Poor ATS optimization

    Focus on:
    1. Keyword optimization and relevance
    2. Formatting and structure
    3. Quantifiable achievements
    4. Skills presentation
    5. Overall readability and ATS compatibility

    Be constructive and provide actionable suggestions.
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an expert ATS (Applicant Tracking System) analyzer. Provide accurate, constructive feedback on resume optimization for ATS systems. Always respond with valid JSON format."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.3,
      max_tokens: 2048,
      response_format: { type: "json_object" }
    });

    const analysis = JSON.parse(completion.choices[0].message.content);
    
    // Validate and ensure proper structure
    return {
      score: Math.min(100, Math.max(0, analysis.score || 50)),
      suggestions: analysis.suggestions || ["No specific suggestions available"],
      strengths: analysis.strengths || ["No specific strengths identified"],
      weaknesses: analysis.weaknesses || ["No specific weaknesses identified"],
      keywords: analysis.keywords || { found: [], missing: [] }
    };

  } catch (error) {
    console.error("Groq AI analysis error:", error);
    
    // Fallback analysis if AI fails
    return {
      score: 50,
      suggestions: [
        "Unable to perform detailed analysis. Please try again.",
        "Ensure your resume is in a readable PDF format",
        "Check that text can be properly extracted from your resume"
      ],
      strengths: ["Resume uploaded successfully"],
      weaknesses: ["Detailed analysis unavailable"],
      keywords: { found: [], missing: [] }
    };
  }
}