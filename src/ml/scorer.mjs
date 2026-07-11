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
 * src/train.mjs), scoreJobs blends it with the anchor: score = (1−α)·anchor + α·modelProb,
 * α = min(0.7, nLabels/200). The anchor keeps ≥30% weight; with no model the behavior is
 * pure anchor, exactly as before.
 *
 * The anchor is the resume↔job cosine by default. When rubric.yml exists (see
 * src/ml/rubric.mjs), scoreJobs switches to "rubric mode": the rubric score replaces the
 * resume cosine as the anchor, so ranking reflects what the user WANTS, not just what the
 * resume resembles. The feedback-model blend is identical either way, and `.cosine` is
 * always populated with the resume cosine for comparison.
 *
 * Job text fallback (when no description available):
 *   "${role} at ${company} in ${location}" — less rich but consistent across all ATS
 *   Ashby jobs always have descriptions inline, so fallback is rare when using Ashby.
 */

import { pipeline } from '@xenova/transformers';
import { loadModel, predictLogistic } from './model.mjs';
import { loadRubric, embedRubric, rubricScore } from './rubric.mjs';

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

  // Rubric mode: when rubric.yml exists, its score replaces the resume cosine as the
  // blend anchor. Embed the rubric's domain/anti descriptions once, reuse across all jobs.
  const rubric = loadRubric();
  let embeddedRubric = null;
  if (rubric) {
    embeddedRubric = await embedRubric(rubric);
    console.log(`  [scorer] Rubric mode (${embeddedRubric.domains.length} domains, ${embeddedRubric.antis.length} anti-preferences)`);
  }

  console.log(`  [scorer] Scoring ${jobs.length} job(s)...`);
  // Title vectors for the rubric's title blend — cached by role string, since
  // many postings share the same title.
  const roleVecCache = new Map();
  const getRoleVec = async role => {
    if (!role) return undefined;
    if (!roleVecCache.has(role)) roleVecCache.set(role, await embed(role));
    return roleVecCache.get(role);
  };
  const scored = await Promise.all(
    jobs.map(async job => {
      const jobText = buildJobText(job);
      const jobVec  = await embed(jobText);
      const cosine  = parseFloat(cosineSimilarity(resumeVec, jobVec).toFixed(4));

      // Anchor = rubric score (rubric mode) or resume cosine (default).
      let anchor = cosine;
      let rubricInfo = null;
      if (embeddedRubric) {
        const roleVec = await getRoleVec(job.role || '');
        const r = rubricScore(embeddedRubric, jobVec, jobText, job.role || '', roleVec);
        anchor = parseFloat(r.score.toFixed(4));
        rubricInfo = { topDomain: r.topDomain, antiHit: r.antiHit, yoeCapped: r.yoeCapped };
      }

      const dimOk = model && model.weights.length === jobVec.length;
      const modelProb = dimOk ? parseFloat(predictLogistic(model, jobVec).toFixed(4)) : null;
      const score = modelProb == null
        ? anchor
        : parseFloat(((1 - alpha) * anchor + alpha * modelProb).toFixed(4));
      const out = { ...job, score, cosine, modelProb };
      if (rubricInfo) out.rubricInfo = rubricInfo;
      return out;
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
