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
 *   node src/jobs.mjs --desc       # fetch GH descriptions for desc-level YOE filtering
 *   node src/jobs.mjs --companies "Stripe, OpenAI"
 */

import { fileURLToPath } from 'url';
import { createSheetsClient } from './sheets-client.mjs';
import { loadConfig, loadEnabledCompanies } from './config.mjs';
import { fetchJson } from './fetch.mjs';
import { detectApi, parseJobs, ATS } from './ats.mjs';
import { appendToPotential, fetchSeenLinks, buildCheckboxRequest } from './potential-writer.mjs';
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

// Fetch GH job description and strip HTML for description-level YOE filtering.
async function fetchGHDescription(slug, id, { timeoutMs, retries }) {
  try {
    const json = await fetchJson(ATS.greenhouse.jobApi(slug, id), { timeoutMs, retries });
    return (json.content || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

// Bounded-concurrency worker pool over an array of async tasks.
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
  const fetchDesc = args.includes('--desc');

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

        // Description-level YOE: Ashby has it inline; GH needs --desc to fetch
        let desc = j.description || '';
        if (!desc && fetchDesc && c._api.type === 'greenhouse' && j._slug && j._id) {
          desc = await fetchGHDescription(j._slug, j._id, { timeoutMs: TIMEOUT, retries: RETRIES });
        }
        const descYOE = extractMinYOEFromDesc(desc);
        if (descYOE !== null && descYOE > MAX_YOE)            { yoeFiltered++;   continue; }

        seenLinks.add(j.link);
        newJobs.push({ ...j, yoe: yoeLabel(j.role) });
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
  if (empty.length) {
    console.log(`\nEmpty ATS (HTTP 200 but 0 jobs — likely misconfigured, debug manually):`);
    for (const e of empty.sort()) console.log(`  ◯ ${e}`);
  }

  if (newJobs.length === 0) { console.log('\nNo new jobs found.'); return; }

  console.log('\nNew jobs:');
  for (const j of newJobs) console.log(`  + [${j.company}] ${j.role}${j.yoe ? ` (${j.yoe})` : ''} — ${j.location || 'N/A'}`);

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  const { written } = await appendToPotential(sheets, newJobs, { dateFound: date, source: 'scan' });
  console.log(`\nSaved → Google Sheets  (${written} rows added to Potential)`);
  console.log('Tip: mark ✓ in Applied? column for jobs you applied to, then run: node src/apply.mjs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
