---
name: websearch-jobs
description: Search for new grad/intern/entry-level jobs at any company using web search. Writes results to the Potential Google Sheet.
user_invocable: true
args: companies
argument-hint: "[company1 company2 ...] or leave blank to pick 10 from the full list"
---

# websearch-jobs

Search for software engineering jobs at any company using web search. Covers all companies in portals.yml regardless of scan method.

## Step 1 — Get the company list

Run this to get all enabled companies:

```bash
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
const config = yaml.load(readFileSync('portals.yml', 'utf-8'));
const cos = config.tracked_companies || [];
const list = cos.filter(c => c.enabled !== false).map(c => ({ name: c.name, url: c.careers_url, query: c.scan_query }));
console.log(JSON.stringify(list, null, 2));
EOF
```

If `{{companies}}` was provided, filter the list to only those companies (case-insensitive match on name).

If no args, search **all companies** in the list.

## Step 2 — Web search for each company

**Run every query in the foreground, in the session that invoked this skill. Do NOT spawn a subagent, background agent, or parallel agents to do the searching** — a delegated agent reports back only a summary, hiding which results it kept or dropped and reporting estimated counts instead of what `write-potential.mjs` actually wrote.

For each company in the list, sequentially, in this session:

1. **Run WebSearch** (one query per company for complete coverage)
2. **Extract**: company, title, location, URL, posted date (YYYY-MM-DD or empty)
3. **Write results** to Potential via `write-potential.mjs`
4. Track jobs found and written

> **Do NOT OR-batch `site:` domains into a single query.** WebSearch returns a fixed ~10 results per query regardless of how many `site:` filters you combine. One query per company is required for complete coverage.

**For each company query, use:**
- If `scan_query` is set in the config, use that query exactly
- Otherwise use: `site:[careers_url domain] ("software engineer" OR "backend engineer" OR "new grad" OR "intern") 2026`

**Do NOT pre-filter results in-context.** Dump every result with a usable URL. `write-potential.mjs` handles:
- Deduplication
- Title filter (removes senior/staff roles)
- YOE filter (removes 3+ YOE roles)
- US-only filter
- URL heuristic (`looksLikeJobUrl`) that drops `/blog/`, `/news/`, `/podcast/`, etc.
- Tags all rows with `Source = websearch` for later pruning

## Step 3 — Prune dead links

```bash
node src/prune.mjs
```

Prune checks all `Source = websearch` rows (skips API scan rows). For each websearch link:
- **Greenhouse / Lever / Ashby / SmartRecruiters**: Use ATS API to verify
- **Generic links** (Stripe, Apple, custom portals): HTTP GET + check for redirects/404

Removes dead rows automatically. Expect ~30–50% of websearch results to be live.

## Step 4 — Score and sort

```bash
node src/score.mjs
```

Score all Potential jobs (API scan + websearch survivors) with the named-feature model (sigmoid over 9 features: rubric-derived + label history; trained weights or hand-tuned prior). Writes Match Score to column K, per-feature contributions to columns L–T, and sorts sheet best-first.

## Step 5 — Report

Summarize:
- Total companies searched
- Total jobs found and written to Potential (after write-potential.mjs filters)
- Prune results: dead links removed, live links remaining
- Scoring mode and top ranked matches (from score.mjs)
- **Total new live jobs in Potential** (ranked by Match Score)

Remind the user to check their Potential sheet (sorted best-first) and run `/apply` when ready.
