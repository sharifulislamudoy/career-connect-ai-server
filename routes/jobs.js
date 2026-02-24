const { ObjectId } = require('mongodb');
const express = require('express');

module.exports = (jobsCollection, applicationsCollection, usersCollection) => {
  const router = express.Router();

  // Middleware to check database connection
  router.use((req, res, next) => {
    if (!jobsCollection || !applicationsCollection) {
      return res.status(503).json({
        success: false,
        message: 'Database not initialized. Please try again later.'
      });
    }
    next();
  });

  // ============ JOB ROUTES ============

  // POST: Create a new job (Recruiter only)
  router.post('/', async (req, res) => {
    try {
      const jobData = req.body;
      
      // Validate required fields
      const requiredFields = ['title', 'company', 'location', 'description', 'recruiterId'];
      for (const field of requiredFields) {
        if (!jobData[field]) {
          return res.status(400).json({
            success: false,
            message: `${field} is required`
          });
        }
      }

      // Check if user is a recruiter
      const user = await usersCollection.findOne({ uid: jobData.recruiterId });
      if (!user || user.userType !== 'recruiter') {
        return res.status(403).json({
          success: false,
          message: 'Only recruiters can post jobs'
        });
      }

      const newJob = {
        ...jobData,
        status: 'active',
        applicants: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await jobsCollection.insertOne(newJob);

      res.status(201).json({
        success: true,
        message: 'Job posted successfully',
        job: { ...newJob, _id: result.insertedId }
      });

    } catch (error) {
      console.error('Error creating job:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get all jobs (for jobs page)
  router.get('/', async (req, res) => {
    try {
      const { 
        page = 1, 
        limit = 12, 
        search = '',
        location = '',
        type = '',
        experience = ''
      } = req.query;
      
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Build filter query
      let filter = { status: 'active' };
      
      if (search) {
        filter.$or = [
          { title: { $regex: search, $options: 'i' } },
          { company: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }
      
      if (location) {
        filter.location = { $regex: location, $options: 'i' };
      }
      
      if (type) {
        filter.type = type;
      }
      
      if (experience) {
        filter.experience = experience;
      }

      const jobs = await jobsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      const totalJobs = await jobsCollection.countDocuments(filter);

      res.json({
        success: true,
        jobs,
        pagination: {
          total: totalJobs,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(totalJobs / parseInt(limit))
        }
      });
    } catch (error) {
      console.error('Error fetching jobs:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get job by ID
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      const job = await jobsCollection.findOne({ _id: new ObjectId(id) });

      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      res.json({
        success: true,
        job
      });
    } catch (error) {
      console.error('Error fetching job:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get jobs posted by a specific recruiter
  router.get('/recruiter/:recruiterId', async (req, res) => {
    try {
      const { recruiterId } = req.params;
      
      const jobs = await jobsCollection
        .find({ recruiterId })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        jobs,
        count: jobs.length
      });
    } catch (error) {
      console.error('Error fetching recruiter jobs:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get job for editing
  router.get('/edit/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { recruiterId } = req.query;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      const job = await jobsCollection.findOne({ _id: new ObjectId(id) });

      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      // Check if user is the owner
      if (job.recruiterId !== recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to edit this job'
        });
      }

      res.json({
        success: true,
        job
      });
    } catch (error) {
      console.error('Error fetching job for edit:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // PUT: Update job
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      // Check if job exists and user is owner
      const existingJob = await jobsCollection.findOne({ _id: new ObjectId(id) });
      if (!existingJob) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      if (existingJob.recruiterId !== updateData.recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to update this job'
        });
      }

      const result = await jobsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            ...updateData,
            updatedAt: new Date()
          }
        }
      );

      const updatedJob = await jobsCollection.findOne({ _id: new ObjectId(id) });

      res.json({
        success: true,
        message: 'Job updated successfully',
        job: updatedJob
      });
    } catch (error) {
      console.error('Error updating job:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // DELETE: Delete job
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { recruiterId } = req.query;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      // Check if user is the owner
      const job = await jobsCollection.findOne({ _id: new ObjectId(id) });
      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      if (job.recruiterId !== recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to delete this job'
        });
      }

      const result = await jobsCollection.deleteOne({ _id: new ObjectId(id) });

      // Also delete related applications
      await applicationsCollection.deleteMany({ jobId: id });

      res.json({
        success: true,
        message: 'Job deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting job:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // ============ APPLICATION ROUTES ============

  // POST: Apply for a job
  router.post('/:jobId/apply', async (req, res) => {
    try {
      const { jobId } = req.params;
      const applicationData = req.body;

      // Validate required fields
      if (!applicationData.jobSeekerId || !applicationData.email || !applicationData.fullName) {
        return res.status(400).json({
          success: false,
          message: 'Missing required application fields'
        });
      }

      // Check if job exists and is active
      const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      if (job.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'This job is no longer accepting applications'
        });
      }

      // Check application deadline
      if (job.applicationDeadline && new Date(job.applicationDeadline) < new Date()) {
        return res.status(400).json({
          success: false,
          message: 'Application deadline has passed'
        });
      }

      // Check if user has already applied
      const existingApplication = await applicationsCollection.findOne({
        jobId,
        jobSeekerId: applicationData.jobSeekerId
      });

      if (existingApplication) {
        return res.status(400).json({
          success: false,
          message: 'You have already applied for this job'
        });
      }

      const newApplication = {
        jobId,
        ...applicationData,
        status: 'pending',
        appliedAt: new Date(),
        updatedAt: new Date()
      };

      const result = await applicationsCollection.insertOne(newApplication);

      // Update applicant count in job
      await jobsCollection.updateOne(
        { _id: new ObjectId(jobId) },
        { $inc: { applicants: 1 } }
      );

      res.status(201).json({
        success: true,
        message: 'Application submitted successfully',
        application: { ...newApplication, _id: result.insertedId }
      });

    } catch (error) {
      console.error('Error submitting application:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get applications for a job (Recruiter view)
  router.get('/:jobId/applications', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { recruiterId } = req.query;

      if (!ObjectId.isValid(jobId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      // Verify recruiter owns this job
      const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
      if (!job || job.recruiterId !== recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to view applications for this job'
        });
      }

      const applications = await applicationsCollection
        .find({ jobId })
        .sort({ appliedAt: -1 })
        .toArray();

      res.json({
        success: true,
        applications,
        count: applications.length,
        jobTitle: job.title
      });
    } catch (error) {
      console.error('Error fetching applications:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get jobs applied by a job seeker
  router.get('/applied/:jobSeekerId', async (req, res) => {
    try {
      const { jobSeekerId } = req.params;

      // Get all applications by this job seeker
      const applications = await applicationsCollection
        .find({ jobSeekerId })
        .sort({ appliedAt: -1 })
        .toArray();

      // Get job details for each application
      const jobIds = applications.map(app => app.jobId);
      const jobs = await jobsCollection
        .find({ _id: { $in: jobIds.map(id => new ObjectId(id)) } })
        .toArray();

      // Create a map for quick lookup
      const jobMap = {};
      jobs.forEach(job => {
        jobMap[job._id.toString()] = job;
      });

      // Combine application with job data
      const appliedJobs = applications.map(application => ({
        ...application,
        job: jobMap[application.jobId] || null
      }));

      res.json({
        success: true,
        appliedJobs,
        count: appliedJobs.length
      });
    } catch (error) {
      console.error('Error fetching applied jobs:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // GET: Get single application details
  router.get('/applications/:applicationId', async (req, res) => {
    try {
      const { applicationId } = req.params;
      const { userId, userType } = req.query;

      if (!ObjectId.isValid(applicationId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid application ID'
        });
      }

      const application = await applicationsCollection.findOne({ 
        _id: new ObjectId(applicationId) 
      });

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found'
        });
      }

      // Check permissions
      if (userType === 'jobSeeker' && application.jobSeekerId !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to view this application'
        });
      }

      if (userType === 'recruiter') {
        const job = await jobsCollection.findOne({ _id: new ObjectId(application.jobId) });
        if (!job || job.recruiterId !== userId) {
          return res.status(403).json({
            success: false,
            message: 'Unauthorized to view this application'
          });
        }
      }

      // Get job details
      const job = await jobsCollection.findOne({ _id: new ObjectId(application.jobId) });

      res.json({
        success: true,
        application: {
          ...application,
          job: job || null
        }
      });
    } catch (error) {
      console.error('Error fetching application:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // PUT: Update application status (Recruiter only)
  router.put('/applications/:applicationId/status', async (req, res) => {
    try {
      const { applicationId } = req.params;
      const { status, recruiterId } = req.body;

      if (!['pending', 'reviewed', 'accepted', 'rejected'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      if (!ObjectId.isValid(applicationId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid application ID'
        });
      }

      // Get application to find the job
      const application = await applicationsCollection.findOne({ 
        _id: new ObjectId(applicationId) 
      });

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found'
        });
      }

      // Verify recruiter owns the job
      const job = await jobsCollection.findOne({ _id: new ObjectId(application.jobId) });
      if (!job || job.recruiterId !== recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to update this application'
        });
      }

      const result = await applicationsCollection.updateOne(
        { _id: new ObjectId(applicationId) },
        {
          $set: {
            status,
            updatedAt: new Date()
          }
        }
      );

      // If accepted, mark other applications as rejected (optional)
      if (status === 'accepted') {
        await applicationsCollection.updateMany(
          {
            jobId: application.jobId,
            _id: { $ne: new ObjectId(applicationId) },
            status: { $in: ['pending', 'reviewed'] }
          },
          {
            $set: { status: 'rejected', updatedAt: new Date() }
          }
        );
      }

      res.json({
        success: true,
        message: 'Application status updated successfully'
      });
    } catch (error) {
      console.error('Error updating application status:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // PUT: Update job status
  router.put('/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const { status, recruiterId } = req.body;

      if (!['active', 'draft', 'closed'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid job ID'
        });
      }

      // Check if user is the owner
      const job = await jobsCollection.findOne({ _id: new ObjectId(id) });
      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Job not found'
        });
      }

      if (job.recruiterId !== recruiterId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to update this job'
        });
      }

      const result = await jobsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status,
            updatedAt: new Date()
          }
        }
      );

      res.json({
        success: true,
        message: 'Job status updated successfully'
      });
    } catch (error) {
      console.error('Error updating job status:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  return router;
};