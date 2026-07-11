/**
 * scorer.mjs — Resume–job match scoring via sentence embeddings
 *
 * Uses @xenova/transformers (all-MiniLM-L6-v2, ~25MB, runs locally, zero API cost)
 * to embed resume text and job descriptions, then ranks jobs by cosine similarity.
 *
 * The embedding model is loaded once per process and cached — subsequent calls reuse it.
 * The resume vector is computed once per scoring session and reused across all jobs.
 *
 * Exports:
 *   embed(text)                        → Float32Array (384-dim vector)
 *   scoreMatch(resumeText, jobText)    → number  (0–1, higher = better match)
 *   scoreJobs(resumeText, jobs)        → jobs[] sorted by score desc, each with .score
 *   buildJobText(job)                  → string  (the text embedded for a job)
 *
 * When a trained model exists (data/model.json, built from apply/ignore feedback via
 * src/train.mjs), scoreJobs blends it with cosine: score = (1−α)·cosine + α·modelProb,
 * α = min(0.7, nLabels/200). Cosine keeps ≥30% weight as an anchor; with no model the
 * behavior is pure cosine, exactly as before.
 *
 * Job text fallback (when no description available):
 *   "${role} at ${company} in ${location}" — less rich but consistent across all ATS
 *   Ashby jobs always have descriptions inline, so fallback is rare when using Ashby.
 */

import { pipeline } from '@xenova/transformers';
import { loadModel, predictLogistic } from './model.mjs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Singleton — loaded once, reused for all embed() calls in the same process
let _embedder = null;

async function getEmbedder() {
  if (!_embedder) {
    console.log(`  [scorer] Loading ${MODEL} (first run downloads ~25MB, cached after)...`);
    _embedder = await pipeline('feature-extraction', MODEL);
    console.log('  [scorer] Model ready.');
  }
  return _embedder;
}

// ── Core math ────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a text string into a 384-dimensional vector.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const embedder = await getEmbedder();
  const output   = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Compute cosine similarity between a resume and a single job text.
 * @param {string} resumeText
 * @param {string} jobText
 * @returns {Promise<number>} Score between 0 and 1
 */
export async function scoreMatch(resumeText, jobText) {
  const [rVec, jVec] = await Promise.all([embed(resumeText), embed(jobText)]);
  return parseFloat(cosineSimilarity(rVec, jVec).toFixed(4));
}

/**
 * Score an array of jobs against a resume and return them sorted best-first.
 *
 * Each job should be a plain object with at minimum:
 *   { company, role, location, description? }
 *
 * Jobs with a `description` field (Ashby) get richer embeddings.
 * Jobs without one fall back to "role at company in location".
 *
 * @param {string}   resumeText
 * @param {object[]} jobs
 * @returns {Promise<object[]>} Same jobs with `.score` added, sorted desc
 */
export async function scoreJobs(resumeText, jobs) {
  if (jobs.length === 0) return [];

  // Embed resume once, reuse across all jobs
  console.log(`  [scorer] Embedding resume...`);
  const resumeVec = await embed(resumeText);

  // Feedback model trained on apply/ignore decisions (null until enough labels exist)
  const model  = loadModel();
  const nLabels = model ? model.meta.nPos + model.meta.nNeg : 0;
  const alpha   = model ? Math.min(0.7, nLabels / 200) : 0;
  if (model) {
    console.log(`  [scorer] Blending feedback model (${model.meta.nPos} pos / ${model.meta.nNeg} neg, α=${alpha.toFixed(2)})`);
  }

  console.log(`  [scorer] Scoring ${jobs.length} job(s)...`);
  const scored = await Promise.all(
    jobs.map(async job => {
      const jobText = buildJobText(job);
      const jobVec  = await embed(jobText);
      const cosine  = parseFloat(cosineSimilarity(resumeVec, jobVec).toFixed(4));
      const dimOk = model && model.weights.length === jobVec.length;
      const modelProb = dimOk ? parseFloat(predictLogistic(model, jobVec).toFixed(4)) : null;
      const score = modelProb == null
        ? cosine
        : parseFloat(((1 - alpha) * cosine + alpha * modelProb).toFixed(4));
      return { ...job, score, cosine, modelProb };
    })
  );

  // Sort best match first
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Build the text to embed for a job.
 * Prefer full description (Ashby always has this); fall back to structured fields.
 * Exported so apply.mjs/train.mjs snapshot training text with the exact same formula.
 */
export function buildJobText(job) {
  if (job.description && job.description.trim().length > 50) {
    // Prefix with role/company so the title context is never lost
    return `${job.role} at ${job.company}\n\n${job.description}`;
  }
  return `${job.role} at ${job.company} in ${job.location || 'Unknown location'}`;
}
