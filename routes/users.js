// backend/routes/users.js
const { ObjectId } = require('mongodb');

module.exports = (usersCollection) => {
    const express = require('express');
    const router = express.Router();

    // Check if usersCollection is available
    router.use((req, res, next) => {
        if (!usersCollection) {
            return res.status(503).json({
                success: false,
                message: 'Database not initialized. Please try again later.'
            });
        }
        next();
    });

    // Create or update user
    router.post('/', async (req, res) => {
        try {
            const fields = ["displayName", "photoURL", "location", "profession", "bio", "skills", "experience", "education", "careerGoals", "phone", "website", "linkedin", "github", "socialLinks", "headline", "profileCompleted"];
            const userData = Object.fromEntries(fields.filter(key => key in req.body).map(key => [key, req.body[key]]));
            userData.uid = req.identity.uid;
            userData.email = req.identity.email;
            // Existing roles are preserved; only a new account can choose seeker/recruiter.
            const requestedType = ["jobSeeker", "recruiter"].includes(req.body.userType) ? req.body.userType : "jobSeeker";

            // Validate required fields
            if (!userData.uid || !userData.email) {
                return res.status(400).json({
                    success: false,
                    message: 'User ID and email are required'
                });
            }

            // Check if user already exists
            const existingUser = await usersCollection.findOne({ uid: userData.uid });

            if (existingUser) {
                // Update existing user
                const result = await usersCollection.updateOne(
                    { uid: userData.uid },
                    {
                        $set: {
                            ...userData,
                            updatedAt: new Date()
                        }
                    }
                );

                const updatedUser = await usersCollection.findOne({ uid: userData.uid }, {projection:{workspaceLock:0,devices:0}});

                return res.json({
                    success: true,
                    message: 'User updated successfully',
                    user: updatedUser
                });
            } else {
                // Create new user with default package
                const newUser = {
                    ...userData,
                    userType: requestedType, // Default to jobSeeker
                    package: 'basic', // Default package
                    profileCompleted: false,
                    createdAt: new Date(),
                    updatedAt: new Date()
                };

                const result = await usersCollection.updateOne({uid: userData.uid}, {$setOnInsert: newUser}, {upsert:true});
                const storedUser=await usersCollection.findOne({uid:userData.uid},{projection:{devices:0,workspaceLock:0}});

                return res.json({
                    success: true,
                    message: 'User created successfully',
                    user: storedUser
                });
            }
        } catch (error) {
            console.error('Error creating/updating user:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Get user by UID - Return 404 if not found
    router.get('/:uid', async (req, res) => {
        try {
            const { uid } = req.params;

            const actor = await usersCollection.findOne({ uid: req.identity.uid });
            const ownOrStaff = uid === req.identity.uid || require('../services/staff').allowed(actor, 'users');
            const projection = ownOrStaff ? {workspaceLock:0,devices:0} : { uid: 1, displayName: 1, photoURL: 1, profession: 1, location: 1, bio: 1, skills: 1, experience: 1, education: 1, userType: 1, profileCompleted: 1 };
            const user = await usersCollection.findOne({ uid }, { projection });

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found in database'
                });
            }

            res.json({
                success: true,
                user
            });
        } catch (error) {
            console.error('Error fetching user:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Get all users (for admin purposes)
    router.get('/', async (req, res) => {
        try {
            const actor = await usersCollection.findOne({ uid: req.identity.uid });
            const staff = require('../services/staff').allowed(actor, 'users');
            const projection = staff ? {workspaceLock:0,devices:0} : { uid: 1, displayName: 1, photoURL: 1, profession: 1, location: 1, bio: 1, skills: 1, experience: 1, education: 1, userType: 1, profileCompleted: 1 };
            const users = await usersCollection.find({}, { projection }).toArray();

            res.json({
                success: true,
                users,
                count: users.length
            });
        } catch (error) {
            console.error('Error fetching users:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Update user profile
    router.put('/:uid', async (req, res) => {
        try {
            const { uid } = req.params;
            if (uid !== req.identity.uid) return res.status(403).json({ success: false, message: "You can only update your own profile." });
            const protectedFields = new Set(["_id", "uid", "email", "userType", "role", "package", "packageExpiry", "createdAt", "isBlocked", "isBanned", "status", "devices", "workspaceLock", "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus", "billingCycle", "cancelAtPeriodEnd", "moderatorModules", "banId", "banReason", "bannedAt", "reopenedAt"]);
            const updateData = Object.fromEntries(Object.entries(req.body).filter(([key]) => !protectedFields.has(key) && !key.startsWith("$") && !key.includes(".")));

            const result = await usersCollection.updateOne(
                { uid },
                {
                    $set: {
                        ...updateData,
                        updatedAt: new Date()
                    }
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            const updatedUser = await usersCollection.findOne({ uid }, {projection:{workspaceLock:0,devices:0}});

            res.json({
                success: true,
                message: 'User updated successfully',
                user: updatedUser
            });
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Delete user
    router.delete('/:uid', async (req, res) => {
        try {
            const actor = await usersCollection.findOne({ uid: req.identity.uid });
            if (actor?.userType !== 'admin') return res.status(403).json({ success: false, message: 'Admin access required.' });
            const { uid } = req.params;

            const result = await usersCollection.deleteOne({ uid });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                message: 'User deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Check if user is recruiter
    router.get('/:uid/is-recruiter', async (req, res) => {
        try {
            const { uid } = req.params;

            const user = await usersCollection.findOne({ uid });

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                isRecruiter: user.userType === 'recruiter'
            });
        } catch (error) {
            console.error('Error checking user type:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Check if user exists (for login validation)
    router.get('/:uid/exists', async (req, res) => {
        try {
            const { uid } = req.params;

            const user = await usersCollection.findOne({ uid });

            res.json({
                success: true,
                exists: !!user
            });
        } catch (error) {
            console.error('Error checking user existence:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    return router;
};