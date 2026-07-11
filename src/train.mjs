#!/usr/bin/env node
/**
 * train.mjs — retrain the feedback scoring model from labeled apply/ignore decisions.
 *
 * Labels are recorded by apply.mjs (Applied = 1, Ignored = 0) into
 * data/training-data.json with the job's embedding snapshotted at label time, so a
 * plain retrain needs no Sheets access and no re-embedding.
 *
 * Usage:
 *   node src/train.mjs              # retrain from data/training-data.json
 *   node src/train.mjs --bootstrap  # seed labels from the historical Applied/Ignored
 *                                   # sheets (joins descriptions from the cache), then train
 *
 * Guard: training is skipped (existing model kept) until there are at least
 * MIN_PER_CLASS examples of each class — a model fit on a handful of rows would be noise.
 */

import { fileURLToPath } from 'url';
import { trainLogistic, evaluateHoldout, saveModel } from './ml/model.mjs';
import { loadTrainingData, saveTrainingData } from './ml/training-data.mjs';

const MIN_PER_CLASS = 10;

/**
 * Retrain from the stored labels. Safe to call from apply.mjs — never throws for
 * "not enough data" (returns a status object instead).
 * @returns {{ trained: boolean, nPos: number, nNeg: number, accuracy?: number }}
 */
export async function retrain() {
  const store = loadTrainingData();
  // Train ONLY on entries with a real job description (buildJobText inserts "\n\n"
  // exclusively in the description path). Title-only entries embed near-identical
  // vectors for wildly different jobs ("Software Engineer at X in NYC") and teach
  // the model title phrasing rather than actual preferences.
  const entries = Object.values(store).filter(e => Array.isArray(e.embedding) && e.text?.includes('\n\n'));
  const nPos = entries.filter(e => e.label === 1).length;
  const nNeg = entries.length - nPos;

  if (nPos < MIN_PER_CLASS || nNeg < MIN_PER_CLASS) {
    console.log(`  [train] Not enough description-bearing labels yet (${nPos} applied / ${nNeg} ignored; need ${MIN_PER_CLASS} of each). Keeping existing model.`);
    return { trained: false, nPos, nNeg };
  }

  const X = entries.map(e => e.embedding);
  const y = entries.map(e => e.label);

  // Honest skill estimate first (throwaway model on 80%, scored on unseen 20%) —
  // training accuracy is meaningless at ~4% positive rate.
  const ho = evaluateHoldout(X, y);

  // Final model trains on ALL labels — the holdout was only for measurement.
  const model = trainLogistic(X, y);
  saveModel(model);

  console.log(`  [train] Model trained on ${nPos} applied / ${nNeg} ignored → data/model.json`);
  if (ho) {
    console.log(`  [train] Holdout (${ho.nTestPos} applied / ${ho.nTestNeg} ignored unseen): ` +
      `precision ${(ho.precision * 100).toFixed(0)}% (when it says "apply", how often you did), ` +
      `recall ${(ho.recall * 100).toFixed(0)}% (of jobs you applied to, how many it flagged)`);
  }
  return { trained: true, nPos, nNeg, holdout: ho };
}

/**
 * Seed training data from the historical Applied/Ignored sheets. Descriptions are
 * joined from the cache where available; jobs without one fall back to title-only
 * text, same formula as scoring.
 */
async function bootstrap() {
  const { createSheetsClient, SPREADSHEET_ID } = await import('./sheets-client.mjs');
  const { loadDescriptions } = await import('./ml/descriptions.mjs');
  const { embed, buildJobText } = await import('./ml/scorer.mjs');

  const sheets = createSheetsClient();
  const read = async range =>
    (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range })).data.values || [];

  // Applied: B=company, C=role, D=location, E=link · Ignored: B=company, C=role, D=location, E=link
  const [appliedRows, ignoredRows] = await Promise.all([read('Applied!A2:E'), read('Ignored!A2:E')]);

  const store = loadTrainingData();
  const toRow = (r, label) => ({ label, company: r[1] || '', role: r[2] || '', location: r[3] || '', link: r[4] || '' });
  // Ignored first: for links present in both sheets the applied label (written last) wins.
  const candidates = [
    ...ignoredRows.map(r => toRow(r, 0)),
    ...appliedRows.map(r => toRow(r, 1)),
  ].filter(j => j.link && (j.company || j.role) && !store[j.link]);

  console.log(`Bootstrapping ${candidates.length} new label(s) from Applied (${appliedRows.length}) + Ignored (${ignoredRows.length})...`);
  if (candidates.length === 0) return;

  const descCache = loadDescriptions();   // load the (large) cache once, not per link
  const entries = [];
  for (const j of candidates) {
    const text = buildJobText({ ...j, description: descCache[j.link]?.description || '' });
    entries.push({ link: j.link, label: j.label, company: j.company, role: j.role, text, embedding: await embed(text) });
  }
  const written = saveTrainingData(entries);
  console.log(`Saved ${written} labeled example(s) → data/training-data.json`);
}

async function main() {
  if (process.argv.includes('--bootstrap')) await bootstrap();
  await retrain();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
