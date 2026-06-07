/**
 * parser.mjs — Resume parser using local PDF extraction + Gemini reformatting
 *
 * Workflow:
 *   1. PDF → extract text locally using pdf-parse (free, no API)
 *   2. Extracted text → send to Gemini Flash for cleaning/formatting (minimal tokens)
 *   3. Result cached to data/resume-parsed.txt (Gemini only called once per update)
 *
 * Plain text/markdown files are read directly without Gemini.
 *
 * Usage:
 *   import { parseResume } from './src/ml/parser.mjs';
 *   const resumeText = await parseResume();          // uses cache if available
 *   const resumeText = await parseResume({ force: true }); // re-parse from source
 *
 * Resume source priority:
 *   1. data/resume.pdf  → pdf-parse (local) + Gemini cleanup (minimal API calls)
 *   2. data/resume.txt  → read directly, no API needed
 *   3. data/resume.md   → read directly, no API needed
 *
 * Requires: GEMINI_API_KEY in .env only if using PDF; optional for TXT/MD
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import pdfParse from 'pdf-parse';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from 'dotenv';

config();

const CACHE_PATH  = 'data/resume-parsed.txt';
const RESUME_PDF  = 'data/resume.pdf';
const RESUME_TXT  = 'data/resume.txt';
const RESUME_MD   = 'data/resume.md';

const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_PROMPT = `Clean up and reformat this extracted resume text into well-structured plain text.
Fix any OCR artifacts, preserve all technical keywords and experience details, and organize
sections clearly (skills, experience, education, projects, etc.).
Output should be clean but comprehensive — preserve every detail.`.trim();

/**
 * Parse the resume and return its text content.
 * @param {object} opts
 * @param {boolean} opts.force - Re-parse from source even if cache exists (default: false)
 * @returns {Promise<string>} Plain text resume content
 */
export async function parseResume({ force = false } = {}) {
  // Return cached result unless force re-parse
  if (!force && existsSync(CACHE_PATH)) {
    console.log('  [parser] Using cached resume (data/resume-parsed.txt)');
    console.log('           Run with { force: true } to re-parse from source.');
    return readFileSync(CACHE_PATH, 'utf-8');
  }

  // Plain text / markdown — no Gemini needed
  if (existsSync(RESUME_TXT)) {
    console.log('  [parser] Reading data/resume.txt directly...');
    const text = readFileSync(RESUME_TXT, 'utf-8');
    writeFileSync(CACHE_PATH, text, 'utf-8');
    return text;
  }

  if (existsSync(RESUME_MD)) {
    console.log('  [parser] Reading data/resume.md directly...');
    const text = readFileSync(RESUME_MD, 'utf-8');
    writeFileSync(CACHE_PATH, text, 'utf-8');
    return text;
  }

  // PDF → extract locally, then send text to Gemini for cleanup
  if (existsSync(RESUME_PDF)) {
    console.log('  [parser] Extracting text from PDF locally...');
    const buffer      = readFileSync(RESUME_PDF);
    const extractedText = await extractPDFText(buffer);

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('PDF extraction returned empty text — is the PDF valid and text-based?');
    }

    console.log(`  [parser] Sending extracted text to ${GEMINI_MODEL} for cleanup...`);
    const cleanedText = await callGeminiOnText(extractedText);
    writeFileSync(CACHE_PATH, cleanedText, 'utf-8');
    console.log('  [parser] Cleaned and cached to data/resume-parsed.txt');
    return cleanedText;
  }

  throw new Error(
    'No resume found. Add one of:\n' +
    '  data/resume.pdf   ← extracted locally, cleaned by Gemini\n' +
    '  data/resume.txt   ← read directly, no API needed\n' +
    '  data/resume.md    ← read directly, no API needed'
  );
}

// ── Internal ────────────────────────────────────────────────────────────────

async function extractPDFText(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    return data.text || '';
  } catch (e) {
    throw new Error(`PDF extraction failed: ${e.message}`);
  }
}

async function callGeminiOnText(text) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set in .env — required to format extracted resume.\n' +
      'Get a free key at https://aistudio.google.com/apikey\n' +
      'Alternative: use data/resume.txt instead of .pdf to skip this step.'
    );
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: GEMINI_MODEL });

  const result = await model.generateContent([text, GEMINI_PROMPT]);

  const cleaned = result.response.text();
  if (!cleaned || cleaned.trim().length === 0) {
    throw new Error('Gemini returned empty output');
  }
  return cleaned.trim();
}
