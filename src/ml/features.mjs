/**
 * features.mjs — named, interpretable features for the job-scoring model.
 *
 * Every Match Score decomposes as sigmoid(bias + Σ weightᵢ·featureᵢ) over the
 * 9 features below, so any score can be explained feature-by-feature (see
 * explainScore). DEFAULT_MODEL holds hand-tuned prior weights used both as the
 * cold-start scorer (before enough apply/ignore labels exist) and as the
 * initialization for training (src/train.mjs), which then refines them.
 *
 * Features (all roughly in [-1, 1] except yoe_gap in [0, 5]):
 *   domain_match       max weighted rubric-domain cosine (what you WANT)
 *   skill_overlap      fraction of preferred_skills found in the JD
 *   language_overlap   fraction of programming_languages found in the JD
 *   penalty_overlap    fraction of penalty_keywords found in the JD (bad)
 *   anti_margin        best anti cosine − best raw domain cosine (negative = good)
 *   yoe_gap            max(0, demanded YOE − rubric yoe.max), clamped at 5 — penalty
 *                      only; under-max and unknown both 0 (see extractFeatures)
 *   company_prior      smoothed past apply rate at this company
 *   history_similarity mean cosine to the 3 nearest jobs you APPLIED to
 *   title_match        max cosine of job title vs preferred_titles
 *
 * Rubric-derived features are 0 when no rubric.yml exists; company_prior and
 * history_similarity come from data/training-data.json and work regardless.
 *
 * Leakage guard: at training time pass excludeLink so an example's own label
 * can't feed its company_prior or history_similarity (leave-one-out).
 */

import { rubricSignals } from './rubric.mjs';

export const FEATURE_NAMES = [
  'domain_match',
  'skill_overlap',
  'language_overlap',
  'penalty_overlap',
  'anti_margin',
  'yoe_gap',
  'company_prior',
  'history_similarity',
  'title_match',
];

// Hand-tuned prior weights (Eric, 2026-07-14). Order matches FEATURE_NAMES.
export const DEFAULT_MODEL = {
  weights: [
    1.4,   // domain_match
    0.9,   // skill_overlap
    0.6,   // language_overlap
    -1.2,  // penalty_overlap
    -0.8,  // anti_margin
    -0.5,  // yoe_gap
    0.7,   // company_prior
    1.5,   // history_similarity
    0.9,   // title_match
  ],
  bias: -0.5,
  meta: { source: 'prior', features: FEATURE_NAMES },
};

const YOE_GAP_CLAMP = 5;       // |yoe_gap| cap — YOE parsers misfire; don't let one dominate z
const COMPANY_PRIOR_K = 3;     // shrinkage strength toward the global apply rate
const HISTORY_TOP_K = 3;       // nearest applied jobs averaged for history_similarity

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Precompute the label-derived state shared by every extractFeatures call:
 * applied-job embeddings (for history_similarity) and per-company label counts
 * (for company_prior). Pure and synchronous given its inputs.
 *
 * @param {object} opts
 * @param {object|null} opts.embeddedRubric  from embedRubric(), or null (no rubric.yml)
 * @param {object}      opts.trainingStore   from loadTrainingData() — { [link]: entry }
 */
export function buildFeatureContext({ embeddedRubric = null, trainingStore = {} } = {}) {
  const applied = [];
  const companyStats = new Map();   // lowercased company → { nApplied, nTotal }
  let nApplied = 0, nTotal = 0;

  for (const [link, e] of Object.entries(trainingStore)) {
    if (e?.label !== 0 && e?.label !== 1) continue;
    nTotal++;
    if (e.label === 1) nApplied++;

    const key = (e.company || '').toLowerCase().trim();
    if (key) {
      const c = companyStats.get(key) || { nApplied: 0, nTotal: 0 };
      c.nTotal++;
      if (e.label === 1) c.nApplied++;
      companyStats.set(key, c);
    }

    if (e.label === 1 && Array.isArray(e.embedding)) {
      applied.push({ link, company: key, vec: e.embedding });
    }
  }

  return {
    rubric: embeddedRubric,
    applied,
    companyStats,
    globalRate: nTotal === 0 ? 0 : nApplied / nTotal,
    nLabeled: nTotal,
  };
}

/**
 * Compute the 9 named features for one job.
 *
 * @param {object} ctx  from buildFeatureContext()
 * @param {object} job
 * @param {number[]} job.jobVec       embedded job text (buildJobText formula)
 * @param {number[]} [job.roleVec]    embedded job title (enables title_match)
 * @param {string}   job.jobText      raw job text (keyword + YOE features)
 * @param {string}   [job.jobRole]    job title (YOE-from-title)
 * @param {string}   [job.company]
 * @param {string}   [job.excludeLink]  training-time leave-one-out: this link's own
 *                                      label is excluded from company_prior and
 *                                      history_similarity
 * @returns {{ features: Object<string, number>,
 *             info: { topDomain: string|null, antiHit: string|null, yoeCapped: boolean } }}
 */
