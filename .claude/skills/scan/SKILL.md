---
name: scan
description: Run the full job pipeline — scan API portals, filter by title/location/YOE, write to Potential sheet, prune dead links, then score + sort by Match Score. Covers all Greenhouse/Ashby/SmartRecruiters/Lever companies.
user_invocable: true
args: flags
argument-hint: "[--companies 'Stripe,OpenAI'] [--all] [--dry-run]"
---

# scan

Full pipeline: scan → filter → write to Potential → prune dead links → score + sort.

## Step 1 — Run the scanner

```bash
node src/jobs.mjs {{flags}}
```

**Key flags:**
- `--companies "Stripe, OpenAI, Glean"` — scan only these companies (comma-separated, case-insensitive). Omit to scan all ~430 API-scannable companies.
- `--all` — skip the 24h recency filter; returns all currently open jobs matching filters. Use when adding new companies or doing a full refresh.
- `--dry-run` — preview without writing to the sheet.
- `--no-desc` — skip job-description fetching. Descriptions are fetched **by default** (used for description-level YOE filtering and cached to `data/job-descriptions.json` for ML scoring); pass this to skip the per-job fetches for a faster scan.

If `--companies` names a websearch-only company (no ATS API), the scanner will report it and skip it — use `/websearch-jobs` for those.

## Step 2 — Prune dead links

After the scanner writes to Potential, remove stale rows via HTTP (no browser):

```bash
node src/prune.mjs
```

This checks Greenhouse/Ashby/Lever links against their board APIs and drops any job IDs no longer present. Takes ~30s regardless of sheet size.

## Step 3 — Score and sort

```bash
node src/score.mjs
```

Scores every Potential row with the named-feature model (sigmoid over 9 features from rubric.yml + apply/ignore label history; trained weights when available, hand-tuned prior otherwise), writes Match Score to column K plus per-feature contributions to columns L–T, and sorts the sheet best-first. Skip this step if the scan was `--dry-run` or wrote 0 new jobs to an empty sheet.

## Step 4 — Report

Summarize:
- How many companies were scanned
- How many new jobs were written to Potential
- How many were filtered (non-US, YOE, title, recency, duplicates)
- How many rows prune removed
- Scoring mode (trained weights vs prior cold start) and the top few matches
- Any errors (transient SR 404s are normal rate-limiting; safe to ignore)

Remind the user to review Potential and run `/apply` when ready.
