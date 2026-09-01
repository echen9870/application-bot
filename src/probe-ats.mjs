#!/usr/bin/env node
/**
 * probe-ats.mjs — Find ATS API endpoints for websearch-only companies
 *
 * Tries Greenhouse, Ashby, Lever, and SmartRecruiters endpoints derived
 * from the company name and careers_url slug. Prints portals.yml patches
 * for any companies where an API is found.
 *
 * Usage:
 *   node src/probe-ats.mjs                     # probe all websearch companies
 *   node src/probe-ats.mjs --apply             # also patch portals.yml
 *   node src/probe-ats.mjs --company Stripe    # probe a specific company
 *   node src/probe-ats.mjs --empty             # probe companies in data/empty-ats.json
 *                                                (API returns 200 but 0 jobs — likely moved ATS)
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { loadConfig, loadEnabledCompanies } from './config.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const EMPTY = args.includes('--empty');
const TARGET = (() => { const i = args.indexOf('--company'); return i >= 0 ? args[i + 1]?.toLowerCase() : null; })();

const { scan } = loadConfig();
const TIMEOUT = scan.fetch_timeout_ms;
const CONCURRENCY = scan.concurrency;
const raw = readFileSync('portals.yml', 'utf-8');   // raw text for regex-patching with --apply

// Default: websearch-only companies (no api field, or scan_method: websearch).
// --empty: companies whose configured API returns 0 jobs (data/empty-ats.json) —
// their ATS endpoint is dead, so re-probe from scratch to find where they moved.
let targets;
const emptyStreaks = new Map();   // lowercased company name → consecutive empty scans
if (EMPTY) {
  const logPath = 'data/empty-ats.json';
  if (!existsSync(logPath)) { console.error('No data/empty-ats.json — run a scan first.'); process.exit(1); }
  for (const [key, val] of Object.entries(JSON.parse(readFileSync(logPath, 'utf-8')))) {
    emptyStreaks.set(key.replace(/ \([a-z]+\)$/, '').toLowerCase(), val?.scans ?? 0);
  }
  targets = loadEnabledCompanies().filter(c => emptyStreaks.has(c.name.toLowerCase()));
} else {
  targets = loadEnabledCompanies().filter(c => !c.api || c.scan_method === 'websearch');
}
if (TARGET) targets = targets.filter(c => c.name.toLowerCase().includes(TARGET));

console.log(`Probing ${targets.length} ${EMPTY ? 'empty-ATS' : 'websearch-only'} companies for ATS APIs...\n`);

// ── Slug derivation ───────────────────────────────────────────────────────────

function slugsFrom(company) {
  const name = company.name;
  const url = company.careers_url || '';

  const candidates = new Set();

  // From careers URL hostname/path
  const urlParts = url.replace(/^https?:\/\//, '').split('/');
  const host = urlParts[0] || '';

  // Extract slug from known ATS URLs in careers_url
  const ghMatch = url.match(/greenhouse\.io\/([^/?#]+)/);
  if (ghMatch) candidates.add(ghMatch[1]);

  const ashbyMatch = url.match(/ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) candidates.add(ashbyMatch[1]);

  const leverMatch = url.match(/lever\.co\/([^/?#]+)/);
  if (leverMatch) candidates.add(leverMatch[1]);

  // From workable URL
  const workableMatch = url.match(/workable\.com\/([^/?#]+)/);
  if (workableMatch) candidates.add(workableMatch[1]);

  // Derive slugs from company name
  const base = name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  candidates.add(base);

  // No-hyphen variant
  const nohyphen = base.replace(/-/g, '');
  if (nohyphen !== base) candidates.add(nohyphen);

  // First word only
  const firstWord = base.split('-')[0];
  if (firstWord.length > 2) candidates.add(firstWord);

  // Subdomain from careers URL (e.g. stripe.com → stripe)
  const subdomainMatch = host.match(/^([^.]+)\.(com|io|ai|co|net|org)/);
  if (subdomainMatch) candidates.add(subdomainMatch[1]);

  return [...candidates].filter(s => s.length > 1);
}

function normName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function namesMatch(boardName, companyName) {
  if (!boardName) return false;
  const b = normName(boardName);
  const c = normName(companyName);
  if (b.length < 4 || c.length < 4) return false;
  // Accept only if shorter name is ≥60% of longer name's length AND longer contains shorter
  const shorter = b.length <= c.length ? b : c;
  const longer  = b.length <= c.length ? c : b;
  if (shorter.length / longer.length < 0.6) return false;
  return longer.includes(shorter);
}

// Raw response (status + body), for diagnoseEmpty — which needs to tell an HTTP
// error apart from an HTML error page, both of which fetchJson flattens to null.
function fetchWithTimeoutRaw(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function tryUrl(url, type, slug, companyName) {
  let json;
  try { json = await fetchJson(url); } catch { return null; }
  if (!json) return null;

  const jobs =
    (Array.isArray(json.jobs) ? json.jobs : null) ||
    (Array.isArray(json.postings) ? json.postings : null) ||
    (Array.isArray(json.content) ? json.content : null) ||
    (Array.isArray(json) ? json : null);
  if (!jobs || jobs.length === 0) return null;

  // Validate company name via ATS-specific metadata
  if (type === 'greenhouse') {
    const meta = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    if (!meta?.name) return null;
    if (!namesMatch(meta.name, companyName)) return null;
  } else if (type === 'ashby') {
    // Ashby jobUrl contains the company slug: jobs.ashbyhq.com/{company}/{id}
    const firstJobUrl = jobs[0]?.jobUrl || '';
    const m = firstJobUrl.match(/jobs\.ashbyhq\.com\/([^/]+)/);
    const boardSlug = m?.[1] || '';
    if (!namesMatch(boardSlug, companyName)) return null;
  } else if (type === 'lever') {
    // Lever hostedUrl: jobs.lever.co/{company}/{id}
    const firstJobUrl = jobs[0]?.hostedUrl || '';
    const m = firstJobUrl.match(/jobs\.lever\.co\/([^/]+)/);
    const boardSlug = m?.[1] || '';
    if (!namesMatch(boardSlug, companyName)) return null;
  } else if (type === 'smartrecruiters') {
    const srCompany = json.company?.name || '';
    if (!namesMatch(srCompany, companyName)) return null;
  }

  return url;
}

// ── Empty-board diagnosis ─────────────────────────────────────────────────────
// A board returning 0 jobs means one of three very different things, and the
// scan log can't tell them apart — which is why 28 entries sat unreviewed for
// 42 scans. Classify them so only the actionable ones demand attention:
//
//   BROKEN    — endpoint errors or returns non-JSON. The config is wrong; fix it.
//   GONE      — the ATS has no such account. The company moved; re-home it.
//   ABANDONED — real account, but empty every scan for weeks. Not a freeze: the
//               company has moved hiring elsewhere and left the account up.
//   DORMANT   — real account, recently empty. A plausible hiring freeze; wait.
//
// The streak is what separates ABANDONED from DORMANT — a board with no opening
// for this many consecutive scans is not between reqs, it is not being used.
const ABANDONED_STREAK = 14;

async function diagnoseEmpty(company, streak = 0) {
  const type = company.scan_method;
  const url = company.api;
  if (!url) return { state: 'BROKEN', why: 'no api configured' };

  let res, text;
  try {
    res = await fetchWithTimeoutRaw(url);
    text = await res.text();
  } catch (e) {
    return { state: 'BROKEN', why: `request failed (${e.message})` };
  }
  if (!res.ok) return { state: 'BROKEN', why: `HTTP ${res.status}` };
  try { JSON.parse(text); } catch {
    return { state: 'BROKEN', why: 'returned HTML, not JSON (redirect or error page)' };
  }

  if (type === 'smartrecruiters') {
    // A live SR account redirects jobs.smartrecruiters.com/{slug} to
    // careers.smartrecruiters.com/{slug}; an unknown slug bounces to the bare
    // root. The v1/companies/{slug} metadata endpoint 404s for every slug, real
    // or not, so it cannot be used for this check.
    const slug = url.match(/companies\/([^/]+)\//)?.[1];
    if (!slug) return { state: 'BROKEN', why: 'no slug in api url' };
    try {
      const r = await fetch(`https://jobs.smartrecruiters.com/${slug}`, {
        redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT),
      });
      return new URL(r.url).pathname.replace(/\/$/, '') === ''
        ? { state: 'GONE', why: `no SmartRecruiters account for slug "${slug}"` }
        : idle(streak, `account "${slug}" is live but has 0 public postings`);
    } catch (e) {
      return { state: 'BROKEN', why: `slug check failed (${e.message})` };
    }
  }

  if (type === 'greenhouse') {
    const slug = url.match(/boards\/([^/]+)\//)?.[1];
    const meta = slug && await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    return meta?.name
      ? idle(streak, `board "${meta.name}" is live but has 0 openings`)
      : { state: 'GONE', why: `no Greenhouse board for slug "${slug}"` };
  }

  // Ashby / Lever / others: a parseable 200 means the board exists and is empty.
  return idle(streak, 'board responds normally with 0 openings');
}

// Split a confirmed-live-but-empty board on how long it has been that way.
function idle(streak, why) {
  return streak >= ABANDONED_STREAK
    ? { state: 'ABANDONED', why: `${why} — empty ${streak} scans in a row` }
    : { state: 'DORMANT', why };
}

async function probeCompany(company) {
  const slugs = slugsFrom(company);
  const candidates = [];

  for (const slug of slugs) {
    candidates.push(
      { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, slug },
      { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, slug },
      { type: 'lever', url: `https://api.lever.co/v0/postings/${slug}`, slug },
      { type: 'smartrecruiters', url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=10&status=PUBLIC`, slug },
    );
  }

  // Probe all in parallel
  const results = await Promise.all(candidates.map(async c => ({
    ...c,
    found: await tryUrl(c.url, c.type, c.slug, company.name),
  })));

  return results.filter(r => r.found);
}

// ── Run ───────────────────────────────────────────────────────────────────────

const found = [];
let idx = 0;

async function worker() {
  while (idx < targets.length) {
    const company = targets[idx++];
    const hits = await probeCompany(company);
    if (hits.length > 0) {
      found.push({ company, hits });
      for (const h of hits) {
        console.log(`  ✓ [${company.name}] ${h.type}: ${h.url}`);
      }
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

// In --empty mode, classify why each board is empty before reporting APIs —
// DORMANT companies need no action at all, so they shouldn't read as failures.
if (EMPTY) {
  const diagnoses = await Promise.all(
    targets.map(async c => ({
      company: c,
      ...(await diagnoseEmpty(c, emptyStreaks.get(c.name.toLowerCase()) ?? 0)),
    }))
  );
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Empty-board diagnosis:\n');
  for (const state of ['BROKEN', 'GONE', 'ABANDONED', 'DORMANT']) {
    const group = diagnoses.filter(d => d.state === state);
    if (!group.length) continue;
    const action = { BROKEN:   'fix the config in portals.yml',
                     GONE:     're-home to the company\'s current ATS',
                     ABANDONED:'re-home — the account is live but unused',
                     DORMANT:  'no action — recently empty, likely a hiring freeze' }[state];
    console.log(`  ${state} (${group.length}) — ${action}`);
    for (const d of group.sort((a, b) => a.company.name.localeCompare(b.company.name))) {
      console.log(`    ${d.company.name}: ${d.why}`);
    }
    console.log('');
  }
}

console.log(`${'─'.repeat(60)}`);
console.log(`Found APIs for ${found.length}/${targets.length} companies.`);

if (found.length === 0) {
  console.log('No new APIs discovered.');
  process.exit(0);
}

// ── Output portals.yml patches ────────────────────────────────────────────────

console.log('\nPortals.yml patches (add api + scan_method for each):');
const patches = [];

for (const { company, hits } of found) {
  // Prefer greenhouse > ashby > lever > smartrecruiters
  const order = ['greenhouse', 'ashby', 'lever', 'smartrecruiters'];
  const best = order.map(t => hits.find(h => h.type === t)).find(Boolean) || hits[0];

  const patch = `  # ${company.name}: found ${best.type}\n  api: ${best.url}\n  scan_method: ${best.type}`;
  patches.push({ name: company.name, type: best.type, url: best.url });
  console.log(`\n  - name: ${company.name}\n${patch}`);
}

if (APPLY) {
  console.log('\nApplying patches to portals.yml...');
  let content = raw;
  let applied = 0;

  for (const p of patches) {
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = content;
    content = content.replace(
      new RegExp(`(  - name: ${esc}\\n(?:    (?!- name:)[^\\n]*\\n)*)`, 'g'),
      match => {
        if (match.includes('api:') && !EMPTY) return match; // already has api
        applied++;
        // Drop old api/scan_method lines so we don't leave duplicate keys
        const cleaned = match
          .replace(/    api: [^\n]*\n/, '')
          .replace(/    scan_method: [^\n]*\n/, '');
        return cleaned.trimEnd() + `\n    api: ${p.url}\n    scan_method: ${p.type}\n`;
      }
    );
    if (content === before) console.log(`  ⚠ Could not patch: ${p.name}`);
  }

  // Atomic write: temp file + rename, so a kill mid-write can't corrupt portals.yml
  writeFileSync('portals.yml.tmp', content);
  renameSync('portals.yml.tmp', 'portals.yml');
  console.log(`Applied ${applied} patches to portals.yml.`);
  console.log('Run: node src/jobs.mjs --dry-run   to verify new companies scan correctly.');
} else {
  console.log('\nRun with --apply to patch portals.yml automatically.');
}
