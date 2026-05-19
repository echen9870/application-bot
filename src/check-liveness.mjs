#!/usr/bin/env node
/**
 * check-liveness.mjs — Probe every ATS API endpoint in portals.yml
 *
 * Usage:
 *   node src/check-liveness.mjs            # check all, report broken
 *   node src/check-liveness.mjs --fix      # also write enabled: false for dead entries
 *   node src/check-liveness.mjs --verbose  # show all results, not just broken
 */

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig, loadEnabledCompanies } from './config.mjs';
import { fetchResponse } from './fetch.mjs';

async function main() {
  const args    = process.argv.slice(2);
  const FIX     = args.includes('--fix');
  const VERBOSE = args.includes('--verbose');

  const { scan } = loadConfig();
  const TIMEOUT = scan.fetch_timeout_ms;
  const BATCH   = scan.concurrency;
  const RETRIES = scan.retries;

  const targets = loadEnabledCompanies().filter(c => c.api);
  console.log(`\nChecking ${targets.length} API endpoints...\n`);

  async function probe(c) {
    try {
      const r = await fetchResponse(c.api, { timeoutMs: TIMEOUT, retries: RETRIES });
      return { name: c.name, url: c.api, status: r.status, ok: r.ok };
    } catch (e) {
      const isTimeout = e.name === 'AbortError';
      return { name: c.name, url: c.api, status: isTimeout ? 'timeout' : 'error', ok: false, err: e.message };
    }
  }

  const results = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    results.push(...await Promise.all(batch.map(probe)));
    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }
  console.log('\n');

  const broken  = results.filter(r => !r.ok);
  const healthy = results.filter(r => r.ok);

  const byStatus = {};
  for (const r of broken) {
    const key = String(r.status);
    byStatus[key] = byStatus[key] ?? [];
    byStatus[key].push(r.name);
  }

  console.log('─'.repeat(60));
  console.log(`  OK:     ${healthy.length}`);
  console.log(`  Broken: ${broken.length}`);
  console.log('─'.repeat(60));

  if (VERBOSE) {
    console.log('\nAll results:');
    for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} [${r.status}] ${r.name}`);
  }

  if (broken.length === 0) { console.log('\nAll endpoints healthy ✓\n'); return; }

  console.log('\nBroken endpoints:');
  for (const [status, names] of Object.entries(byStatus)) {
    console.log(`\n  HTTP ${status}:`);
    for (const n of names) console.log(`    ✗ ${n}`);
  }

  if (!FIX) { console.log('\nRun with --fix to auto-disable permanent 404s.\n'); return; }

  console.log('\nApplying --fix: marking dead entries with enabled: false ...');
  const raw = readFileSync('portals.yml', 'utf-8');
  let content = raw;
  let fixed = 0;
  for (const r of broken) {
    // Only hard-disable permanent 404s — skip timeouts and 5xx (transient)
    if (typeof r.status !== 'number' || r.status === 429 || r.status >= 500) continue;
    const esc = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = content;
    content = content.replace(
      new RegExp(`(  - name: ${esc}\\n(?:    (?!- name:)[^\\n]*\\n)*)`, 'g'),
      match => {
        if (match.includes('enabled: false')) return match;
        fixed++;
        return match.trimEnd() + '\n    enabled: false\n';
      }
    );
    if (content !== before) console.log(`  disabled: ${r.name} (${r.status})`);
  }
  // Atomic write: temp file + rename, so a kill mid-write can't corrupt portals.yml
  writeFileSync('portals.yml.tmp', content);
  renameSync('portals.yml.tmp', 'portals.yml');
  console.log(`\nDone — disabled ${fixed} entries.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