export function extractFeatures(ctx, { jobVec, roleVec, jobText, jobRole = '', company = '', excludeLink }) {
  // Rubric-derived signals (all 0 without a rubric)
  let s = {
    domainMatch: 0, topDomain: null, bestRawDomain: 0, bestAnti: 0, antiName: null,
    skillFrac: 0, langFrac: 0, penaltyFrac: 0, titleMatch: 0, yoeGap: null,
  };
  if (ctx.rubric) s = rubricSignals(ctx.rubric, jobVec, jobText, jobRole, roleVec);

  // company_prior — apply rate at this company, shrunk toward the global rate so
  // one lonely label doesn't swing it to 0 or 1.
  const key = (company || '').toLowerCase().trim();
  let { nApplied = 0, nTotal = 0 } = (key && ctx.companyStats.get(key)) || {};
  // Leave-one-out: subtract this job's own label from its company counts. Callers
  // must build ctx from the same store excludeLink came from (train.mjs does).
  if (excludeLink && key && nTotal > 0) {
    nTotal -= 1;
    if (ctx.applied.some(a => a.link === excludeLink && a.company === key)) nApplied -= 1;
  }
  const companyPrior = (nApplied + COMPANY_PRIOR_K * ctx.globalRate) / (nTotal + COMPANY_PRIOR_K);

  // history_similarity — mean cosine to the top-k nearest applied jobs. Top-k
  // (not centroid) so distinct clusters of past applications each stay sharp.
  const sims = [];
  for (const a of ctx.applied) {
    if (excludeLink && a.link === excludeLink) continue;
    sims.push(cosine(jobVec, a.vec));
  }
  sims.sort((x, y) => y - x);
  const topK = sims.slice(0, HISTORY_TOP_K);
  const historySimilarity = topK.length === 0 ? 0 : topK.reduce((t, v) => t + v, 0) / topK.length;

  // Only the EXCESS matters (demanded > max). A negative gap must not be a bonus:
  // most entry-level titles ("Software Engineer I") have no parseable YOE, and
  // rewarding detected-low-YOE jobs would rank them ~1.5 z above equally junior
  // unparseable ones (measured on stored labels, 2026-07-14 — sank 14 real
  // applies below rank 100). Unknown and at-or-under-max both → 0.
  const yoeGap = s.yoeGap == null ? 0
    : Math.min(YOE_GAP_CLAMP, Math.max(0, s.yoeGap));

  const round = v => parseFloat(v.toFixed(4));
  return {
    features: {
      domain_match:       round(s.domainMatch),
      skill_overlap:      round(s.skillFrac),
      language_overlap:   round(s.langFrac),
      penalty_overlap:    round(s.penaltyFrac),
      anti_margin:        round(s.bestAnti - s.bestRawDomain),
      yoe_gap:            round(yoeGap),
      company_prior:      round(companyPrior),
      history_similarity: round(historySimilarity),
      title_match:        round(s.titleMatch),
    },
    info: {
      topDomain: s.topDomain,
      antiHit:   s.antiName && s.bestAnti > s.bestRawDomain ? s.antiName : null,
      yoeCapped: s.yoeGap != null && s.yoeGap > 0,
    },
  };
}

/** Feature object → ordered vector matching FEATURE_NAMES (and model weights). */
export function featuresToVector(features) {
  return FEATURE_NAMES.map(n => features[n] ?? 0);
}

/**
 * Score + full decomposition: z = bias + Σ weightᵢ·featureᵢ, prob = sigmoid(z).
 * Contributions are sorted by |contribution| descending, so the first entries
 * answer "why did this job score what it did?".
 *
 * @param {{ weights: number[], bias: number }} model  trained or DEFAULT_MODEL
 * @param {Object<string, number>} features            from extractFeatures().features
 * @returns {{ z: number, prob: number, contributions: {name, value, weight, contribution}[] }}
 */
export function explainScore(model, features) {
  let z = model.bias;
  const contributions = FEATURE_NAMES.map((name, i) => {
    const value = features[name] ?? 0;
    const weight = model.weights[i];
    const contribution = parseFloat((weight * value).toFixed(4));
    z += weight * value;
    return { name, value, weight, contribution };
  });
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  z = parseFloat(z.toFixed(4));
  return { z, prob: parseFloat(sigmoid(z).toFixed(4)), contributions };
}
