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

## Step 2 — Web search for websearch-only companies

**Delegate to subagent (token-efficient):**

```bash
/websearch-jobs
```

This runs a dedicated agent to search all websearch-only companies in portals.yml:
- 79 companies searched, one query each (no OR-batching for complete coverage)
- WebSearch results extracted: company, role, location, link, posted date
- Written to Potential via `write-potential.mjs` (auto-applies dedup, title/location/YOE filters, URL heuristic)
- All rows tagged `Source = websearch` for later pruning

**Why subagent?** WebSearch across 79 companies generates ~150k tokens of intermediate output — keeping it isolated in a subagent is more efficient than cluttering the main session context.

## Step 3 — Prune dead websearch links

```bash
node src/prune.mjs
```

Prune restricts itself to `Source = websearch` rows. Scan rows are skipped (they're recent). For each websearch link:
- **Greenhouse / Lever / Ashby / SmartRecruiters**: Use ATS API to verify
- **Generic** (Stripe, Apple, custom portals): HTTP GET + check final URL for redirects/404

Removes dead rows automatically. Expect ~30–50% of websearch results to be live.

## Step 4 — Score all jobs (unified pass)

```bash
node src/score.mjs
```

Score **all Potential jobs** (API scan + websearch survivors together) with the named-feature model (sigmoid over 9 features: rubric-derived + label history; trained weights or hand-tuned prior). Writes Match Score to column K, per-feature contributions to columns L–T, and sorts the sheet best-first.

**This ensures every job is ranked uniformly regardless of source, and no jobs are left unscored.**

## Step 5 — Report

Summarize:
- **API scan**: companies scanned, new scan-sourced jobs written, filters hit
- **Websearch**: companies searched, jobs found and written after `write-potential.mjs` filters
- **Prune**: websearch rows checked, dead rows removed, live links remaining
- **Scoring**: mode (trained weights vs prior cold start), score range, top 20 ranked matches by Match Score
- **Total new live jobs in Potential** (split by Source: API scan vs websearch)

Include link to Potential sheet sorted best-first. Remind the user to:
- Review top matches by Match Score
- Check ✓ boxes for jobs to apply to
- Run `npm run apply` to move rows, record feedback labels, and retrain the model
