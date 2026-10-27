/**
 * sheets-client.mjs — Shared Google Sheets auth + helpers
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { config } from 'dotenv';

config(); // load .env

// No fallback default on purpose. A hardcoded ID means a missing or misnamed
// .env silently reads and writes someone else's spreadsheet instead of failing.
// Validated in createSheetsClient() rather than at import, so importing this
// module (and running the test suite) stays possible without a .env.
export const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// Red highlight colors (FFFFC7CE background, FF9C0006 text)
export const RED_BG   = { red: 1.0, green: 0.7804, blue: 0.8078 };
export const RED_TEXT = { red: 0.6118, green: 0, blue: 0.0235 };

// Service-account credentials: the key's JSON in GOOGLE_SERVICE_ACCOUNT_JSON (for cloud
// runs, where no key file exists) wins; otherwise read the key file from disk.
// The error never echoes the variable's value, since it is a secret.
export function loadServiceAccountCredentials(env = process.env) {
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try { return JSON.parse(inline); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the whole key file contents.'); }
  }
  const paths = [env.GOOGLE_SERVICE_ACCOUNT_PATH, 'service-account.json', '/tmp/app/service-account.json'].filter(Boolean);
  const saPath = paths.find(p => existsSync(p));
  if (!saPath) throw new Error('service-account.json not found. Set GOOGLE_SERVICE_ACCOUNT_PATH in .env, or GOOGLE_SERVICE_ACCOUNT_JSON to the key\'s contents');
  return JSON.parse(readFileSync(saPath, 'utf-8'));
}

export function createSheetsClient() {
  if (!SPREADSHEET_ID) {
    throw new Error(
      'GOOGLE_SPREADSHEET_ID is not set. Copy .env.example to .env and set it to ' +
      'your own spreadsheet ID (the long string in your sheet\'s URL).'
    );
  }
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Get all non-empty values in a column, skipping header (row 1)
export async function getColumn(sheets, sheetName, col) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${col}2:${col}`,
    });
    return new Set((res.data.values || []).map(r => r[0]).filter(Boolean));
  } catch { return new Set(); }
}


// Get numeric sheetId for a named tab
export async function getSheetId(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties',
  });
  return meta.data.sheets.find(s => s.properties.title === tabName)?.properties.sheetId ?? 0;
}

// Build a repeatCell format request for a single row
export function redRowRequest(sheetId, rowIndex, numCols = 7) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: numCols,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: RED_BG,
          textFormat: { foregroundColor: RED_TEXT },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat.foregroundColor)',
    },
  };
}
