#!/usr/bin/env node
/**
 * score.mjs — Score the Potential sheet against your resume and write a Match Score column.
 *
 * This is the production wiring around the embedding model in src/ml/scorer.mjs (the same
 * model test/test-ml.mjs exercises). It does NOT introduce a new scoring algorithm — it
 * reuses scoreJobs() (resume↔job-description cosine similarity via local all-MiniLM-L6-v2,
 * blended with the apply/ignore feedback model from data/model.json when one is trained).
 *
 * Flow:
 *   1. Load resume text (src/ml/parser.mjs → data/resume.{txt,md,pdf})
 *   2. Read the Potential sheet's real data rows (A2:K, extent via the column-B counter)
 *   3. Join each row's job description from data/job-descriptions.json (by link)
 *   4. Score every row with scoreJobs() — cosine similarity, 0–1
 *   5. Map cosine → 1–10 and write it to Potential column K ("Match Score")
 *   6. Sort the sheet by Match Score, highest first
 *
 * The 1–10 scale matches the convention documented in user.yml. The underlying number is
 * the raw cosine similarity from the existing model: score10 = round(1 + cosine * 9, 1).
 *
 * Usage:
 *   node src/score.mjs            # score all Potential rows, write column K
 *   node src/score.mjs --dry-run  # compute + print ranking, write nothing
 *   node src/score.mjs --top 30   # print top N in the console summary (default 20)
 */

import { fileURLToPath } from 'url';
import { createSheetsClient, getSheetId, SPREADSHEET_ID } from './sheets-client.mjs';
import { getFirstEmptyRow } from './potential-writer.mjs';
import { parseResume } from './ml/parser.mjs';
import { scoreJobs } from './ml/scorer.mjs';
import { loadDescriptions } from './ml/descriptions.mjs';
import { loadModel } from './ml/model.mjs';
import { loadRubric } from './ml/rubric.mjs';

const SCORE_COL = 'K';                 // Potential column for the match score
const SCORE_HEADER = 'Match Score';

// Potential column indices (0-based) — see CLAUDE.md sheet layout.
const COL = { company: 3, role: 4, location: 5, link: 6 };

// Map a 0–1 cosine similarity to the 1–10 scale used in the sheet.
function toTen(cosine) {
  return Math.round((1 + cosine * 9) * 10) / 10;
}

function scoreBar(cosine, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(cosine * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const topIdx = args.findIndex(a => a === '--top');
  const topN   = topIdx >= 0 ? (parseInt(args[topIdx + 1]) || 20) : 20;

  const sheets = createSheetsClient();

  // 1 — read Potential. Use the column-B (Date Found) counter to find the real data extent:
  // column A keeps checkbox cells far below the last real row, so an open-ended A:K read would
  // return hundreds of blank rows (and overflow the grid when clearing below them).
  const firstEmptyRow = await getFirstEmptyRow(sheets);   // first row with no Date Found
  const lastDataRow   = firstEmptyRow - 1;
  if (lastDataRow < 2) { console.log('Potential sheet is empty — nothing to score.'); return; }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Potential!A2:K${lastDataRow}`,
  });
  const dataRows = res.data.values || [];

  // 2 — join descriptions from the cache (populated by jobs.mjs during scan)
  const cache = loadDescriptions();
  const jobs = dataRows.map((r, i) => {
    const link = r[COL.link] || '';
    return {
      _row:        i + 2,                         // 1-based sheet row (header is row 1)
      company:     r[COL.company] || '',
      role:        r[COL.role] || '',
      location:    r[COL.location] || '',
      link,
      description: cache[link]?.description || '',
    };
  });

  const scorable = jobs.filter(j => j.company || j.role);
  if (scorable.length === 0) { console.log('No scorable rows in Potential.'); return; }
  const withDesc = scorable.filter(j => j.description.trim().length > 50).length;
  console.log(`Scoring ${scorable.length} job(s) (${withDesc} with cached descriptions, ${scorable.length - withDesc} title-only).`);

  const model = loadModel();
  const rubric = loadRubric();
  const anchorLabel = rubric ? 'rubric' : 'resume cosine';
  console.log(model
    ? `Mode: blended — ${anchorLabel} + feedback model (${model.meta.nPos} applied / ${model.meta.nNeg} ignored labels)`
    : `Mode: ${anchorLabel} only (no trained feedback model yet — labels accrue on each /apply)`);
  if (rubric) console.log('      rubric mode active (rubric.yml) — anchor is preference rubric, not resume');

  // 3 — load resume + score with the existing embedding model
  const resumeText = await parseResume();
  const scored = await scoreJobs(resumeText, scorable);     // sorted desc, each with .score (cosine 0–1)
  const cosByRow = new Map(scored.map(j => [j._row, j.score]));

  // 4 — build the column K values, aligned to every data row (blank where unscored)
  const kValues = [[SCORE_HEADER]];
  for (let i = 0; i < dataRows.length; i++) {
    const cos = cosByRow.get(i + 2);
    kValues.push([cos == null ? '' : toTen(cos)]);
  }

  // 5 — console summary (ranked best-first)
  console.log(`\n${'━'.repeat(64)}`);
  console.log(`  Top ${Math.min(topN, scored.length)} matches (of ${scored.length} scored)`);
  console.log('━'.repeat(64));
  for (let i = 0; i < Math.min(topN, scored.length); i++) {
    const j = scored[i];
    const rank = String(i + 1).padStart(2);
    let suffix = '';
    if (j.rubricInfo) {
      if (j.rubricInfo.topDomain) suffix += `  ·${j.rubricInfo.topDomain}`;
      if (j.rubricInfo.antiHit)   suffix += `  [anti:${j.rubricInfo.antiHit}]`;
      if (j.rubricInfo.yoeCapped) suffix += '  [YOE]';
    }
    console.log(`  ${rank}. ${toTen(j.score).toFixed(1).padStart(4)}/10  ${scoreBar(j.score)}  [${j.company}] ${j.role}${suffix}`);
  }
  const cosines = scored.map(j => j.score);
  const avg = cosines.reduce((s, c) => s + c, 0) / cosines.length;
  console.log('━'.repeat(64));
  console.log(`  Score range: ${toTen(Math.min(...cosines)).toFixed(1)}–${toTen(Math.max(...cosines)).toFixed(1)} /10   (avg ${toTen(avg).toFixed(1)})`);

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  // 6 — write column K (header + one score per real data row), then clear any stale
  // scores left below the current data (e.g. from a previous, longer run).
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Potential!${SCORE_COL}1:${SCORE_COL}${lastDataRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: kValues },
  });
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `Potential!${SCORE_COL}${firstEmptyRow}:${SCORE_COL}`,
  });

  // 7 — sort the data rows (A..K, excluding header) by Match Score descending so the
  // best matches are at the top. Checkbox values in column A move with their rows.
  const sheetId = await getSheetId(sheets, 'Potential');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        sortRange: {
          range: { sheetId, startRowIndex: 1, endRowIndex: lastDataRow, startColumnIndex: 0, endColumnIndex: 11 },
          sortSpecs: [{ dimensionIndex: 10, sortOrder: 'DESCENDING' }],   // column K
        },
      }],
    },
  });

  console.log(`\nSaved → Potential column ${SCORE_COL} (${SCORE_HEADER}); sheet sorted by score, highest first.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
