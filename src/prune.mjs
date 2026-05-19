#!/usr/bin/env node
/**
 * prune.mjs — Remove dead job listings from the Potential sheet
 *
 * Uses ATS board APIs (no browser, no auth needed). URL detection and ATS
 * knowledge live in src/ats.mjs; HTTP plumbing in src/fetch.mjs.
 *
 *   - Greenhouse: individual job endpoint (404 = closed)
 *   - Ashby/Lever: fetch full board once, check if job ID still present (cached)
 *   - Generic: HEAD request + redirect URL check
 *
 * Usage:
 *   node src/prune.mjs             # check and remove dead rows
 *   node src/prune.mjs --dry-run   # preview without deleting
 */

import { fileURLToPath } from 'url';
import { createSheetsClient, getSheetId, SPREADSHEET_ID } from './sheets-client.mjs';
import { loadConfig } from './config.mjs';
import { fetchJson, fetchResponse } from './fetch.mjs';
import { parseLink, ATS } from './ats.mjs';

const boardCache = new Map(); // cacheKey → Promise<Set<id> | null>

async function getBoardIds(type, slug, { timeoutMs, retries }) {
  const key = `${type}:${slug}`;
  // Cache the in-flight Promise (not the resolved value) so concurrent workers
  // hitting the same company share a single fetch instead of racing it.
  if (boardCache.has(key)) return boardCache.get(key);

  const promise = (async () => {
    try {
      const json = await fetchJson(ATS[type].boardApi(slug), { timeoutMs, retries });
      const list = type === 'lever' ? (Array.isArray(json) ? json : [])
                                    : (json.jobs || []);
      return new Set(list.map(j => j.id?.toLowerCase()).filter(Boolean));
    } catch {
      return null;
    }
  })();
  boardCache.set(key, promise);
  return promise;
}

async function isAlive(parsed, { timeoutMs, retries }) {
  if (!parsed) return false;

  try {
    // Greenhouse + Lever both expose individual job endpoints — 404 = closed.
    // Lever previously used the board listing which had false positives (closed jobs still listed).
    if (parsed.type === 'greenhouse' || parsed.type === 'lever') {
      const res = await fetchResponse(ATS[parsed.type].jobApi(parsed.slug, parsed.id), { timeoutMs, retries: 0 });
      if (res.status === 404) return false;
      return res.ok;
    }

    if (parsed.type === 'amazon') {
      // Amazon redirects live job IDs (302) to the slugged path; dead IDs 404.
      const res = await fetchResponse(ATS.amazon.jobApi('', parsed.id), { timeoutMs, retries: 0 });
      return res.status !== 404;
    }

    if (parsed.type === 'workday') {
      const res = await fetchResponse(ATS.workday.jobApi(parsed.info, parsed.externalPath), { timeoutMs, retries: 0 });
      return res.status !== 404;
    }

    if (parsed.type === 'ashby') {
      const ids = await getBoardIds('ashby', parsed.slug, { timeoutMs, retries });
      if (ids === null) return true;   // board fetch failed → don't falsely mark dead
      return ids.has(parsed.id);
    }

    // Generic: follow redirects, check final URL for dead signals
    const res = await fetchResponse(parsed.url, { timeoutMs, retries });
    if (!res.ok) return false;
    if (/[?&]error=true/i.test(res.url)) return false;
    return true;
  } catch {
    return true;   // network error → conservative, don't delete
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { scan } = loadConfig();
  const { concurrency: CONCURRENCY, fetch_timeout_ms: TIMEOUT, retries: RETRIES } = scan;

  const sheets = createSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Potential!A2:J',
  });
  const rows = res.data.values || [];

  const toCheck = rows
    .map((row, i) => ({
      rowNum:  i + 2,
      link:    row[6] || '',
      company: row[3] || '',
      role:    row[4] || '',
      source:  row[9] || '',
    }))
    // Only prune websearch rows: scan rows are recent (≤recency_hours) and known-live at the time they were added.
    .filter(r => r.link && r.source === 'websearch');

  const totalRows  = rows.filter(r => (r[6] || '')).length;
  const scanSkipped = totalRows - toCheck.length;
  console.log(`Checking ${toCheck.length} websearch link(s) from Potential${scanSkipped > 0 ? ` (skipping ${scanSkipped} scan-sourced row(s))` : ''}...`);

  const deadRows = [];
  let checked = 0;
  let idx = 0;

  async function worker() {
    while (idx < toCheck.length) {
      const item = toCheck[idx++];
      const parsed = parseLink(item.link);
      const alive = await isAlive(parsed, { timeoutMs: TIMEOUT, retries: RETRIES });
      checked++;
      if (!alive) {
        deadRows.push(item.rowNum);
        console.log(`  ✗ DEAD  [${item.company}] ${item.role}`);
      } else {
        process.stdout.write(`\r  Checked ${checked}/${toCheck.length}...`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toCheck.length) }, worker));
  console.log(`\r  Checked ${checked}/${toCheck.length} links.         `);
  console.log(`\nDead: ${deadRows.length}  Live: ${toCheck.length - deadRows.length}`);

  if (deadRows.length === 0) { console.log('Nothing to remove.'); return; }
  console.log(`\nRows to remove: ${[...deadRows].sort((a, b) => a - b).join(', ')}`);
  if (dryRun) { console.log('\n(dry run — nothing deleted)'); return; }

  const sheetId = await getSheetId(sheets, 'Potential');
  deadRows.sort((a, b) => b - a);   // descending to avoid index shift

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: deadRows.map(row => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
        },
      })),
    },
  });

  console.log(`Removed ${deadRows.length} dead rows from Potential sheet.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
