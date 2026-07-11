/**
 * descriptions.mjs — local cache of fetched job descriptions, keyed by job link.
 *
 * The scanner (src/jobs.mjs) fetches a description for every new job it writes to the
 * Potential sheet and persists it here. The ML scorer (src/ml/scorer.mjs) can then later
 * evaluate how well each job matches the resume — joining by link — without re-fetching
 * descriptions or bloating the Google Sheet with multi-thousand-character blobs.
 *
 * Storage: data/job-descriptions.json
 *   { [link]: { company, role, description, fetchedAt } }
 *
 * Writes are atomic (tmp file + rename) so a crash mid-write can't corrupt the cache.
 *
 * Exports:
 *   loadDescriptions()        → object map  { [link]: { company, role, description, fetchedAt } }
 *   getDescription(link)      → string      (cached description, or '' if none)
 *   saveDescriptions(jobs)    → number      (count of non-empty descriptions merged + persisted)
 *   deleteDescriptions(links) → number      (count of entries removed + persisted)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const CACHE_PATH = 'data/job-descriptions.json';

/** Load the full description cache. Returns {} if absent or unreadable. */
export function loadDescriptions() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); }
  catch { return {}; }
}

/** Look up a single cached description by job link. Returns '' if not present. */
export function getDescription(link) {
  return loadDescriptions()[link]?.description || '';
}

/**
 * Merge jobs into the cache and persist. Only entries with a non-empty description
 * are stored (jobs from ATSes that expose no description are skipped).
 *
 * @param {Array<{ link?: string, company?: string, role?: string, description?: string }>} jobs
 * @returns {number} number of entries written
 */
export function saveDescriptions(jobs) {
  const withDesc = (jobs || []).filter(j => j?.link && j.description && j.description.trim());
  if (withDesc.length === 0) return 0;

  const cache = loadDescriptions();
  const now = new Date().toISOString();
  for (const j of withDesc) {
    cache[j.link] = {
      company:   j.company || '',
      role:      j.role || '',
      description: j.description,
      fetchedAt: now,
    };
  }

  persist(cache);
  return withDesc.length;
}

/**
 * Remove entries by link and persist. Used by apply.mjs to evict ignored jobs —
 * their text is already snapshotted in training-data.json, so keeping the (large)
 * description here only bloats the cache. Applied jobs are kept.
 *
 * @param {Iterable<string>} links
 * @returns {number} number of entries removed
 */
export function deleteDescriptions(links) {
  const cache = loadDescriptions();
  let removed = 0;
  for (const link of links || []) {
    if (link in cache) { delete cache[link]; removed++; }
  }
  if (removed > 0) persist(cache);
  return removed;
}

function persist(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  renameSync(tmp, CACHE_PATH);
}
