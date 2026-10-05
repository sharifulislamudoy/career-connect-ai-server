const PDFDocument = require('pdfkit');
const string = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fields = {
  skills: ['name', 'category'], experience: ['position', 'company', 'duration', 'description'],
  education: ['degree', 'institution', 'duration', 'field', 'gpa'],
  projects: ['name', 'role', 'description', 'achievements', 'technologies'],
  certifications: ['name', 'issuer', 'date', 'url'], languages: ['name', 'proficiency'],
};
function projectLinks(project = {}) {
  project = project || {};
  if (Array.isArray(project.links)) return project.links;
  return [['Live Link', project.liveUrl], ['GitHub Client', project.githubUrl], ['GitHub Server', project.serverUrl]].filter(([, url]) => url).map(([label, url]) => ({ label, url }));
}
function normalizeResume(body = {}) {
  const personal = Object.fromEntries(['name', 'title', 'email', 'phone', 'location', 'website', 'github', 'linkedin', 'summary'].map(key => [key, string(body.personal?.[key])]));
  const documentType = body.documentType === 'cv' ? 'cv' : 'resume';
  const data = { personal, documentType, photoUrl: documentType === 'cv' ? string(body.photoUrl, 3000) : '', title: string(body.title, 150) || `${personal.name || 'Untitled'} - ${documentType === 'cv' ? 'CV' : 'Resume'}`, coachEnabled: body.coachEnabled !== false };
  data.template = ['ats','professional','compact'].includes(body.template) ? body.template : 'ats';
  data.customStyle = {};
  if (body.customStyle?.accent && /^#[0-9a-f]{6}$/i.test(body.customStyle.accent)) data.customStyle.accent = body.customStyle.accent;
  if ([9,10,11].includes(Number(body.customStyle?.fontSize))) data.customStyle.fontSize = Number(body.customStyle.fontSize);
  for (const [section, keys] of Object.entries(fields)) {
    if (body[section] !== undefined && !Array.isArray(body[section])) throw new Error(`${section} must be an array.`);
    if ((body[section]?.length || 0) > 30) throw new Error(`Use at most 30 ${section} entries.`);
    data[section] = (body[section] || []).map(item => {
      const entry = Object.fromEntries(keys.map(key => [key, string(typeof item === 'string' && key === 'name' ? item : item?.[key])]));
      if (section === 'projects') {
        if (item?.links !== undefined && !Array.isArray(item.links)) throw new Error('Project links must be a list.');
        const links = projectLinks(item || {});
        if (links.length > 12) throw new Error('Use at most 12 links per project.');
        entry.links = links.map(link => ({ label: string(link?.label, 40), url: string(link?.url, 3000) })).filter(link => link.label || link.url);
      }
      return entry;
    }).filter(item => Object.values(item).some(value => Array.isArray(value) ? value.length : value));
  }
  if (JSON.stringify(data).length > 80000) throw new Error('Document is too long. Use at most 80,000 characters.');
  return data;
}
function validateResume(data, complete = false) {
  if (!data.personal.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.personal.email)) throw new Error('Enter your name and a valid email.');
  for (const value of [data.personal.website, data.personal.github, data.personal.linkedin, ...data.projects.flatMap(p => p.links.map(l => l.url)), ...data.certifications.map(c => c.url)]) {
    if (value && !/^https?:\/\/\S+$/i.test(value)) throw new Error('Links must start with https:// or http://.');
  }
  for (const project of data.projects) if (project.links.some(link => !link.label || !link.url || /[\r\n]/.test(link.label))) throw new Error('Each project link needs a single-line label and URL.');
  if (complete && (!data.personal.title || !data.personal.summary || !data.skills.length || !data.education.length || (!data.projects.length && !data.experience.length))) throw new Error('Add your target title, summary, skills, education, and a project or work experience before exporting.');
  if (complete && (data.skills.some(s => !s.name) || data.education.some(e => !e.degree || !e.institution) || data.projects.some(p => !p.name || !p.description) || data.experience.some(e => !e.position || !e.company || !e.description))) throw new Error('Complete the main fields in each entry or remove the empty entry.');
}
function linkRowSize(doc, links, width) {
  doc.font('Helvetica');
  for (let size = 9; size >= 7; size -= 0.25) {
    doc.fontSize(size);
    const total = links.reduce((sum, link) => sum + doc.widthOfString(link.label), 0) + Math.max(0, links.length - 1) * doc.widthOfString('  -  ');
    if (total <= width) return size;
  }
  throw new Error('Project links cannot fit on one readable line. Shorten the labels or remove a link.');
}
function createResumePDF(data, { photoBuffer } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: data.title, Author: data.personal.name } });
  const width = doc.page.width - 80;
  const baseSize = data.customStyle?.fontSize || (data.template === 'compact' ? 9 : 10);
  const accent = data.customStyle?.accent || (data.template === 'professional' ? '#1d4ed8' : '#111111');
  const sectionGap = data.template === 'compact' ? 0.4 : 0.65;
  data.projects.forEach(project => linkRowSize(doc, project.links, width));
  const ensure = height => { if (doc.y + height > doc.page.height - 40) doc.addPage(); };
  const line = (value, bold = false, size = baseSize, textWidth = width) => {
    if (!value) return;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(bold && size === 11 ? accent : '#111111');
    ensure(Math.min(doc.heightOfString(value, { width: textWidth, lineGap: 2 }), 90));
    doc.text(value, 40, doc.y, { width: textWidth, lineGap: 2 });
  };
  const heading = title => { ensure(65); doc.moveDown(sectionGap); line(title, true, 11); doc.fillColor(accent); doc.moveTo(40, doc.y + 2).lineTo(doc.page.width - 40, doc.y + 2).strokeColor(data.template === 'professional' ? accent : '#8a8a8a').lineWidth(0.5).stroke(); doc.y += 7; };
  const contactLink = (label, url, textWidth) => { if (url) { doc.font('Helvetica').fontSize(9); ensure(doc.heightOfString(`${label}: ${url}`, { width: textWidth })); doc.fillColor('#174ea6').text(`${label}: ${url}`, 40, doc.y, { width: textWidth, link: url, lineGap: 2 }); } };
  const bullets = text => text.split('\n').map(s => s.replace(/^\s*[•●*-]\s*/, '').trim()).filter(Boolean).forEach(s => line(`• ${s}`));
  const linkRow = links => {
    if (!links.length) return;
    const size = linkRowSize(doc, links, width); ensure(18); const y = doc.y; let x = 40;
    doc.font('Helvetica').fontSize(size);
    links.forEach((link, index) => {
      if (index) { doc.fillColor('#444444').text('  -  ', x, y, { lineBreak: false }); x += doc.widthOfString('  -  '); }
      const labelWidth = doc.widthOfString(link.label);
      doc.fillColor('#174ea6').text(link.label, x, y, { lineBreak: false });
      doc.link(x, y, labelWidth, doc.currentLineHeight(), link.url);
      doc.moveTo(x, y + doc.currentLineHeight()).lineTo(x + labelWidth, y + doc.currentLineHeight()).strokeColor('#174ea6').lineWidth(0.4).stroke();
      x += labelWidth;
    });
    doc.x = 40; doc.y = y + doc.currentLineHeight() + 3;
  };
  const headerWidth = photoBuffer ? width - 95 : width;
  if (photoBuffer) doc.image(photoBuffer, doc.page.width - 115, 40, { fit: [75, 90], align: 'center', valign: 'center' });
  doc.x = 40; doc.y = 40;
  line(data.personal.name, true, 20, headerWidth); line(data.personal.title, true, 11, headerWidth); doc.moveDown(0.4);
  line([data.personal.phone, data.personal.email, data.personal.location].filter(Boolean).join(' | '), false, 9, headerWidth);
  contactLink('LinkedIn', data.personal.linkedin, headerWidth); contactLink('Portfolio', data.personal.website, headerWidth); contactLink('GitHub', data.personal.github, headerWidth);
  if (photoBuffer) doc.y = Math.max(doc.y, 130);
  if (data.personal.summary) { heading('Career Objective'); line(data.personal.summary); }
  if (data.skills.length) { heading('Skills'); const groups = new Map(); data.skills.forEach(s => { const key = s.category || 'Core skills'; groups.set(key, [...(groups.get(key) || []), s.name]); }); for (const [category, names] of groups) line(`${category}: ${names.join(', ')}`); }
  if (data.projects.length) { heading('Projects'); data.projects.forEach((p, i) => { ensure(65); line(`${i + 1}. ${p.name}`, true); line(p.description); line(p.role && `Role: ${p.role}`); linkRow(p.links); bullets(p.achievements); line(p.technologies && `Tech Stack: ${p.technologies}`); doc.moveDown(0.4); }); }
  if (data.experience.length) { heading('Experience'); data.experience.forEach(e => { ensure(65); line([e.position, e.company, e.duration].filter(Boolean).join(' | '), true); bullets(e.description); doc.moveDown(0.4); }); }
  if (data.certifications.length) {
    heading('Certifications');
    data.certifications.forEach(c => {
      ensure(35); doc.font('Helvetica').fontSize(10);
      const suffix = [c.issuer, c.date].filter(Boolean).join(' - ');
      doc.fillColor(c.url ? '#174ea6' : '#111111').text(c.name, 40, doc.y, { width, link: c.url || undefined, underline: !!c.url, continued: !!suffix });
      if (suffix) doc.fillColor('#111111').text(` - ${suffix}`, { link: null, underline: false, continued: false });
    });
  }
  if (data.education.length) { heading('Education'); data.education.forEach(e => line([e.degree, e.field, e.institution, e.duration, e.gpa && `GPA: ${e.gpa}`].filter(Boolean).join(' - '))); }
  if (data.languages.length) { heading('Languages'); line(data.languages.map(l => `${l.name}${l.proficiency ? ` (${l.proficiency})` : ''}`).join(', ')); }
  return doc;
}
module.exports = { normalizeResume, validateResume, createResumePDF, projectLinks, linkRowSize };
