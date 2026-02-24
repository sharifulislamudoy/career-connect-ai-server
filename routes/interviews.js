const { ObjectId } = require('mongodb');

module.exports = (interviewsCollection) => {
    const express = require('express');
    const router = express.Router();

    // Save interview results
    router.post('/save', async (req, res) => {
        try {
            const interviewData = req.body;
            
            // Validate required fields
            if (!interviewData.userEmail || !interviewData.interviewConfig || !interviewData.results) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing required fields: userEmail, interviewConfig, and results are required'
                });
            }

            // Add timestamp if not provided
            if (!interviewData.timestamp) {
                interviewData.timestamp = new Date();
            }

            // Insert into database
            const result = await interviewsCollection.insertOne(interviewData);

            res.json({
                success: true,
                message: 'Interview results saved successfully',
                interviewId: result.insertedId
            });

        } catch (error) {
            console.error('Error saving interview results:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to save interview results',
                error: error.message
            });
        }
    });

    // Get all interviews for a user
    router.get('/user/:email', async (req, res) => {
        try {
            const userEmail = req.params.email;

            const interviews = await interviewsCollection
                .find({ userEmail: userEmail })
                .sort({ timestamp: -1 }) // Most recent first
                .toArray();

            res.json({
                success: true,
                interviews: interviews
            });

        } catch (error) {
            console.error('Error fetching user interviews:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch interviews',
                error: error.message
            });
        }
    });

    // Get specific interview by ID
    router.get('/:id', async (req, res) => {
        try {
            const interviewId = req.params.id;

            // Validate ObjectId
            if (!ObjectId.isValid(interviewId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid interview ID format'
                });
            }

            const interview = await interviewsCollection.findOne({
                _id: new ObjectId(interviewId)
            });

            if (!interview) {
                return res.status(404).json({
                    success: false,
                    message: 'Interview not found'
                });
            }

            res.json({
                success: true,
                interview: interview
            });

        } catch (error) {
            console.error('Error fetching interview:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch interview',
                error: error.message
            });
        }
    });

    // Get user's interview statistics
    router.get('/stats/:email', async (req, res) => {
        try {
            const userEmail = req.params.email;

            const interviews = await interviewsCollection
                .find({ userEmail: userEmail })
                .toArray();

            const stats = {
                totalInterviews: interviews.length,
                averageScore: 0,
                topics: {},
                difficultyBreakdown: {
                    beginner: 0,
                    intermediate: 0,
                    advanced: 0
                },
                recentScores: []
            };

            if (interviews.length > 0) {
                // Calculate average score
                const totalScore = interviews.reduce((sum, interview) => {
                    return sum + (interview.totalScore || 0);
                }, 0);
                stats.averageScore = totalScore / interviews.length;

                // Count topics
                interviews.forEach(interview => {
                    const topic = interview.interviewConfig?.topic || 'Unknown';
                    stats.topics[topic] = (stats.topics[topic] || 0) + 1;
                });

                // Count difficulty levels
                interviews.forEach(interview => {
                    const difficulty = interview.interviewConfig?.difficulty || 'beginner';
                    stats.difficultyBreakdown[difficulty]++;
                });

                // Get recent scores (last 5 interviews)
                stats.recentScores = interviews
                    .slice(0, 5)
                    .map(interview => ({
                        score: interview.totalScore || 0,
                        topic: interview.interviewConfig?.topic,
                        date: interview.timestamp
                    }));
            }

            res.json({
                success: true,
                stats: stats
            });

        } catch (error) {
            console.error('Error fetching interview statistics:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch interview statistics',
                error: error.message
            });
        }
    });

    // Delete an interview
    router.delete('/:id', async (req, res) => {
        try {
            const interviewId = req.params.id;

            // Validate ObjectId
            if (!ObjectId.isValid(interviewId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid interview ID format'
                });
            }

            const result = await interviewsCollection.deleteOne({
                _id: new ObjectId(interviewId)
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Interview not found'
                });
            }

            res.json({
                success: true,
                message: 'Interview deleted successfully'
            });

        } catch (error) {
            console.error('Error deleting interview:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to delete interview',
                error: error.message
            });
        }
    });

    return router;
};