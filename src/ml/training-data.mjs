/**
 * training-data.mjs — persistent store of labeled apply/ignore decisions.
 *
 * apply.mjs records one entry per Potential row it processes: label 1 (moved to
 * Applied) or 0 (moved to Ignored), plus the job text and its embedding snapshotted
 * at label time — so retraining never re-embeds old jobs and doesn't depend on the
 * description cache keeping the entry around.
 *
 * Storage: data/training-data.json
 *   { [link]: { label: 0|1, company, role, text, embedding: number[384], labeledAt } }
 *
 * Keyed by link: relabeling the same job (e.g. a /apply re-run) overwrites rather
 * than duplicates. Writes are atomic (tmp + rename).
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DATA_PATH = 'data/training-data.json';

/** Load all labeled examples. Returns {} if absent or unreadable. */
export function loadTrainingData() {
  if (!existsSync(DATA_PATH)) return {};
  try { return JSON.parse(readFileSync(DATA_PATH, 'utf-8')); }
  catch { return {}; }
}

/**
 * Merge labeled entries into the store and persist.
 * @param {Array<{ link: string, label: 0|1, company?: string, role?: string, text: string, embedding: number[] }>} entries
 * @returns {number} count of entries written
 */
export function saveTrainingData(entries) {
  const valid = (entries || []).filter(e => e?.link && (e.label === 0 || e.label === 1) && Array.isArray(e.embedding));
  if (valid.length === 0) return 0;

  const store = loadTrainingData();
  const now = new Date().toISOString();
  for (const e of valid) {
    store[e.link] = {
      label:     e.label,
      company:   e.company || '',
      role:      e.role || '',
      text:      e.text || '',
      // 6 decimals is far beyond what logistic regression can distinguish;
      // full float64 serialization roughly doubles the file size for nothing.
      embedding: e.embedding.map(v => Math.round(v * 1e6) / 1e6),
      labeledAt: now,
    };
  }

  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(store), 'utf-8');
  renameSync(tmp, DATA_PATH);
  return valid.length;
}
