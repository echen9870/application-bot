#!/usr/bin/env node
/**
 * write-potential.mjs — Append jobs to the Potential sheet from stdin JSON
 *
 * Reads a JSON array of job objects from stdin:
 *   [{ company, role, location, link, posted }]
 *
 * Applies title/location/title-YOE filters (no recency, no description filter —
 * websearch results don't have those fields), deduplicates against three sheets,
 * and writes via the shared appendToPotential helper.
 *
 * Usage:
 *   echo '[{"company":"Stripe","role":"SWE Intern","location":"Remote","link":"https://...","posted":"2026-05-01"}]' | node src/write-potential.mjs
 *   node src/write-potential.mjs --dry-run  (reads stdin, previews without writing)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createSheetsClient } from './sheets-client.mjs';
import { loadConfig } from './config.mjs';
import { appendToPotential, fetchSeenLinks } from './potential-writer.mjs';
import { extractMinYOE, yoeLabel, isUS, buildTitleFilter, looksLikeJobUrl } from './filters.mjs';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (process.stdin.isTTY) {
    console.error('Usage: echo \'[{"company":"...","role":"...","location":"...","link":"...","posted":"YYYY-MM-DD"}]\' | node src/write-potential.mjs');
    process.exit(1);
  }
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  if (!raw) { console.error('No input on stdin.'); process.exit(1); }

  let jobs;
  try { jobs = JSON.parse(raw); } catch { console.error('Invalid JSON on stdin.'); process.exit(1); }
  if (!Array.isArray(jobs) || jobs.length === 0) { console.log('No jobs to write.'); return; }

  const { scan, titleFilter } = loadConfig();
  const MAX_YOE = scan.max_yoe;
  const titleOk = buildTitleFilter(titleFilter);

  const sheets = createSheetsClient();
  const seenLinks = await fetchSeenLinks(sheets);

  const newJobs = [];
  for (const j of jobs) {
    if (!j.company || !j.role) continue;
    if (!j.link)                              { console.log(`  ✗ missing link: [${j.company}] ${j.role}`); continue; }
    if (!looksLikeJobUrl(j.link))             { console.log(`  ✗ not-a-job URL: [${j.company}] ${j.role} — ${j.link}`); continue; }
    if (!titleOk(j.role))                     { console.log(`  ✗ title filter: [${j.company}] ${j.role}`); continue; }
    if (!isUS(j.location))                    { console.log(`  ✗ non-US: [${j.company}] ${j.role}`); continue; }
    if (seenLinks.has(j.link))                { console.log(`  ~ dupe: [${j.company}] ${j.role}`); continue; }
    const minYOE = extractMinYOE(j.role);
    if (minYOE !== null && minYOE > MAX_YOE)  { console.log(`  ✗ YOE>${MAX_YOE}: [${j.company}] ${j.role}`); continue; }
    seenLinks.add(j.link);
    newJobs.push({ ...j, yoe: yoeLabel(j.role) });
  }

  if (newJobs.length === 0) { console.log('All jobs filtered out — nothing to write.'); return; }

  console.log(`\nNew jobs to add (${newJobs.length}):`);
  for (const j of newJobs) console.log(`  + [${j.company}] ${j.role}${j.yoe ? ` (${j.yoe})` : ''} — ${j.location || 'N/A'}`);

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  const { written } = await appendToPotential(sheets, newJobs, { source: 'websearch' });
  console.log(`\nSaved → Google Sheets (${written} rows added to Potential)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
