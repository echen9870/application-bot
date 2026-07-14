/**
 * test/test-ml.mjs — Standalone ML pipeline test (no Google Sheets needed)
 *
 * What this does:
 *   1. Fetches live job listings from a few Ashby companies
 *   2. Applies filters (title keywords, location, YOE) — same as jobs.mjs
 *   3. Scores the filtered jobs with the named-feature model (rubric + label history)
 *   4. Prints the top matches with their per-feature breakdown
 *
 * Usage:
 *   node test/test-ml.mjs                   # show top 20 (default)
 *   node test/test-ml.mjs --top 30          # show top 30
 *   node test/test-ml.mjs --all             # skip recency filter (show all jobs)
 *
 * No Google Sheets credentials required.
 */

import { fileURLToPath } from 'url';
import { scoreJobs  } from '../src/ml/scorer.mjs';
import { fetchJson  } from '../src/fetch.mjs';
import { ATS        } from '../src/ats.mjs';
import { loadConfig } from '../src/config.mjs';
import { isUS, extractMinYOE, buildTitleFilter } from '../src/filters.mjs';

// ── Companies across multiple ATS platforms for testing ──────────────────────
// Each platform has different characteristics:
// - Ashby: full descriptions inline, but company slugs can be finicky
// - Greenhouse: huge job selection, descriptions available via separate API call
// - Lever: large selection, no descriptions in listing
// - SmartRecruiters: many companies, no descriptions in listing
const TEST_COMPANIES = [
  // Ashby (descriptions included)
  { name: 'Notion',       ats: 'ashby', slug: 'notion' },
  { name: 'Linear',       ats: 'ashby', slug: 'linear' },

  // Greenhouse (descriptions available but need separate fetch)
  { name: 'Stripe',       ats: 'greenhouse', slug: 'stripe' },
  { name: 'Segment',      ats: 'greenhouse', slug: 'segment' },
  { name: 'Twilio',       ats: 'greenhouse', slug: 'twilio' },
  { name: 'Shopify',      ats: 'greenhouse', slug: 'shopify' },

  // Lever
  { name: 'AngelList',    ats: 'lever', slug: 'angellist' },
  { name: 'Rippling',     ats: 'lever', slug: 'rippling' },

  // SmartRecruiters (fallback to title-only scoring)
  { name: 'Intel',        ats: 'smartrecruiters', slug: 'intel' },
  { name: 'Cisco',        ats: 'smartrecruiters', slug: 'cisco' },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2);
  const allDates   = args.includes('--all');
  const topIdx     = args.findIndex(a => a === '--top');
  const topN       = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 20 : 20;

  console.log('━'.repeat(60));
  console.log('  ML Pipeline Test — Resume × Job Scoring (Filtered)');
  console.log('━'.repeat(60));

  // Load config for filtering
  const { scan, titleFilter } = loadConfig();
  const { max_yoe: MAX_YOE, recency_hours: RECENCY_HOURS } = scan;
  const RECENCY_CUTOFF = new Date(Date.now() - RECENCY_HOURS * 60 * 60 * 1000);
  const titleOk = buildTitleFilter(titleFilter);

  // Step 1 — Fetch jobs from multiple ATS platforms
  console.log('\n[1/3] Fetching job listings from multiple ATS platforms...');
  const allJobs = [];
  let fetchErrors = 0;

  for (const company of TEST_COMPANIES) {
    try {
      const atsType = company.ats || 'ashby';
      const url     = ATS[atsType].boardApi(company.slug);
      const json    = await fetchJson(url);
      const jobs    = ATS[atsType].parse(json, company.name, company.slug);
      allJobs.push(...jobs);
      const label   = `${company.name.padEnd(15)} (${atsType})`;
      console.log(`      ✓ ${label.padEnd(25)} ${jobs.length} jobs`);
    } catch (e) {
      fetchErrors++;
      const label = `${company.name.padEnd(15)} (${company.ats || 'ashby'})`;
      console.log(`      ✗ ${label.padEnd(25)} ${e.message}`);
    }
  }

  if (allJobs.length === 0) {
    console.error('\nNo jobs fetched — check your internet connection.');
    process.exit(1);
  }

  console.log(`      Total fetched: ${allJobs.length} jobs`);

  // Step 1.5 — Fetch descriptions for Greenhouse jobs (not included in listing API)
  const ghJobs = allJobs.filter(j => j._id && j._slug);
  if (ghJobs.length > 0) {
    console.log(`\n[1.5/3] Fetching descriptions for ${ghJobs.length} Greenhouse job(s)...`);
    let fetched = 0, failed = 0;
    for (const job of ghJobs) {
      try {
        const url  = ATS.greenhouse.jobApi(job._slug, job._id);
        const json = await fetchJson(url);
        const desc = cleanDescription(json.content || '').toLowerCase();
        job.description = desc;
        fetched++;
      } catch {
        failed++;
      }
    }
    console.log(`      ✓ Fetched ${fetched} descriptions`);
    if (failed > 0) console.log(`      ✗ ${failed} descriptions failed (will use fallback)`);
  }

  // Step 2 — Apply filters (same as jobs.mjs)
  console.log(`\n[2/3] Filtering jobs (title, location, YOE, recency)...`);
  let titleFiltered = 0, nonUS = 0, yoeFiltered = 0, oldFiltered = 0;

  const filteredJobs = allJobs.filter(j => {
    if (!titleOk(j.role))                                  { titleFiltered++; return false; }
    if (!allDates && !isRecent(j.posted, RECENCY_CUTOFF)) { oldFiltered++;   return false; }
    if (!isUS(j.location))                                 { nonUS++;         return false; }
    const minYOE = extractMinYOE(j.role);
    if (minYOE !== null && minYOE > MAX_YOE)               { yoeFiltered++;   return false; }
    return true;
  });

  console.log(`      Title filtered: ${titleFiltered}`);
  console.log(`      Non-US removed: ${nonUS}`);
  console.log(`      YOE > ${MAX_YOE}: ${yoeFiltered}`);
  console.log(`      Old (>48h): ${oldFiltered}`);
  console.log(`      Remaining to score: ${filteredJobs.length}`);

  if (filteredJobs.length === 0) {
    console.log('\n      No jobs matched the filters.');
    process.exit(0);
  }

  // Step 3 — Score filtered jobs with the named-feature model
  console.log(`\n[3/3] Scoring ${filteredJobs.length} job(s) with the feature model...`);
  const scored = await scoreJobs(filteredJobs);

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(80)}`);
  console.log(`  Top ${Math.min(topN, scored.length)} Matches (out of ${scored.length} qualified)`);
  console.log('━'.repeat(80));

  const top = scored.slice(0, topN);
  for (let i = 0; i < top.length; i++) {
    const j     = top[i];
    const rank  = String(i + 1).padStart(2);
    const score = j.score.toFixed(3);
    const bar   = scoreBar(j.score);
    console.log(`\n  ${rank}. [${score}] ${bar}`);
    console.log(`      ${j.company} — ${j.role}`);
    if (j.location) console.log(`      📍 ${j.location}`);

    // Top feature contributions — why it scored what it did
    const top3 = j.explanation.contributions.slice(0, 3)
      .map(c => `${c.name} ${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(2)}`)
      .join('  ');
    console.log(`      ${top3}`);

    // Show job description snippet being scored
    const descPreview = buildJobText(j).substring(0, 400);
    console.log(`      "${descPreview}..."`);
  }

  console.log('\n' + '━'.repeat(60));
  const minScore = scored.at(-1)?.score.toFixed(3) || '—';
  const avgScore = (scored.reduce((s, j) => s + j.score, 0) / scored.length).toFixed(3);
  console.log(`  Score range: ${minScore} – ${scored[0].score.toFixed(3)}`);
  console.log(`  Average    : ${avgScore}`);
  console.log('━'.repeat(60));
}

// Visual score bar (e.g. "████░░░░░░")
function scoreBar(score, width = 10) {
  const filled = Math.round(score * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Check if a date is recent (within the recency window)
function isRecent(posted, cutoff) {
  if (!posted) return true;
  const d = new Date(posted);
  return isNaN(d) || d >= cutoff;
}

// Decode HTML entities (Greenhouse returns &lt;h2&gt; instead of <h2>)
function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');  // do last to avoid double-decoding
}

// Clean job description: decode entities, strip HTML tags, collapse whitespace
function cleanDescription(text) {
  if (!text) return '';
  return decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, ' ')      // strip HTML tags
    .replace(/\s{2,}/g, ' ')       // collapse multiple spaces
    .trim();
}

// Build the text that was scored for a job (same logic as scorer.mjs)
function buildJobText(job) {
  if (job.description && job.description.trim().length > 50) {
    const cleanDesc = cleanDescription(job.description);
    return `${job.role} at ${job.company}\n\n${cleanDesc}`;
  }
  return `${job.role} at ${job.company} in ${job.location || 'Unknown location'}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
}
