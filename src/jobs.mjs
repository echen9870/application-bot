#!/usr/bin/env node
/**
 * jobs.mjs — Job scanner
 *
 * Scans company portals for new backend/infra jobs (recency window + YOE
 * configurable via portals.yml scan_config), filters US-only, deduplicates,
 * and appends to Potential.
 *
 * Usage:
 *   node src/jobs.mjs              # scan + append new jobs to Potential
 *   node src/jobs.mjs --dry-run    # preview without writing
 *   node src/jobs.mjs --all        # skip recency filter
 *   node src/jobs.mjs --no-desc    # skip description fetching (descriptions are fetched by default)
 *   node src/jobs.mjs --companies "Stripe, OpenAI"
 *
 * Descriptions: every new job's full description is fetched during the scan and persisted to
 * data/job-descriptions.json (keyed by link) so the ML scorer can later evaluate match quality.
 * Ashby/Amazon/Lever/Oracle/Atlassian include descriptions inline; Greenhouse/SmartRecruiters
 * are fetched per-job via their individual-posting endpoints. Pass --no-desc to skip all fetches.
 */

import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { createSheetsClient } from './sheets-client.mjs';
import { loadConfig, loadEnabledCompanies } from './config.mjs';
import { fetchJson } from './fetch.mjs';
import { detectApi, parseJobs, ATS } from './ats.mjs';
import { appendToPotential, fetchSeenLinks, buildCheckboxRequest } from './potential-writer.mjs';
import { saveDescriptions } from './ml/descriptions.mjs';
import {
  extractMinYOE, extractMinYOEFromDesc, yoeLabel,
  isUS, buildTitleFilter,
} from './filters.mjs';

// ── Re-exports for test suite ────────────────────────────────────────
export { extractMinYOE, extractMinYOEFromDesc, isUS, buildTitleFilter } from './filters.mjs';
export { buildCheckboxRequest } from './potential-writer.mjs';

// ── Recency helpers ──────────────────────────────────────────────────

