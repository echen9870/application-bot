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

## Step 2 — Spawn parallel Haiku subagents for websearch-only companies

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

**Organize companies into batches of 10-12 and spawn Haiku subagents in parallel** (6+ agents for ~120 companies). Each agent will:

1. Run WebSearch for each company (one query per company for complete coverage)
2. Extract: `company`, `role`, `location`, `link`, `posted` (YYYY-MM-DD or empty)
3. Write results to Potential via `write-potential.mjs`
4. Report: jobs found, jobs written after filters

For each company, use:
- If `scan_query` is set, use that query exactly
- Otherwise: `site:[careers_url domain] ("software engineer" OR "backend engineer" OR "new grad" OR "intern") 2026`

> **Do NOT OR-batch `site:` domains into one query.** One query per company is required for complete coverage.

**Do NOT pre-filter in-context.** Dump every result with a usable URL. `write-potential.mjs` handles dedup, title filter, YOE filter, US-only filter, and URL heuristic (`looksLikeJobUrl`) automatically — tags all rows with `Source = websearch`.

## Step 3 — Await parallel agent completion

Wait for all Haiku subagents (6+ batches) to complete. Each agent writes results directly to Potential via `write-potential.mjs`. You will be notified automatically when all batches finish.

## Step 4 — Prune dead websearch links

```bash
node src/prune.mjs
```

Prune restricts itself to `Source = websearch` rows. Scan rows are skipped (they're recent). For each websearch link:
- **Greenhouse / Lever / Ashby / SmartRecruiters**: Use ATS API to verify
- **Generic** (Stripe, Apple, custom portals): HTTP GET + check final URL for redirects/404

Removes dead rows automatically. Expect ~30–50% of websearch results to be live.

## Step 5 — Score all jobs (unified pass)

```bash
node src/score.mjs
```

Score **all Potential jobs** (API scan + websearch survivors together) with the named-feature model (sigmoid over 9 features: rubric-derived + label history; trained weights or hand-tuned prior). Writes Match Score to column K, per-feature contributions to columns L–T, and sorts the sheet best-first.

**This ensures every job is ranked uniformly regardless of source, and no jobs are left unscored.**

## Step 6 — Report

Summarize:
- **API scan**: companies scanned, new scan-sourced jobs written, filters hit
- **Websearch**: parallel batches spawned, companies searched, jobs found and written after `write-potential.mjs` filters
- **Prune**: websearch rows checked, dead rows removed, live links remaining
- **Scoring**: mode (trained weights vs prior cold start), score range, top 20 ranked matches by Match Score
- **Total new live jobs in Potential** (split by Source: API scan vs websearch)

Include link to Potential sheet sorted best-first. Remind the user to:
- Review top matches by Match Score
- Check ✓ boxes for jobs to apply to
- Run `npm run apply` to move rows, record feedback labels, and retrain the model
