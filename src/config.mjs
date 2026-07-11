/**
 * config.mjs — Centralized portals.yml loader
 *
 * Loads portals.yml once per process and exposes scan config, title filter,
 * and tracked companies with consistent defaults applied. All other modules
 * should pull config values from here, not parse portals.yml themselves.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';

const DEFAULTS = {
  recency_hours:    48,
  max_yoe:          3,
  concurrency:      10,
  fetch_timeout_ms: 10_000,
  retries:          3,
};

let _cache = null;

export function loadConfig(path = PORTALS_PATH) {
  if (_cache && _cache._path === path) return _cache;
  if (!existsSync(path)) throw new Error(`${path} not found in cwd ${process.cwd()}`);
  const raw = yaml.load(readFileSync(path, 'utf-8')) || {};
  _cache = {
    _path:       path,
    scan:        { ...DEFAULTS, ...(raw.scan_config || {}) },
    titleFilter: raw.title_filter || {},
    companies:   raw.tracked_companies || [],
  };
  warnDuplicates(_cache.companies);
  return _cache;
}

// Duplicate entries mean double API fetches per scan and double websearch spend —
// warn loudly so they get removed instead of accumulating (35 were purged 2026-07-10).
function warnDuplicates(companies) {
  const seen = new Map();
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const c of companies) {
    for (const key of [norm(c.name), c.api?.trim(), c.careers_url?.trim()]) {
      if (!key) continue;
      if (seen.has(key) && seen.get(key) !== c) {
        console.warn(`  [config] WARNING: duplicate portals.yml entry "${c.name}" (matches "${seen.get(key).name}") — remove one`);
        break;
      }
      if (!seen.has(key)) seen.set(key, c);
    }
  }
}

// Companies with `enabled` not explicitly false. Every consumer that iterates
// companies wants this baseline filter — callers layer their own criteria on top
// (e.g. jobs.mjs adds detectApi(), check-liveness adds `c.api`).
export function loadEnabledCompanies(path = PORTALS_PATH) {
  return loadConfig(path).companies.filter(c => c.enabled !== false);
}

// Test-only: clear the cached config so the next loadConfig() re-reads the file
export function resetConfigCache() { _cache = null; }
