#!/usr/bin/env node
/**
 * gmail-sync.mjs — Sync job application statuses from Gmail → Google Sheets
 *
 * Searches Gmail for job-related emails, classifies each as:
 *   Rejected / Interview / Offer / (acknowledgment = skip)
 * Then matches against the Applied sheet and updates statuses + red highlights.
 *
 * No AI/tokens used — pure keyword matching.
 *
 * Usage:
 *   node gmail-sync.mjs             # sync last 7 days
 *   node gmail-sync.mjs --days 14   # sync last 14 days
 *   node gmail-sync.mjs --dry-run   # preview without writing
 *
 * First run: node gmail-auth.mjs to authorize Gmail access.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createSheetsClient, SPREADSHEET_ID, getSheetId, redRowRequest } from './sheets-client.mjs';

config();

// ── Status classification ─────────────────────────────────────────────

const REJECT_SIGNALS = [
  'decided to pursue other',
  'move forward with other candidates',
  'moving forward with other',
  'not selected',
  'unable to offer',
  'regret to inform',
  'not advancing',
  'no longer available',
  "haven't been selected",
  'not been selected',
  'other candidates',
  'not moving forward',
  'position has been filled',
  'decided not to move forward',
  'unsuccessful',
  'not a match',
  'decided to go with',
  'not the right fit',
  'closing your application',
  "we won't be moving",
  'move in a different direction',
  'decided to move in a different direction',
  'after careful consideration',
  'not proceeding with your application',
  'application was not successful',
  'will not be moving forward',
  'decided not to proceed',
  'application is no longer under consideration',
  'position has been closed',
  'filled the position',
  'not be able to move forward',
  'unfortunately',
];

const INTERVIEW_SIGNALS = [
  'like to schedule',
  'schedule a call',
  'schedule an interview',
  'phone screen',
  'technical interview',
  'next round',
  'next step',
  'move you forward',
  'moving you forward',
  'excited to invite',
  'invite you to interview',
  'please schedule',
  'book a time',
  'calendly',
  'video interview',
  'coding assessment',
  'take-home',
  'technical assessment',
  'hackerrank',
  'codility',
  'want to chat',
];

const OFFER_SIGNALS = [
  'pleased to offer',
  "we'd like to offer",
  'offer of employment',
  'formal offer',
  'extend an offer',
  'offer letter',
];

export function classify(subject, snippet) {
  const text = `${subject} ${snippet}`.toLowerCase();
  if (OFFER_SIGNALS.some(s => text.includes(s)))     return 'Offer';
  if (INTERVIEW_SIGNALS.some(s => text.includes(s))) return 'Interview';
  if (REJECT_SIGNALS.some(s => text.includes(s)))    return 'Rejected';
  return null;
}

// ── Company name extraction from email ────────────────────────────────

const FILLER_STARTS = /^(your|my|our|the|this|a|an)(\s|$)/i;
const GENERIC_LOCAL = new Set(['no reply', 'noreply', 'notification', 'recruiting', 'careers', 'hr', 'jobs', 'mail', 'support', 'newsletter', 'no-reply', 'donotreply']);
const GENERIC_DOMAINS = new Set(['myworkday', 'workday', 'lever', 'greenhouse', 'ashby', 'taleo', 'icims', 'hire', 'mail', 'email', 'bamboohr', 'smartrecruiters', 'jobvite', 'successfactors']);

export function extractCompany(subject, snippet, sender) {
  const combined = `${subject} ${snippet}`;

  const toMatch = combined.match(/(?:applying|applied|application)\s+to\s+([A-Z][A-Za-z0-9\s&/.',-]{1,40}?)(?:\s*[,!.]|\s+(?:for|position|role|team|–|-))/);
  if (toMatch) return toMatch[1].trim();

  const joinMatch = combined.match(/(?:joining|join)\s+([A-Z][A-Za-z0-9\s&/.',-]{1,40}?)(?:\s*[!.,/])/);
  if (joinMatch) return joinMatch[1].trim();

  // "at Company" at end of subject (e.g. "[Next Steps] Year at Palantir")
  const subjectEndMatch = subject.match(/\bat\s+([A-Z][A-Za-z0-9](?:[A-Za-z0-9\s]{0,28}[A-Za-z0-9])?)\s*$/i);
  if (subjectEndMatch) {
    const candidate = subjectEndMatch[1].trim();
    if (!FILLER_STARTS.test(candidate)) return candidate;
  }

  // "Company: ..." or "Company - ..." in subject — only if ≤3 words and not a filler start
  const subjectMatch = subject.match(/^(?:from\s+)?([A-Z][A-Za-z0-9\s&/.',-]{2,35}?)(?:\s*[-:–]|\s+application)/i);
  if (subjectMatch) {
    const candidate = subjectMatch[1].trim();
    if (candidate.split(/\s+/).length <= 3 && !FILLER_STARTS.test(candidate)) return candidate;
  }

  // Sender fallback: "careers@arcesium.com" → "arcesium"
  const senderParts = (sender.split('@')[1] || '').split('.');
  const mainDomain = senderParts.length >= 2 ? senderParts[senderParts.length - 2] : null;
  if (mainDomain && !GENERIC_DOMAINS.has(mainDomain)) return mainDomain;

  const localPart = (sender.match(/^([^@]+)@/) || [])[1]?.replace(/[-_.]/g, ' ').trim();
  if (localPart && !GENERIC_LOCAL.has(localPart)) return localPart;

  return null;
}

// ── Normalize company name for fuzzy matching ─────────────────────────

export function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|the|group|technologies|technology|solutions|labs|lab)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function findMatch(emailCompany, rows) {
  const normEmail = normalize(emailCompany);
  if (!normEmail) return [];
  return rows.filter(r => {
    const normSheet = normalize(r.company);
    return normSheet && (normSheet.includes(normEmail) || normEmail.includes(normSheet));
  });
}

// ── Status priority (don't downgrade) ────────────────────────────────

// classify() only ever returns one of: 'Offer' | 'Interview' | 'Rejected'.
// Statuses already in the sheet that don't appear here fall back to rank 1 (Applied).
const STATUS_RANK = { 'Applied': 1, 'Rejected': 2, 'Interview': 3, 'Offer': 6 };

export function shouldUpdate(current, next) {
  const currentRank = STATUS_RANK[current] || 1;
  const nextRank    = STATUS_RANK[next]    || 1;
  if (next === 'Rejected') return currentRank <= STATUS_RANK['Applied'];
  return nextRank > currentRank;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function syncGmail(threads, dryRun = false) {
  const sheets = createSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Applied!A:G',
  });
  const allRows = res.data.values || [];
  if (allRows.length < 2) { console.log('Applied sheet is empty.'); return; }

  // Map to rows with spreadsheet row numbers (header = row 1, data starts at row 2)
  const rows = allRows.slice(1).map((r, i) => ({
    rowNum:  i + 2,
    company: r[1] || '',
    role:    r[2] || '',
    status:  r[5] || '',
  })).filter(r => r.company || r.role);

  console.log(`Loaded ${rows.length} rows from Applied sheet.`);
  console.log(`Processing ${threads.length} email threads...\n`);

  const updates = [];

  for (const thread of threads) {
    if (!thread.messages?.length) continue;
    const msg     = thread.messages[0];
    const subject = msg.subject || '';
    const snippet = msg.snippet || '';
    const sender  = msg.sender  || '';
    const date    = msg.date?.slice(0, 10) || '';

    const newStatus = classify(subject, snippet);
    if (!newStatus) continue;

    const emailCompany = extractCompany(subject, snippet, sender);
    if (!emailCompany) continue;

    const matched = findMatch(emailCompany, rows);
    if (matched.length === 0) {
      console.log(`  ? No match: [${newStatus}] "${emailCompany}" (${date})`);
      console.log(`    Subject: ${subject}`);
      continue;
    }

    for (const match of matched) {
      if (!shouldUpdate(match.status, newStatus)) {
        console.log(`  ~ Skip: ${match.company} — ${match.role} already at "${match.status}"`);
        continue;
      }
      updates.push({ rowNum: match.rowNum, company: match.company, role: match.role, oldStatus: match.status, newStatus, date, subject });
      match.status = newStatus;
    }
  }

  if (updates.length === 0) {
    console.log('No status updates to apply.');
    return;
  }

  console.log(`\nStatus updates (${updates.length}):`);
  for (const u of updates) {
    console.log(`  ${u.oldStatus} → ${u.newStatus}: ${u.company} — ${u.role}`);
    console.log(`    "${u.subject}" (${u.date})`);
  }

  if (dryRun) { console.log('\n(dry run — nothing written)'); return; }

  // Update statuses
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map(u => ({ range: `Applied!F${u.rowNum}`, values: [[u.newStatus]] })),
    },
  });

  // Apply red formatting only to rows newly set to Rejected in this run
  const rejectedUpdates = updates.filter(u => u.newStatus === 'Rejected');
  if (rejectedUpdates.length > 0) {
    const appliedSheetId = await getSheetId(sheets, 'Applied');
    const formatReqs = rejectedUpdates.map(u => redRowRequest(appliedSheetId, u.rowNum - 1));
    for (let i = 0; i < formatReqs.length; i += 100) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: formatReqs.slice(i, i + 100) },
      });
    }
  }

  console.log(`\nSaved → Google Sheets  (${updates.length} statuses updated)`);
}

// ── Gmail API auth ────────────────────────────────────────────────────

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || 'gmail-credentials.json';
const TOKEN_PATH        = process.env.GMAIL_TOKEN_PATH        || 'gmail-token.json';
const SCOPES            = ['https://www.googleapis.com/auth/gmail.readonly'];

function getGmailClient() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Gmail credentials not found at ${CREDENTIALS_PATH}.\nRun: node gmail-auth.mjs`);
  }
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`Gmail token not found at ${TOKEN_PATH}.\nRun: node gmail-auth.mjs`);
  }
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token  = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  oAuth2.setCredentials(token);
  // Auto-save refreshed tokens
  oAuth2.on('tokens', updated => {
    const merged = { ...token, ...updated };
    writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return google.gmail({ version: 'v1', auth: oAuth2 });
}

// ── Gmail thread fetching ─────────────────────────────────────────────

const GMAIL_QUERY = [
  'subject:application',
  'subject:interview',
  'subject:offer',
  'subject:"next steps"',
  'subject:"thank you for applying"',
  'subject:"your application"',
  'subject:"we reviewed"',
  'subject:"decision"',
  'subject:candidacy',
  'subject:submission',
  'subject:"application status"',
  'subject:"status update"',
  'subject:assessment',
  'subject:"coding challenge"',
  'subject:"take-home"',
  'subject:update',
].join(' OR ');

async function fetchThreads(gmail, daysBack) {
  const after = Math.floor((Date.now() - daysBack * 86_400_000) / 1000);
  const res = await gmail.users.threads.list({
    userId: 'me',
    q: `(${GMAIL_QUERY}) after:${after}`,
    maxResults: 200,
  });

  const threadItems = res.data.threads || [];
  if (threadItems.length === 0) return [];

  const threads = await Promise.all(threadItems.map(async ({ id }) => {
    const t = await gmail.users.threads.get({
      userId: 'me', id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const msg     = t.data.messages[0];
    const headers = (msg.payload?.headers || []).reduce((acc, h) => { acc[h.name] = h.value; return acc; }, {});
    return {
      messages: [{
        subject: headers['Subject'] || '',
        snippet: msg.snippet        || '',
        sender:  headers['From']    || '',
        date:    headers['Date']    || '',
      }],
    };
  }));

  return threads;
}

// ── Entry point ───────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daysIdx = args.indexOf('--days');
  const daysBack = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) || 7 : 7;

  console.log(`Fetching Gmail threads from last ${daysBack} day(s)...`);
  const gmail   = getGmailClient();
  const threads = await fetchThreads(gmail, daysBack);
  console.log(`Found ${threads.length} threads matching job keywords.\n`);

  if (threads.length === 0) {
    console.log('No job-related emails found.');
    return;
  }

  await syncGmail(threads, dryRun);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
