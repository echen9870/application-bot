---
name: scanall
description: Full scan — API companies (Greenhouse/Ashby/Lever/SmartRecruiters) + web search for websearch-only companies, then prune dead links and score + sort by Match Score. Combines /scan and /websearch-jobs into one pass.
user_invocable: true
args: flags
argument-hint: "[--all] [--dry-run]"
---

# scanall

Runs the complete pipeline across all companies: API scan + websearch + prune.

## Step 1 — API scan

Run the scanner for all API-scannable companies (Greenhouse, Ashby, Lever, SmartRecruiters):

```bash
node src/jobs.mjs {{flags}}
```

These rows are written to Potential with `Source = scan`. They are recent (≤ `recency_hours`) and known-live at the time of write — prune skips them.

Note how many new jobs were written and how many were filtered.

## Step 2 — Websearch for websearch-only companies

Get the list of companies with `scan_method: websearch`:

```bash
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
const config = yaml.load(readFileSync('portals.yml', 'utf-8'));
const cos = config.tracked_companies || [];
const list = cos.filter(c => c.enabled !== false && c.scan_method === 'websearch')
  .map(c => ({ name: c.name, url: c.careers_url, query: c.scan_query }));
console.log(JSON.stringify(list, null, 2));
EOF
```

For each company in that list, use WebSearch:
- If `scan_query` is set, use that query exactly
- Otherwise: `site:[careers_url domain] ("software engineer" OR "backend engineer" OR "new grad" OR "intern") 2026`

Work through them in parallel batches of 10.

**Do NOT pre-filter results in-context.** Just extract `company`, `role`, `location`, `link`, `posted` (YYYY-MM-DD or empty) for every result that has a usable URL. `write-potential.mjs` will reject blog posts, non-job URLs, wrong-country jobs, dupes, and senior roles algorithmically — Claude doesn't need to spend tokens making those judgment calls.

Write results to Potential (tagged `Source = websearch`):

```bash
echo '<JSON_ARRAY>' | node src/write-potential.mjs
```

`write-potential.mjs` handles dedup, title filter, YOE filter, US-only filter, and a `looksLikeJobUrl()` check that drops `/blog/`, `/news/`, `/podcast/`, `/insights/`, etc.

## Step 3 — Prune dead websearch links

```bash
node src/prune.mjs
```

Prune now restricts itself to `Source = websearch` rows. Scan rows are skipped (they're recent). For each websearch link:
- **Greenhouse / Lever**: individual job endpoint (404 = dead). Lever's old false-positive issue is gone — we no longer trust the board listing.
- **Ashby**: full board listing, check if UUID still present.
- **Generic** (Stripe, Apple, custom portals): HTTP GET + check final URL for `?error=true`.

Trust prune's verdict for any ATS-known link — no Playwright needed.

## Step 4 — Playwright-verify only generic websearch links

After prune, only links prune couldn't determine remain unverified — these are the `generic` ones (Stripe, Apple, ByteDance, custom careers pages). Playwright-verify those:

```js
// Query Potential!G2:J for rows where Source = 'websearch'
// Filter to generic links: NOT matching greenhouse|ashby|lever|smartrecruiters host patterns
```

For each remaining generic websearch link:
1. `browser_navigate` to the URL
2. `browser_snapshot` to check content:
   - **Active**: job title visible + Apply button present
   - **Dead**: redirected to generic careers page, "not found", job filled, or no content
3. Collect row numbers of dead listings
4. Delete dead rows in one batch (sort descending to avoid index shift)

This is dramatically smaller than before — most websearch results survive into Potential as ATS links that prune already validated.

## Step 5 — Score and sort

```bash
node src/score.mjs
```

Scores every Potential row (embedding cosine, blended with the apply/ignore feedback model when trained), writes Match Score to column K, sorts the sheet best-first.

## Step 6 — Report

Summarize:
- API scan: companies scanned, new scan-sourced jobs written, filters hit
- Websearch: companies searched, jobs found, jobs written after `write-potential.mjs` filters
- Prune: websearch rows checked, dead rows removed
- Playwright: generic links verified, dead rows removed
- Scoring mode (cosine-only vs blended) and top matches
- **Total new live jobs in Potential** (split by Source)

Remind the user to review Potential and run `/apply` when ready.
