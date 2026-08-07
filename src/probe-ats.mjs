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
if (EMPTY) {
  const logPath = 'data/empty-ats.json';
  if (!existsSync(logPath)) { console.error('No data/empty-ats.json — run a scan first.'); process.exit(1); }
  const emptyNames = new Set(Object.keys(JSON.parse(readFileSync(logPath, 'utf-8')))
    .map(k => k.replace(/ \([a-z]+\)$/, '').toLowerCase()));
  targets = loadEnabledCompanies().filter(c => emptyNames.has(c.name.toLowerCase()));
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

console.log(`\n${'─'.repeat(60)}`);
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
