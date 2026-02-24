const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

module.exports = (db) => {
  const resumesCollection = db.collection('resumes');

  // Save resume
  router.post('/', async (req, res) => {
    try {
      const resumeData = req.body;
      
      // Validate required fields
      if (!resumeData || !resumeData.userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      const result = await resumesCollection.insertOne({
        ...resumeData,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      
      res.json({ 
        success: true, 
        id: result.insertedId,
        message: 'Resume saved successfully'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update resume
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;

      const result = await resumesCollection.updateOne(
        { _id: new require('mongodb').ObjectId(id) },
        { 
          $set: {
            ...updateData,
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Resume not found' });
      }

      res.json({ 
        success: true, 
        message: 'Resume updated successfully' 
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get all resumes for a user
  router.get('/user/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const resumes = await resumesCollection.find({ userId }).toArray();
      
      res.json(resumes);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get resume by ID
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const resume = await resumesCollection.findOne({ 
        _id: new require('mongodb').ObjectId(id) 
      });

      if (!resume) {
        return res.status(404).json({ error: 'Resume not found' });
      }

      res.json(resume);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete resume
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;

      const result = await resumesCollection.deleteOne({ 
        _id: new require('mongodb').ObjectId(id) 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Resume not found' });
      }

      res.json({ 
        success: true, 
        message: 'Resume deleted successfully' 
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Generate PDF
  router.post('/generate-pdf', async (req, res) => {
    let doc;

    try {
      const resumeData = req.body;

      // Validate resume data
      if (!resumeData || !resumeData.personal || !resumeData.personal.name) {
        return res.status(400).json({ error: 'Invalid resume data: personal name is required' });
      }

      // Create a PDF document with ATS optimized margins
      doc = new PDFDocument({
        margin: 50,
        size: 'A4',
        info: {
          Title: `Resume - ${resumeData.personal.name}`,
          Author: resumeData.personal.name,
          Subject: 'Professional Resume',
          Keywords: 'resume,CV,professional'
        }
      });

      // Set response headers
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${resumeData.personal.name.replace(/\s+/g, '_')}_Resume.pdf"`);

      // Pipe the PDF to response
      doc.pipe(res);

      // Helper function to check if section has data
      const hasData = (section) => {
        if (!section) return false;
        if (Array.isArray(section)) {
          return section.length > 0 && section.some(item => {
            if (typeof item === 'object') {
              return Object.values(item).some(val => val && val.toString().trim() !== '');
            }
            return item && item.toString().trim() !== '';
          });
        }
        return section.toString().trim() !== '';
      };

      // Helper function to get valid text
      const getValidText = (text, defaultText = '') => {
        return text && text.toString().trim() !== '' ? text.toString().trim() : defaultText;
      };

      let yPosition = 50;

      // ========== PERSONAL INFORMATION SECTION ==========
      // Name
      doc.fontSize(18).font('Helvetica-Bold')
        .fillColor('#000000')
        .text(getValidText(resumeData.personal.name).toUpperCase(), 50, yPosition, { align: 'left' });

      yPosition += 25;

      // Title
      if (hasData(resumeData.personal.title)) {
        doc.fontSize(12).font('Helvetica')
          .fillColor('#333333')
          .text(getValidText(resumeData.personal.title), 50, yPosition, { align: 'left' });

        yPosition += 20;
      }

      // Contact Information
      const contactInfo = [];
      if (hasData(resumeData.personal.email)) contactInfo.push(getValidText(resumeData.personal.email));
      if (hasData(resumeData.personal.phone)) contactInfo.push(getValidText(resumeData.personal.phone));
      if (hasData(resumeData.personal.location)) contactInfo.push(getValidText(resumeData.personal.location));
      if (hasData(resumeData.personal.website)) contactInfo.push(getValidText(resumeData.personal.website));
      if (hasData(resumeData.personal.github)) contactInfo.push(getValidText(resumeData.personal.github));

      if (contactInfo.length > 0) {
        doc.fontSize(9).font('Helvetica')
          .fillColor('#0066cc')
          .text(contactInfo.join(' • '), 50, yPosition, {
            width: 500,
            align: 'left'
          });

        yPosition += 20;
      }

      // Reset text color
      doc.fillColor('#000000');

      // ========== CAREER OBJECTIVE SECTION ==========
      if (hasData(resumeData.personal.summary)) {
        if (yPosition > 650) {
          doc.addPage();
          yPosition = 50;
        }

        // Section title
        doc.fontSize(12).font('Helvetica-Bold')
          .text('CAREER OBJECTIVE', 50, yPosition);

        // Underline
        doc.moveTo(50, yPosition + 15)
          .lineTo(550, yPosition + 15)
          .strokeColor('#333333')
          .stroke();

        yPosition += 30;

        // Section content
        const summaryText = getValidText(resumeData.personal.summary);
        const summaryHeight = doc.heightOfString(summaryText, {
          width: 500,
          align: 'left',
          lineGap: 3
        });

        doc.fontSize(10).font('Helvetica')
          .text(summaryText, 50, yPosition, {
            width: 500,
            align: 'left',
            lineGap: 3
          });

        yPosition += summaryHeight + 20;
      }

      // ========== TECHNICAL SKILLS SECTION ==========
      if (hasData(resumeData.skills)) {
        if (yPosition > 650) {
          doc.addPage();
          yPosition = 50;
        }

        // Section title
        doc.fontSize(12).font('Helvetica-Bold')
          .text('SKILLS', 50, yPosition);

        // Underline
        doc.moveTo(50, yPosition + 15)
          .lineTo(550, yPosition + 15)
          .strokeColor('#333333')
          .stroke();

        yPosition += 30;

        // Skills list
        const validSkills = resumeData.skills
          .filter(skill => hasData(skill.name))
          .map(skill => getValidText(skill.name));

        if (validSkills.length > 0) {
          validSkills.forEach((skill, index) => {
            // Check if we need a new page
            if (yPosition > 700) {
              doc.addPage();
              yPosition = 50;
            }

            doc.fontSize(10).font('Helvetica')
              .text('• ' + skill, 50, yPosition);

            yPosition += 20;
          });
          yPosition += 10;
        }
      }

      // ========== PROJECTS SECTION ==========
      if (hasData(resumeData.projects)) {
        const validProjects = resumeData.projects.filter(project =>
          hasData(project.name) ||
          hasData(project.description) ||
          hasData(project.technologies)
        );

        if (validProjects.length > 0) {
          if (yPosition > 650) {
            doc.addPage();
            yPosition = 50;
          }

          doc.fontSize(12).font('Helvetica-Bold')
            .text('PROJECTS', 50, yPosition);

          doc.moveTo(50, yPosition + 15)
            .lineTo(550, yPosition + 15)
            .strokeColor('#333333')
            .stroke();

          yPosition += 30;

          validProjects.forEach((project, index) => {
            if (yPosition > 700) {
              doc.addPage();
              yPosition = 50;
            }

            let projectY = yPosition;

            // Project Name
            if (hasData(project.name)) {
              doc.fontSize(10).font('Helvetica-Bold')
                .text(getValidText(project.name), 50, projectY);

              projectY += 15;
            }

            // Technologies
            if (hasData(project.technologies)) {
              doc.fontSize(9).font('Helvetica')
                .fillColor('#666666')
                .text(`Technologies: ${getValidText(project.technologies)}`, 50, projectY);

              projectY += 15;
            }

            // Description
            if (hasData(project.description)) {
              doc.fontSize(9).font('Helvetica')
                .fillColor('#000000')
                .text(getValidText(project.description), 50, projectY, {
                  width: 500,
                  align: 'left',
                  lineGap: 2
                });

              projectY += doc.heightOfString(getValidText(project.description), { width: 500 }) + 15;
            }

            yPosition = projectY;

            // Add space between projects
            if (index < validProjects.length - 1) {
              yPosition += 15;
            }
          });

          yPosition += 20;
        }
      }

      // ========== EXPERIENCE SECTION ==========
      if (hasData(resumeData.experience)) {
        const validExperience = resumeData.experience.filter(exp =>
          hasData(exp.company) || hasData(exp.position) || hasData(exp.description)
        );

        if (validExperience.length > 0) {
          if (yPosition > 650) {
            doc.addPage();
            yPosition = 50;
          }

          doc.fontSize(12).font('Helvetica-Bold')
            .text('EXPERIENCE', 50, yPosition);

          doc.moveTo(50, yPosition + 15)
            .lineTo(550, yPosition + 15)
            .strokeColor('#333333')
            .stroke();

          yPosition += 30;

          validExperience.forEach((exp, index) => {
            if (yPosition > 700) {
              doc.addPage();
              yPosition = 50;
            }

            let expY = yPosition;

            // Position and Company
            if (hasData(exp.position) || hasData(exp.company)) {
              const positionText = hasData(exp.position) ? getValidText(exp.position) : '';
              const companyText = hasData(exp.company) ? getValidText(exp.company) : '';
              
              doc.fontSize(10).font('Helvetica-Bold')
                .text(`${positionText}${positionText && companyText ? ' at ' : ''}${companyText}`, 50, expY);

              expY += 15;
            }

            // Duration
            if (hasData(exp.duration)) {
              doc.fontSize(9).font('Helvetica')
                .fillColor('#666666')
                .text(getValidText(exp.duration), 50, expY);

              expY += 15;
            }

            // Description
            if (hasData(exp.description)) {
              doc.fontSize(9).font('Helvetica')
                .fillColor('#000000')
                .text(getValidText(exp.description), 50, expY, {
                  width: 500,
                  align: 'left',
                  lineGap: 2
                });

              expY += doc.heightOfString(getValidText(exp.description), { width: 500 }) + 20;
            }

            yPosition = expY;

            // Add space between experiences
            if (index < validExperience.length - 1) {
              yPosition += 15;
            }
          });

          yPosition += 20;
        }
      }

      // ========== EDUCATION SECTION ==========
      if (hasData(resumeData.education)) {
        const validEducation = resumeData.education.filter(edu =>
          hasData(edu.institution) || hasData(edu.degree) || hasData(edu.duration)
        );

        if (validEducation.length > 0) {
          if (yPosition > 650) {
            doc.addPage();
            yPosition = 50;
          }

          doc.fontSize(12).font('Helvetica-Bold')
            .text('EDUCATION', 50, yPosition);

          doc.moveTo(50, yPosition + 15)
            .lineTo(550, yPosition + 15)
            .strokeColor('#333333')
            .stroke();

          yPosition += 30;

          validEducation.forEach((edu, index) => {
            if (yPosition > 700) {
              doc.addPage();
              yPosition = 50;
            }

            let eduY = yPosition;

            // Institution and Degree
            if (hasData(edu.institution) || hasData(edu.degree)) {
              const institutionText = hasData(edu.institution) ? getValidText(edu.institution) : '';
              const degreeText = hasData(edu.degree) ? getValidText(edu.degree) : '';
              
              doc.fontSize(10).font('Helvetica-Bold')
                .text(`${degreeText}${degreeText && institutionText ? ', ' : ''}${institutionText}`, 50, eduY);

              eduY += 15;
            }

            // Duration
            if (hasData(edu.duration)) {
              doc.fontSize(9).font('Helvetica')
                .fillColor('#666666')
                .text(getValidText(edu.duration), 50, eduY);

              eduY += 15;
            }

            yPosition = eduY;

            // Add space between education entries
            if (index < validEducation.length - 1) {
              yPosition += 15;
            }
          });
        }
      }

      // ========== FOOTER ==========
      try {
        const pageRange = doc.bufferedPageRange();
        if (pageRange && pageRange.count > 0) {
          for (let i = 0; i < pageRange.count; i++) {
            doc.switchToPage(i);
            doc.fontSize(8)
              .fillColor('#999999')
              .text(
                `Generated on ${new Date().toLocaleDateString()}`,
                50,
                doc.page.height - 30,
                { align: 'center', width: 500 }
              );
          }
        }
      } catch (footerError) {
        console.warn('Could not add footer to PDF:', footerError.message);
      }

      // Finalize the PDF
      doc.end();

    } catch (error) {
      console.error('Error generating PDF:', error);

      if (doc && !doc.ended) {
        try {
          doc.end();
        } catch (endError) {
          console.error('Error ending PDF document:', endError);
        }
      }

      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!require('mongodb').ObjectId.isValid(id)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid resume ID' 
      });
    }

    const result = await resumesCollection.deleteOne({ 
      _id: new require('mongodb').ObjectId(id) 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Resume not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Resume deleted successfully' 
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

  return router;
};