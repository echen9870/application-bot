#!/usr/bin/env node
/**
 * apply.mjs — Process reviewed jobs from Potential sheet
 *
 * Reads Potential sheet in Google Sheets:
 *   ✓  (or TRUE) in Applied? column → moves to Applied sheet
 *   blank                           → moves to Ignored sheet
 * Deduplicates against existing Applied/Ignored link columns, then clears Potential.
 *
 * Usage:
 *   node src/apply.mjs            # process all rows
 *   node src/apply.mjs --dry-run  # preview without writing
 */

import { fileURLToPath } from 'url';
import { createSheetsClient, getColumn, SPREADSHEET_ID } from './sheets-client.mjs';

// ── Pure logic (exported for tests) ──────────────────────────────────

export function categorizeRows(dataRows) {
  const toApply  = [];
  const toIgnore = [];
  for (const r of dataRows) {
    // Defensive coercion: Sheets API can return booleans from formula cells even
    // when default FORMATTED_VALUE returns strings for plain checkboxes. String()
    // handles boolean true/false, numbers, null, undefined without throwing.
    const applyVal = String(r[0] ?? '').trim();
    const company  = r[3] || '';
    const role     = r[4] || '';
    if (!company && !role) continue;
    const entry = { found: r[1] || '', company, role, location: r[5] || '', link: r[6] || '' };
    const checked = applyVal === '✓' || applyVal.toUpperCase() === 'TRUE';
    if (checked) toApply.push(entry);
    else         toIgnore.push(entry);
  }
  return { toApply, toIgnore };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sheets = createSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Potential!A:J',
  });
  const allRows = res.data.values || [];
  if (allRows.length < 2) { console.log('Potential sheet is empty — nothing to process.'); return; }

  const { toApply, toIgnore } = categorizeRows(allRows.slice(1));
  if (toApply.length === 0 && toIgnore.length === 0) {
    console.log('Potential sheet is empty — nothing to process.');
    return;
  }

  // Dedup BEFORE logging so the printed counts match what we'll actually write
  const [existingApplied, existingIgnored] = await Promise.all([
    getColumn(sheets, 'Applied', 'E'),
    getColumn(sheets, 'Ignored', 'E'),
  ]);
  const seenLinks = new Set([...existingApplied, ...existingIgnored]);

  const newApply  = toApply.filter(j => !j.link || !seenLinks.has(j.link));
  const newIgnore = toIgnore.filter(j => !j.link || !seenLinks.has(j.link));
  const skipped   = (toApply.length - newApply.length) + (toIgnore.length - newIgnore.length);

  const today = new Date().toISOString().slice(0, 10);

  if (newApply.length > 0) {
    console.log(`Moving ${newApply.length} applied job(s) → Applied:`);
    for (const j of newApply) console.log(`  ✓ [${j.company}] ${j.role}`);
  }
  if (newIgnore.length > 0) {
    console.log(`Moving ${newIgnore.length} job(s) → Ignored:`);
    for (const j of newIgnore) console.log(`  ✗ [${j.company}] ${j.role}`);
  }
  if (skipped > 0) console.log(`Skipping ${skipped} duplicate(s) already in Applied/Ignored.`);

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  const writeRequests = [];
  if (newApply.length > 0) {
    writeRequests.push({
      range: 'Applied!A:G',
      values: newApply.map(j => [today, j.company, j.role, j.location, j.link, 'Applied', '']),
    });
  }
  if (newIgnore.length > 0) {
    writeRequests.push({
      range: 'Ignored!A:E',
      values: newIgnore.map(j => [j.found, j.company, j.role, j.location, j.link]),
    });
  }

  for (const req of writeRequests) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: req.range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: req.values },
    });
  }

  // Clear through column K so stale Match Scores don't carry into the next scan's rows.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Potential!A2:K',
  });

  console.log(`\nDone. Applied: ${newApply.length}, Ignored: ${newIgnore.length}. Potential cleared.`);
  console.log('Run node src/jobs.mjs to scan for new jobs.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
