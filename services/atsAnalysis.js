const PDFParser = require('pdf2json');
const {
  apiError
} = require('./gemini');
function parseTextPDF(buffer) {
  if (buffer.subarray(0, 5).toString() !== '%PDF-') return Promise.reject(apiError(400, 'The upload is not a valid PDF.'));
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(apiError(400, 'PDF extraction timed out. Try a smaller file.')), 15000);
    parser.once('pdfParser_dataError', () => finish(apiError(400, 'Unable to read PDF. Remove encryption or paste its text.')));
    parser.once('pdfParser_dataReady', data => {
      try {
        const pages = data.Pages.map(page => {
          const sorted = [...page.Texts].sort((a, b) => a.y - b.y || a.x - b.x);
          const rows = [];
          for (const item of sorted) {
            let row = rows[rows.length - 1];
            if (!row || Math.abs(row.y - item.y) > 0.16) {
              row = {
                y: item.y,
                items: []
              };
              rows.push(row);
            }
            row.items.push(item);
          }
          return rows.map(row => row.items.sort((a, b) => a.x - b.x).map(item => item.R.map(run => run.T).join('')).join(' ')).join('\n');
        });
        const text = pages.join('\n\n').trim();
        if (text.length > 60000) throw apiError(400, 'Resume exceeds 60,000 characters. Use a shorter resume.');
        if (text.replace(/\s/g, '').length < 60 || (text.match(/[\p{L}\p{N}]/gu) || []).length / Math.max(1, text.length) < 0.35) throw apiError(422, 'Insufficient readable text. Scanned/image PDFs need OCR first, or paste the verified text. No score was generated.');
        finish(null, {
          text,
          pageCount: data.Pages.length,
          warnings: ['Verify names, dates, symbols and reading order below before scoring. Image text is not extracted; OCR is not included.']
        });
      } catch (error) {
        finish(error.status ? error : apiError(400, 'Unable to decode PDF text.'));
      }
    });
    // pdf2json v4 returns raw text. Copy the bytes: its Buffer path ignores pooled byteOffset.
    try {
      parser.parseBuffer(new Uint8Array(buffer));
    } catch {
      finish(apiError(400, 'Invalid PDF.'));
    }
  });
}
async function extractPDFLinks(buffer) {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString } = require('pdf-lib');
  let pdf;
  try { pdf = await PDFDocument.load(new Uint8Array(buffer), { updateMetadata: false }); }
  catch { throw apiError(400, 'Unable to inspect PDF hyperlinks. Remove encryption or export the PDF again.'); }
  const links = [];
  pdf.getPages().forEach((page, index) => {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) return;
    for (let i = 0; i < annotations.size(); i++) {
      const annotation = pdf.context.lookup(annotations.get(i));
      if (!(annotation instanceof PDFDict)) continue;
      const action = annotation.lookup(PDFName.of('A'));
      if (!(action instanceof PDFDict)) continue;
      const uri = action.lookup(PDFName.of('URI'));
      if (!(uri instanceof PDFString) && !(uri instanceof PDFHexString)) continue;
      const url = uri.decodeText().trim();
      if (!/^(https?:\/\/|mailto:)/i.test(url)) continue;
      try { new URL(url); } catch { continue; }
      if (url.length > 3000) throw apiError(400, 'A PDF hyperlink exceeds the supported URL length.');
      if (!links.some(link => link.page === index + 1 && link.url === url)) links.push({ page: index + 1, url });
      if (links.length > 200) throw apiError(400, 'PDF contains more than 200 hyperlinks. Use a shorter resume.');
    }
  });
  return links;
}
async function parsePDF(buffer) {
  const extracted = await parseTextPDF(buffer);
  const links = await extractPDFLinks(buffer);
  const metadata = links.length ? '\n\n[PDF HYPERLINK TARGETS]\n' + links.map(link => `Page ${link.page}: ${link.url}`).join('\n') : '';
  const text = extracted.text + metadata;
  if (text.length > 60000) throw apiError(400, 'Resume text plus hyperlinks exceeds 60,000 characters.');
  return { ...extracted, text, links, warnings: [...extracted.warnings, `${links.length} unique page/URL hyperlink targets extracted. Linked pages are not visited or verified.`] };
}
const stop = new Set('a an the and or to of in on for from with as at by is are be you your we our us will can must should have has this that these those it its into about all any not years year experience experienced required requirements preferred skills ability strong excellent knowledge work working role job candidate team company responsibilities including using use based looking seeking please position opportunity minimum relevant qualification qualifications such also'.split(' '));
const aliases = {
  'react.js': 'react',
  reactjs: 'react',
  'node.js': 'node',
  nodejs: 'node',
  'next.js': 'next',
  nextjs: 'next',
  'express.js': 'express',
  expressjs: 'express',
  'postgresql': 'postgres',
  'typescript': 'typescript',
  'javascript': 'javascript'
};
function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.+#-][\p{L}\p{N}+#]+)*[+#]*/gu) || []).map(t => aliases[t.replace(/\.$/, '')] || t.replace(/\.$/, ''));
}
function keywordList(description, explicit) {
  if (explicit) return [...new Set(explicit.split(/[,\n]/).map(k => k.trim().toLowerCase()).filter(Boolean))].slice(0, 40);
  const counts = new Map();
  tokens(description).filter(t => t.length >= 3 && !stop.has(t) && !/^\d+$/.test(t)).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([t]) => t);
}
function containsTerm(resumeTokens, term) {
  const words = tokens(term);
  if (!words.length) return false;
  for (let i = 0; i <= resumeTokens.length - words.length; i++) if (words.every((w, j) => resumeTokens[i + j] === w)) return true;
  return false;
}
function analyzeResume(resumeText, jobDescription = '', targetKeywords = '') {
  const visibleText = resumeText.split('\n\n[PDF HYPERLINK TARGETS]\n')[0];
  const lines = visibleText.split(/\n/).map(l => l.trim()).filter(Boolean);
  const wordCount = tokens(visibleText).length;
  if (wordCount < 30) throw apiError(422, 'Too little readable resume text to score. Paste or upload a complete resume.');
  const checks = [];
  const add = (label, max, passed, evidence, advice) => checks.push({
    label,
    max,
    points: passed ? max : 0,
    evidence: evidence || 'No matching text found.',
    advice: passed ? '' : advice
  });
  const match = regex => lines.find(line => regex.test(line));
  const email = resumeText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0];
  const phone = lines.slice(0, 10).join('\n').match(/\+?\d[\d ().-]{6,}\d/)?.[0];
  add('Email', 5, !!email, email, 'Add a readable email address.');
  add('Phone', 5, !!phone && !/^(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}$/.test(phone) && phone.replace(/\D/g, '').length >= 8 && phone.replace(/\D/g, '').length <= 15, phone, 'Add a phone number with country code.');
  const title = match(/(?:developer|engineer|designer|analyst|manager|specialist|teacher|accountant|consultant|officer|assistant|executive|researcher|technician|nurse|writer|marketer|student|graduate)\b/i);
  add('Professional title', 5, !!title, title, 'State your target professional title near your name. This rule recognizes common English titles.');
  const summary = match(/^(?:professional\s+)?(?:summary|profile|career objective|objective)\s*:?$/i);
  add('Summary heading', 5, !!summary, summary, 'Use a standard Summary or Career Objective heading.');
  const skill = match(/^(?:technical\s+|core\s+)?skills\s*:?$/i);
  add('Skills heading', 10, !!skill, skill, 'Include a Skills section with relevant tools and abilities.');
  const education = match(/^education\s*:?$/i);
  add('Education heading', 10, !!education, education, 'Include a standard Education heading.');
  const exp = match(/^(?:(?:professional|work|relevant)\s+)?experience\s*:?$/i);
  const project = match(/^(?:(?:selected|personal|academic)\s+)?projects\s*:?$/i);
  add('Experience or projects heading', 10, !!exp || !!project, exp || project, 'Include Experience or Projects; projects can demonstrate entry-level work.');
  const action = match(/\b(?:built|developed|implemented|created|led|designed|delivered|improved|reduced|increased|managed|launched|optimized|analysed|analyzed|resolved|automated|coordinated|achieved|trained)\b/i);
  add('Action-based accomplishments', 10, !!action, action, 'Describe what you built, improved, or delivered using action verbs.');
  const metric = match(/\b(?:built|developed|implemented|created|led|designed|delivered|improved|reduced|increased|managed|launched|optimized|resolved|automated|achieved|trained)\b.*(?:\d+\s*%|\d+\s*(?:users|clients|customers|projects|hours|days|requests|sales|members|students|employees|records))/i);
  add('Measured impact', 10, !!metric, metric, 'Add a true outcome such as reduced load time by 20% or supported 100 users. Do not invent numbers.');
  const dates = match(/\b(?:19|20)\d{2}\b/);
  add('Dates', 5, !!dates, dates, 'Add dates to education and work/project entries.');
  add('Readable text length', 5, wordCount >= 200 && wordCount <= 1000, `${wordCount} words; suggested range 200–1,000.`, wordCount < 200 ? 'Add relevant project/work details and education.' : 'Trim repetition and focus on relevant achievements.');
  const keywords = keywordList(jobDescription, targetKeywords);
  const found = keywords.filter(k => containsTerm(tokens(resumeText), k));
  const missing = keywords.filter(k => !found.includes(k));
  const hasTarget = keywords.length > 0;
  if (hasTarget) checks.push({
    label: 'Target keyword coverage',
    max: 20,
    points: Math.round(20 * found.length / keywords.length),
    evidence: `${found.length}/${keywords.length} terms: ${found.join(', ') || 'none'}`,
    advice: missing.length ? 'Add missing terms only when supported by your real experience.' : ''
  });
  const max = checks.reduce((sum, c) => sum + c.max, 0);
  const points = checks.reduce((sum, c) => sum + c.points, 0);
  return {
    score: Math.round(points / max * 100),
    rawPoints: points,
    maxPoints: max,
    method: 'transparent-rules-v2',
    assessmentType: hasTarget ? 'Targeted text readiness' : 'General text readiness',
    wordCount,
    checks,
    keywords: {
      found,
      missing
    },
    keywordSource: targetKeywords ? 'User-selected terms' : hasTarget ? 'Frequent non-stopword terms from the job description (heuristic)' : 'No target supplied',
    strengths: checks.filter(c => c.points === c.max).map(c => c.label),
    weaknesses: checks.filter(c => c.points < c.max).map(c => c.label),
    suggestions: checks.filter(c => c.advice).map(c => c.advice),
    limitations: 'This reproducible text-based estimate is not an employer ATS score or a hiring prediction. It checks common English headings and terms, not PDF visual layout. Keyword coverage checks presence, not proficiency or semantic relevance.'
  };
}
module.exports = {
  parsePDF,
  analyzeResume,
  keywordList, extractPDFLinks
};
