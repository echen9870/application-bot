/**
 * potential-writer.mjs — Append jobs to the Potential sheet
 *
 * Used by both jobs.mjs (after API scan) and write-potential.mjs (after websearch).
 * Encapsulates:
 *   - dedup-against-three-sheets (Potential G + Applied E + Ignored E)
 *   - firstEmptyRow via column B counter (avoids checkbox FALSE "table" detection)
 *   - atomic write via values.update (NOT values.append, which lands at row 1001+)
 *   - dynamic checkbox validation re-application past overflow
 */

import { getColumn, getSheetId, SPREADSHEET_ID } from './sheets-client.mjs';

const CHECKBOX_BASELINE = 1001;

function jobToRow(job, dateFound, defaultSource) {
  return [
    '',                                // A: Applied? (checkbox)
    dateFound,                         // B: Date Found
    job.posted || '',                  // C: Date Posted
    job.company || '',                 // D: Company
    job.role || '',                    // E: Role
    job.location || '',                // F: Location
    job.link || '',                    // G: Link
    job.yoe || '',                     // H: YOE
    '',                                // I: Notes
    job.source || defaultSource || '', // J: Source ('scan' or 'websearch')
  ];
}

// Build the BOOLEAN data-validation request for column A of Potential.
// Exported because jobs.mjs re-exports it for the test suite.
export function buildCheckboxRequest(sheetId, endRow = CHECKBOX_BASELINE) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 1 },
      rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true },
    },
  };
}

// Fetch a Set of all links present in Potential, Applied, or Ignored. Used for dedup.
export async function fetchSeenLinks(sheets) {
  const [pot, app, ign] = await Promise.all([
    getColumn(sheets, 'Potential', 'G'),
    getColumn(sheets, 'Applied',   'E'),
    getColumn(sheets, 'Ignored',   'E'),
  ]);
  return new Set([...pot, ...app, ...ign]);
}

// Compute the first empty row number in Potential using column B (Date Found) as
// a position counter. Column B is always filled and has no checkbox noise, so
// values.get returns exactly the filled rows (Sheets API truncates trailing empties).
export async function getFirstEmptyRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Potential!B2:B',
  });
  return (res.data.values || []).length + 2;
}

// Append jobs to Potential. Caller is responsible for filtering/dedup beforehand.
// `source` is a default tag (e.g. 'scan' or 'websearch') used for any job without its own.
// Returns { written, firstEmptyRow } for logging.
export async function appendToPotential(sheets, jobs, { dateFound, source } = {}) {
  if (jobs.length === 0) return { written: 0, firstEmptyRow: null };

  const date = dateFound || new Date().toISOString().slice(0, 10);
  const firstEmptyRow = await getFirstEmptyRow(sheets);
  const rows = jobs.map(j => jobToRow(j, date, source));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Potential!A${firstEmptyRow}:J`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Re-apply checkbox validation, extending past CHECKBOX_BASELINE if we overflowed
  const lastWrittenRow = firstEmptyRow + rows.length - 1;
  const checkboxEndRow = Math.max(CHECKBOX_BASELINE, lastWrittenRow + 1);
  const sheetId = await getSheetId(sheets, 'Potential');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [buildCheckboxRequest(sheetId, checkboxEndRow)] },
  });

  return { written: rows.length, firstEmptyRow };
}
