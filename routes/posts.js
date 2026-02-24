const { ObjectId } = require('mongodb');

module.exports = (postsCollection) => {
    const express = require('express');
    const router = express.Router();

    // Check if postsCollection is available
    router.use((req, res, next) => {
        if (!postsCollection) {
            return res.status(503).json({
                success: false,
                message: 'Database not initialized. Please try again later.'
            });
        }
        next();
    });

    // Create a new post
    router.post('/', async (req, res) => {
        try {
            const postData = req.body;

            // Validate required fields
            if (!postData.content || !postData.userId || !postData.userEmail) {
                return res.status(400).json({
                    success: false,
                    message: 'Content, userId, and userEmail are required'
                });
            }

            const newPost = {
                content: postData.content,
                imageUrl: postData.imageUrl || '',
                userId: postData.userId,
                userEmail: postData.userEmail,
                userProfile: postData.userProfile || {},
                likes: [], // Ensure likes is always an array
                comments: [], // Ensure comments is always an array
                shares: 0,
                createdAt: new Date(),
                updatedAt: new Date()
            };

            const result = await postsCollection.insertOne(newPost);

            const createdPost = await postsCollection.findOne({ _id: result.insertedId });

            res.json({
                success: true,
                message: 'Post created successfully',
                post: createdPost
            });
        } catch (error) {
            console.error('Error creating post:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Get all posts with user data
    router.get('/', async (req, res) => {
        try {
            const posts = await postsCollection
                .find({})
                .sort({ createdAt: -1 })
                .toArray();

            // Ensure all posts have proper array structure
            const sanitizedPosts = posts.map(post => ({
                ...post,
                likes: Array.isArray(post.likes) ? post.likes : [],
                comments: Array.isArray(post.comments) ? post.comments : []
            }));

            res.json({
                success: true,
                posts: sanitizedPosts,
                count: sanitizedPosts.length
            });
        } catch (error) {
            console.error('Error fetching posts:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Like a post
    router.post('/:postId/like', async (req, res) => {
        try {
            const { postId } = req.params;
            const { userId, userEmail } = req.body;

            if (!userId || !userEmail) {
                return res.status(400).json({
                    success: false,
                    message: 'UserId and userEmail are required'
                });
            }

            const post = await postsCollection.findOne({ _id: new ObjectId(postId) });

            if (!post) {
                return res.status(404).json({
                    success: false,
                    message: 'Post not found'
                });
            }

            // Ensure likes is an array
            const likesArray = Array.isArray(post.likes) ? post.likes : [];
            const alreadyLiked = likesArray.some(like => like.userId === userId);

            let result;
            if (alreadyLiked) {
                // Unlike the post
                result = await postsCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    { 
                        $pull: { likes: { userId: userId } },
                        $set: { updatedAt: new Date() }
                    }
                );
            } else {
                // Like the post
                result = await postsCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    { 
                        $push: { 
                            likes: { 
                                userId, 
                                userEmail,
                                likedAt: new Date()
                            } 
                        },
                        $set: { updatedAt: new Date() }
                    }
                );
            }

            const updatedPost = await postsCollection.findOne({ _id: new ObjectId(postId) });

            res.json({
                success: true,
                message: alreadyLiked ? 'Post unliked' : 'Post liked',
                post: {
                    ...updatedPost,
                    likes: Array.isArray(updatedPost.likes) ? updatedPost.likes : [],
                    comments: Array.isArray(updatedPost.comments) ? updatedPost.comments : []
                }
            });
        } catch (error) {
            console.error('Error liking post:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Add comment to a post
    router.post('/:postId/comment', async (req, res) => {
        try {
            const { postId } = req.params;
            const { userId, userEmail, content, userProfile } = req.body;

            if (!userId || !userEmail || !content) {
                return res.status(400).json({
                    success: false,
                    message: 'UserId, userEmail, and content are required'
                });
            }

            const newComment = {
                _id: new ObjectId(),
                userId,
                userEmail,
                content,
                userProfile: userProfile || {},
                createdAt: new Date()
            };

            const result = await postsCollection.updateOne(
                { _id: new ObjectId(postId) },
                { 
                    $push: { comments: newComment },
                    $set: { updatedAt: new Date() }
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Post not found'
                });
            }

            const updatedPost = await postsCollection.findOne({ _id: new ObjectId(postId) });

            res.json({
                success: true,
                message: 'Comment added successfully',
                post: {
                    ...updatedPost,
                    likes: Array.isArray(updatedPost.likes) ? updatedPost.likes : [],
                    comments: Array.isArray(updatedPost.comments) ? updatedPost.comments : []
                }
            });
        } catch (error) {
            console.error('Error adding comment:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    // Delete a post
    router.delete('/:postId', async (req, res) => {
        try {
            const { postId } = req.params;
            const { userId } = req.body;

            const post = await postsCollection.findOne({ _id: new ObjectId(postId) });

            if (!post) {
                return res.status(404).json({
                    success: false,
                    message: 'Post not found'
                });
            }

            if (post.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    message: 'You can only delete your own posts'
                });
            }

            const result = await postsCollection.deleteOne({ _id: new ObjectId(postId) });

            res.json({
                success: true,
                message: 'Post deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting post:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    });

    return router;
};