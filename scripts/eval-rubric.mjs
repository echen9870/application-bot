#!/usr/bin/env node
/**
 * eval-rubric.mjs — does the rubric rank your real applies better than the resume?
 *
 * Before you trust rubric.yml, this harness answers that question offline, with no
 * Sheets access. It replays your stored training labels (data/training-data.json):
 * each description-bearing entry is a job you actually applied to (label 1) or
 * ignored (label 0), and it already carries the job's MiniLM embedding.
 *
 * For every labeled job it computes two anchor scores:
 *   (a) resume score — cosine(resume, job) using the cached resume embedding.
 *   (b) rubric score — rubricScore() against the embedded rubric.yml.
 * It then ranks all jobs by each score and reports, for the positives (your
 * applies), precision@25, precision@50, and mean rank (lower = the applies float
 * to the top). A rubric that beats the resume moves your applies up the ranking.
 *
 * Only the anchor is compared here — the feedback model is deliberately excluded so
 * the two anchors are measured head-to-head. Descriptions matter: entries whose
 * text lacks a real body (no '\n\n') are skipped, matching train.mjs.
 *
 * Usage:  node scripts/eval-rubric.mjs
 */

import { loadTrainingData } from '../src/ml/training-data.mjs';
import { loadRubric, embedRubric, rubricScore } from '../src/ml/rubric.mjs';
import { embed } from '../src/ml/scorer.mjs';
import { parseResume } from '../src/ml/parser.mjs';

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
  const entries = Object.values(store).filter(e => e.text && e.text.includes('\n\n') && Array.isArray(e.embedding));
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

  // Score every job with each anchor, reusing the job's stored embedding.
  const rows = entries.map(e => {
    const jobVec = e.embedding;
    const role   = e.role || '';
    return {
      label:  e.label,
      resume: cosine(resumeVec, jobVec),
      rubric: rubricScore(embeddedRubric, jobVec, e.text, role, roleVecCache.get(role)).score,
    };
  });

  const byResume = [...rows].sort((a, b) => b.resume - a.resume);
  const byRubric = [...rows].sort((a, b) => b.rubric - a.rubric);

  const stats = ranked => ({
    p25:  precisionAtK(ranked, 25),
    p50:  precisionAtK(ranked, 50),
    mean: meanPositiveRank(ranked),
  });
  const r = stats(byResume), u = stats(byRubric);

  const pct  = v => `${(v * 100).toFixed(1)}%`.padStart(8);
  const rank = v => v.toFixed(1).padStart(8);
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  Metric              Resume    Rubric`);
  console.log('─'.repeat(48));
  console.log(`  precision@25      ${pct(r.p25)}  ${pct(u.p25)}`);
  console.log(`  precision@50      ${pct(r.p50)}  ${pct(u.p50)}`);
  console.log(`  mean positive rank${rank(r.mean)}  ${rank(u.mean)}   (lower is better)`);
  console.log('─'.repeat(48));

  const better = u.mean < r.mean;
  console.log(`\nVerdict: rubric ${better ? 'BEATS' : 'does NOT beat'} the resume ranking ` +
    `(mean positive rank ${u.mean.toFixed(1)} vs ${r.mean.toFixed(1)}).`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
