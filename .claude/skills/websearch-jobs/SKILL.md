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

If no args, search **all companies** in the list. Issue the WebSearch calls in parallel batches of 10 — but **one WebSearch call per company**.

> **Do NOT OR-batch `site:` domains into a single query.** WebSearch returns a fixed ~10 results per query regardless of how many `site:` filters you combine. Tested 2026-05-14: three companies searched separately returned 27 unique links; the same three OR'd into one query returned only 10, dropping one company entirely. One query per company is required for complete coverage.

## Step 2 — Search for jobs

For each selected company, use WebSearch with:
- If `scan_query` is set in the config, use that query exactly
- Otherwise use: `site:[careers_url domain] ("software engineer" OR "backend engineer" OR "new grad" OR "intern") 2026`

For each search result, extract:
- `company`: company name
- `role`: job title
- `location`: city/state or "Remote"
- `link`: direct URL to the job posting
- `posted`: date if visible (YYYY-MM-DD), else empty string

**Do NOT pre-filter in-context.** Dump every result with a usable URL. `write-potential.mjs` rejects blog posts, podcasts, non-job URLs, wrong-country jobs, senior roles, and dupes algorithmically.

## Step 3 — Write to Potential sheet

Build a JSON array of job objects and pipe it to `write-potential.mjs`:

```bash
echo '<JSON_ARRAY>' | node src/write-potential.mjs
```

The script handles deduplication, title filter, YOE filter, US-only filter, and a URL heuristic (`looksLikeJobUrl`) that drops `/blog/`, `/news/`, `/podcast/`, etc. Rows are tagged `Source = websearch` so `prune.mjs` knows to verify them later.

## Step 4 — Verify with Playwright

Web search results go stale — always verify every job that was written to Potential before reporting done.

For each job added in Step 3:
1. `browser_navigate` to the job URL
2. Check the page title and URL after navigation:
   - **Active**: title contains the job title and/or an Apply button is present
   - **Dead**: redirected to a generic careers page, title is just the company name, "not found", "page doesn't exist", "job has been filled", or Ashby showing only "Jobs" with no content
3. Collect the sheet row numbers of all dead listings
4. Delete dead rows from the Potential sheet in a single batch (sort row numbers descending to avoid index shifting):

```js
// Delete dead rows via Sheets API batchUpdate with deleteDimension requests
// Sort deadRows descending before building requests
```

Expect ~30–50% of web search results to be live. Proceed to Step 5 only after dead rows are removed.

## Step 5 — Report

Summarize:
- Which companies were searched
- How many jobs were found per company
- How many passed filters and were written to Potential
- How many survived Playwright verification (and how many were removed)
- Any companies with no results or search errors

Remind the user to check their Potential sheet and run `/apply` when ready.
