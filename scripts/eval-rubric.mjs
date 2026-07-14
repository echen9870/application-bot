#!/usr/bin/env node
/**
 * eval-rubric.mjs — which scorer ranks your real applies best?
 *
 * Before you trust a scoring change, this harness answers that question offline,
 * with no Sheets access. It replays your stored training labels
 * (data/training-data.json): each description-bearing entry is a job you actually
 * applied to (label 1) or ignored (label 0), and it already carries the job's
 * MiniLM embedding.
 *
 * For every labeled job it computes four scores:
 *   (a) resume        — cosine(resume, job) using the cached resume embedding.
 *   (b) rubric        — legacy rubricScore() anchor against the embedded rubric.yml.
 *   (c) feat-prior    — the 9-named-feature model with the hand-tuned prior weights
 *                       (DEFAULT_MODEL). Fully out-of-sample: the weights never saw
 *                       these labels.
 *   (d) feat-trained  — the same features scored with data/model.json's trained
 *                       weights. Mildly IN-SAMPLE (those weights were fit on these
 *                       very labels), so read it as an upper bound, not truth.
 * Features (c)/(d) use leave-one-out: each entry's own label is excluded from its
 * company_prior and history_similarity, matching how train.mjs builds features.
 *
 * It then ranks all jobs by each score and reports, for the positives (your
 * applies), precision@25, precision@50, and mean rank (lower = the applies float
 * to the top). Descriptions matter: entries whose text lacks a real body (no
 * '\n\n') are skipped, matching train.mjs.
 *
 * Usage:  node scripts/eval-rubric.mjs
 */

import { loadTrainingData } from '../src/ml/training-data.mjs';
import { loadRubric, embedRubric, rubricScore } from '../src/ml/rubric.mjs';
import { embed } from '../src/ml/scorer.mjs';
import { parseResume } from '../src/ml/parser.mjs';
import { loadModel } from '../src/ml/model.mjs';
import { DEFAULT_MODEL, buildFeatureContext, extractFeatures, explainScore } from '../src/ml/features.mjs';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// precision@k = fraction of the top-k ranked jobs that are positives.
function precisionAtK(ranked, k) {
  const top = ranked.slice(0, k);
  const pos = top.filter(r => r.label === 1).length;
  return top.length === 0 ? 0 : pos / top.length;
}

// mean 1-based rank of the positives after sorting by score desc (lower = better).
function meanPositiveRank(ranked) {
  const ranks = [];
  ranked.forEach((r, i) => { if (r.label === 1) ranks.push(i + 1); });
  return ranks.length === 0 ? NaN : ranks.reduce((s, r) => s + r, 0) / ranks.length;
}

async function main() {
  const rubric = loadRubric();
  if (!rubric) { console.error('No rubric.yml found — nothing to evaluate.'); process.exit(1); }

  const store = loadTrainingData();
  const entries = Object.entries(store)
    .filter(([, e]) => e.text && e.text.includes('\n\n') && Array.isArray(e.embedding))
    .map(([link, e]) => ({ link, ...e }));
  if (entries.length === 0) { console.error('No description-bearing training entries — nothing to evaluate.'); process.exit(1); }

  const nPos = entries.filter(e => e.label === 1).length;
  const nNeg = entries.length - nPos;
  console.log(`Evaluating ${entries.length} labeled jobs (${nPos} applied / ${nNeg} ignored).\n`);

  console.log('Embedding resume + rubric...');
  const resumeVec      = await embed(await parseResume());
  const embeddedRubric = await embedRubric(rubric);

  // Embed each distinct job title once for the rubric's title blend (jobs
  // arrive as stored body vectors; the title vector is computed here).
  const roleVecCache = new Map();
  for (const e of entries) {
    const role = e.role || '';
    if (role && !roleVecCache.has(role)) roleVecCache.set(role, await embed(role));
  }

  // Feature-model scorers: context over the FULL store; extractFeatures excludes
  // each entry's own label via excludeLink (leave-one-out, same as training).
  const ctx = buildFeatureContext({ embeddedRubric, trainingStore: store });
  const trainedModel = loadModel();   // null if no (feature-versioned) model.json
  if (!trainedModel) console.log('No trained feature model (data/model.json) — feat-trained column skipped.');

  // Score every job with each scorer, reusing the job's stored embedding.
  const rows = entries.map(e => {
    const jobVec = e.embedding;
    const role   = e.role || '';
    const { features } = extractFeatures(ctx, {
      jobVec, roleVec: roleVecCache.get(role), jobText: e.text,
      jobRole: role, company: e.company || '', excludeLink: e.link,
    });
    return {
      label:   e.label,
      resume:  cosine(resumeVec, jobVec),
      rubric:  rubricScore(embeddedRubric, jobVec, e.text, role, roleVecCache.get(role)).score,
      prior:   explainScore(DEFAULT_MODEL, features).prob,
      trained: trainedModel ? explainScore(trainedModel, features).prob : null,
    };
  });

  const stats = key => {
    const ranked = [...rows].sort((a, b) => b[key] - a[key]);
    return { p25: precisionAtK(ranked, 25), p50: precisionAtK(ranked, 50), mean: meanPositiveRank(ranked) };
  };
  const cols = [
    ['Resume',        stats('resume')],
    ['Rubric',        stats('rubric')],
    ['Feat(prior)',   stats('prior')],
    ...(trainedModel ? [['Feat(trained)*', stats('trained')]] : []),
  ];

  const pct  = v => `${(v * 100).toFixed(1)}%`.padStart(14);
  const rank = v => v.toFixed(1).padStart(14);
  const width = 22 + cols.length * 14;
  console.log(`\n${'─'.repeat(width)}`);
  console.log(`  Metric            ${cols.map(([name]) => name.padStart(14)).join('')}`);
  console.log('─'.repeat(width));
  console.log(`  precision@25      ${cols.map(([, s]) => pct(s.p25)).join('')}`);
  console.log(`  precision@50      ${cols.map(([, s]) => pct(s.p50)).join('')}`);
  console.log(`  mean positive rank${cols.map(([, s]) => rank(s.mean)).join('')}   (lower is better)`);
  console.log('─'.repeat(width));
  if (trainedModel) console.log('  * feat-trained weights were fit on these same labels — read as an upper bound.');

  const rubricMean = stats('rubric').mean;
  const priorMean  = stats('prior').mean;
  console.log(`\nVerdict: feature model (prior) ${priorMean <= rubricMean ? 'BEATS' : 'does NOT beat'} the rubric anchor ` +
    `(mean positive rank ${priorMean.toFixed(1)} vs ${rubricMean.toFixed(1)}).`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