function makeRecencyCutoff(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function isRecent(posted, cutoff) {
  if (!posted) return true;
  const d = new Date(posted);
  return isNaN(d) || d >= cutoff;
}

// Bounded-concurrency worker pool over an array of async tasks.
const EMPTY_ATS_LOG = new URL('../data/empty-ats.json', import.meta.url);

// Persist which companies returned 0 jobs, with a consecutive-scan streak per company.
// A company that returns jobs again (or is removed from portals.yml) drops off the log.
function updateEmptyAtsLog(emptyKeys, scannedKeys, date) {
  let log = {};
  try { log = JSON.parse(readFileSync(EMPTY_ATS_LOG, 'utf8')); } catch { /* first run */ }
  const emptySet = new Set(emptyKeys);
  for (const key of scannedKeys) {
    if (emptySet.has(key)) {
      const prev = log[key];
      log[key] = { firstSeen: prev?.firstSeen ?? date, lastSeen: date, scans: (prev?.scans ?? 0) + 1 };
    } else {
      delete log[key];
    }
  }
  writeFileSync(EMPTY_ATS_LOG, JSON.stringify(log, null, 2) + '\n');
  return log;
}

async function parallel(tasks, limit) {
  let i = 0;
  async function worker() { while (i < tasks.length) await tasks[i++](); }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const allDates  = args.includes('--all');
  const fetchDesc = !args.includes('--no-desc');   // descriptions fetched by default

  // --companies "Stripe, OpenAI" or --companies=Stripe,OpenAI
  const companiesIdx = args.findIndex(a => a === '--companies' || a.startsWith('--companies='));
  const companiesRaw = companiesIdx >= 0
    ? (args[companiesIdx].includes('=') ? args[companiesIdx].split('=').slice(1).join('=') : args[companiesIdx + 1])
    : null;
  const companyFilter = companiesRaw
    ? new Set(companiesRaw.split(',').map(c => c.trim().toLowerCase()).filter(Boolean))
    : null;

  const { scan, titleFilter } = loadConfig();
  const { recency_hours: RECENCY_HOURS, max_yoe: MAX_YOE,
          concurrency: CONCURRENCY, fetch_timeout_ms: TIMEOUT, retries: RETRIES } = scan;
  const RECENCY_CUTOFF = makeRecencyCutoff(RECENCY_HOURS);

  const titleOk = buildTitleFilter(titleFilter);
  let targets = loadEnabledCompanies()
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api);

  if (companyFilter) {
    targets = targets.filter(c => companyFilter.has(c.name.toLowerCase()));
    if (targets.length === 0) {
      console.error(`No API-scannable companies matched: ${[...companyFilter].join(', ')}`);
      console.error('Check portals.yml — websearch-only companies need /websearch-jobs instead.');
      process.exit(1);
    }
  }

  const sheets = createSheetsClient();
  const seenLinks = await fetchSeenLinks(sheets);

  const label = companyFilter ? [...companyFilter].join(', ') : `${targets.length} companies`;
  console.log(`Scanning ${label}${allDates ? ' (all dates)' : ` (last ${RECENCY_HOURS}h)`}...`);

  const newJobs  = [];
  const errors   = [];
  const empty    = [];   // companies whose API returned 0 jobs total — likely misconfigured ATS
  let totalFound = 0, titleFiltered = 0, oldFiltered = 0, nonUS = 0, dupes = 0, yoeFiltered = 0;

  const tasks = targets.map(c => async () => {
    try {
      const json = ATS[c._api.type].fetchAll
        ? await ATS[c._api.type].fetchAll(c._api.url, fetchJson, { timeoutMs: TIMEOUT, retries: RETRIES })
        : await fetchJson(c._api.url, { timeoutMs: TIMEOUT, retries: RETRIES });
      const jobs = parseJobs(c._api.type, json, c.name, c._api.url);
      if (jobs.length === 0) empty.push(`${c.name} (${c._api.type})`);
      totalFound += jobs.length;
      for (const j of jobs) {
        if (!titleOk(j.role))                                 { titleFiltered++; continue; }
        if (!allDates && !isRecent(j.posted, RECENCY_CUTOFF)) { oldFiltered++;   continue; }
        if (!isUS(j.location))                                { nonUS++;         continue; }
        if (seenLinks.has(j.link))                            { dupes++;         continue; }
        const minYOE = extractMinYOE(j.role);
        if (minYOE !== null && minYOE > MAX_YOE)              { yoeFiltered++;   continue; }

        // Description: inline for Ashby/Amazon/Lever/Oracle/Atlassian; fetched per-job for
        // Greenhouse/SmartRecruiters. Used both for description-level YOE filtering below and
        // (after passing) persisted to data/job-descriptions.json for later ML scoring.
        let desc = j.description || '';
        if (!desc && fetchDesc && ATS[c._api.type].fetchDescription) {
          desc = await ATS[c._api.type].fetchDescription(j, fetchJson, { timeoutMs: TIMEOUT, retries: RETRIES });
        }
        const descYOE = extractMinYOEFromDesc(desc);
        if (descYOE !== null && descYOE > MAX_YOE)            { yoeFiltered++;   continue; }

        seenLinks.add(j.link);
        newJobs.push({ ...j, description: desc, yoe: yoeLabel(j.role) });
      }
    } catch (e) { errors.push(`  ✗ ${c.name}: ${e.message}`); }
  });

  await parallel(tasks, CONCURRENCY);

  const date = new Date().toISOString().slice(0, 10);
  const line = '─'.repeat(48);
  console.log(`\n${line}\nJob Scan — ${date}\n${line}`);
  console.log(`Companies scanned : ${targets.length}`);
  console.log(`Total found       : ${totalFound}`);
  console.log(`Title filtered    : ${titleFiltered}`);
  console.log(`Older than ${RECENCY_HOURS}h   : ${oldFiltered}`);
  console.log(`Non-US removed    : ${nonUS}`);
  console.log(`YOE > ${MAX_YOE} removed   : ${yoeFiltered}`);
  console.log(`Already seen      : ${dupes}`);
  console.log(`New jobs          : ${newJobs.length}`);
  if (errors.length) console.log(`\nErrors:\n${errors.join('\n')}`);
  const log = updateEmptyAtsLog(empty, targets.map(c => `${c.name} (${c._api.type})`), date);
  if (empty.length) {
    console.log(`\nEmpty ATS (HTTP 200 but 0 jobs — link/config likely wrong, fix in portals.yml):`);
    for (const e of empty.sort()) {
      const n = log[e]?.scans ?? 1;
      console.log(`  ◯ ${e}${n > 1 ? ` — empty ${n} scans in a row (since ${log[e].firstSeen})` : ''}`);
    }
    console.log(`  Tracked in data/empty-ats.json — repeat offenders are dead endpoints.`);
  }

  if (newJobs.length === 0) { console.log('\nNo new jobs found.'); return; }

  console.log('\nNew jobs:');
  for (const j of newJobs) console.log(`  + [${j.company}] ${j.role}${j.yoe ? ` (${j.yoe})` : ''} — ${j.location || 'N/A'}`);

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  const { written } = await appendToPotential(sheets, newJobs, { dateFound: date, source: 'scan' });
  console.log(`\nSaved → Google Sheets  (${written} rows added to Potential)`);

  // Persist descriptions (keyed by link) for later ML scoring. Jobs from ATSes that expose
  // no description are silently skipped by saveDescriptions.
  const cached = saveDescriptions(newJobs);
  if (cached > 0) console.log(`Cached → data/job-descriptions.json  (${cached} descriptions for ML scoring)`);

  console.log('Tip: mark ✓ in Applied? column for jobs you applied to, then run: node src/apply.mjs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
