/**
 * scorer.mjs — interpretable feature-model job scoring.
 *
 * Uses @xenova/transformers (all-MiniLM-L6-v2, ~25MB, runs locally, zero API cost)
 * for the embedding-based features, then scores every job with a logistic
 * regression over 9 NAMED features (src/ml/features.mjs):
 *
 *   score = sigmoid(bias + Σ weightᵢ·featureᵢ)
 *
 * Weights come from data/model.json (trained on apply/ignore labels via
 * src/train.mjs) when present, otherwise from the hand-tuned prior
 * (DEFAULT_MODEL). Either way each job carries a full decomposition
 * (.features + .explanation) — no opaque blending.
 *
 * The embedding model is loaded once per process and cached — subsequent calls
 * reuse it. Rubric embeddings and the training-label context are computed once
 * per scoring session.
 *
 * Exports:
 *   embed(text)                     → number[] (384-dim vector)
 *   scoreMatch(resumeText, jobText) → number  (0–1 cosine, kept for ad-hoc use)
 *   scoreJobs(jobs)                 → jobs[] sorted by score desc, each with
 *                                     .score / .features / .explanation / .rubricInfo
 *   buildJobText(job)               → string  (the text embedded for a job)
 *
 * Job text fallback (when no description available):
 *   "${role} at ${company} in ${location}" — less rich but consistent across all ATS
 *   Ashby jobs always have descriptions inline, so fallback is rare when using Ashby.
 */

import { pipeline } from '@xenova/transformers';
import { loadModel } from './model.mjs';
import { loadRubric, embedRubric } from './rubric.mjs';
import { loadTrainingData } from './training-data.mjs';
import { DEFAULT_MODEL, buildFeatureContext, extractFeatures, explainScore } from './features.mjs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Singleton — loaded once, reused for all embed() calls in the same process
let _embedder = null;

function getEmbedder() {
  if (!_embedder) {
    console.log(`  [scorer] Loading ${MODEL} (first run downloads ~25MB, cached after)...`);
    // Cache the PROMISE (not the resolved pipeline) so concurrent embed() calls
    // don't each load the model.
    _embedder = pipeline('feature-extraction', MODEL)
      .then(p => { console.log('  [scorer] Model ready.'); return p; });
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
 * Score an array of jobs with the named-feature model and return them sorted
 * best-first.
 *
 * Each job should be a plain object with at minimum:
 *   { company, role, location, description? }
 *
 * Jobs with a `description` field (Ashby) get richer embeddings.
 * Jobs without one fall back to "role at company in location".
 *
 * @param {object[]} jobs
 * @returns {Promise<object[]>} Same jobs sorted desc, each with:
 *   .score       sigmoid probability (0–1)
 *   .features    { domain_match, ..., title_match } named feature values
 *   .explanation { z, prob, contributions[] } — per-feature weight×value breakdown
 *   .rubricInfo  { topDomain, antiHit, yoeCapped } (only when rubric.yml exists)
 */
export async function scoreJobs(jobs) {
  if (jobs.length === 0) return [];

  // Model: trained feature weights when available, hand-tuned prior otherwise.
  const model = loadModel() ?? DEFAULT_MODEL;
  console.log(model.meta?.source === 'prior' || !model.meta?.nPos
    ? '  [scorer] Feature model: prior weights (cold start — no trained model yet)'
    : `  [scorer] Feature model: trained on ${model.meta.nPos} applied / ${model.meta.nNeg} ignored labels`);

  // Rubric features need the embedded rubric; without rubric.yml they're all 0.
  const rubric = loadRubric();
  let embeddedRubric = null;
  if (rubric) {
    embeddedRubric = await embedRubric(rubric);
    console.log(`  [scorer] Rubric loaded (${embeddedRubric.domains.length} domains, ${embeddedRubric.antis.length} anti-preferences)`);
  }

  // Label-derived context (company_prior, history_similarity) from stored labels.
  const ctx = buildFeatureContext({ embeddedRubric, trainingStore: loadTrainingData() });
  console.log(`  [scorer] Feature context: ${ctx.applied.length} applied / ${ctx.nLabeled} labeled jobs in history`);

  console.log(`  [scorer] Scoring ${jobs.length} job(s)...`);
  // Title vectors for title_match — cached by role string, since many postings
  // share the same title.
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
      const roleVec = await getRoleVec(job.role || '');

      const { features, info } = extractFeatures(ctx, {
        jobVec, roleVec, jobText,
        jobRole: job.role || '',
        company: job.company || '',
      });
      const explanation = explainScore(model, features);

      const out = { ...job, score: explanation.prob, features, explanation };
      if (embeddedRubric) out.rubricInfo = info;
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
