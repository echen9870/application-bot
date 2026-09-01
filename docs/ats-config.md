# portals.yml & ATS Troubleshooting

Load this when adding companies to `portals.yml`, fixing a broken scan endpoint, or investigating the "Empty ATS" section of a scan summary.

## portals.yml Structure

```yaml
scan_config:
  recency_hours: 48
  max_yoe: 3
  concurrency: 10
  fetch_timeout_ms: 10000

title_filter:
  positive: [engineer, developer, ...]
  negative: [senior staff, principal, director, ...]

tracked_companies:
  - name: Stripe
    careers_url: https://stripe.com/jobs
    api: https://boards-api.greenhouse.io/v1/boards/stripe/jobs
    scan_method: greenhouse
    enabled: true           # omit or set false to skip
```

**scan_method values:** `greenhouse`, `ashby`, `smartrecruiters`, `lever`, `workday`, `oraclecloud`, `amazon`, `googlecareers`, `applecareers`, `websearch` (websearch = skipped by scanner; needs `/websearch-jobs`)

**Platform mix:** run `grep -c 'scan_method: X' portals.yml` for current counts. Custom adapters exist for `amazon`, `workday`, `oraclecloud`, `googlecareers`, `applecareers`, `plaidcareers`, `saicjobs`, `bainrss`, `schwabicims`, `atlassian`. ~95 companies have no public ATS API and stay on `scan_method: websearch` (use `/websearch-jobs` + `write-potential.mjs`).

## Adding a company

Probe in order — Ashby (`jobs.ashbyhq.com` slug), Lever (`jobs.lever.co`), Greenhouse (`/v1/boards/{slug}/jobs`), SmartRecruiters (`/v1/companies/{Slug}/postings?limit=100&status=PUBLIC`), Workday (`{tenant}.wd{N}.myworkdayjobs.com/{site}`), Oracle Cloud HCM (`{tenant}.fa.oraclecloud.com` or `{tenant}.fa.ocs.oraclecloud.com`). HTTP 200 with JSON = correct endpoint. HTTP 404 = wrong slug.

Or automate: `node src/probe-ats.mjs --company "Name"`; add `--apply` to patch portals.yml automatically (regex string patching, not yaml.dump — comments preserved). Both `probe-ats.mjs --apply` and `check-liveness.mjs --fix` write via `portals.yml.tmp` + `rename` so a kill mid-write can't truncate the source-of-truth file.

## Empty ATS Problem: HTTP 200 but 0 Jobs

A company's endpoint can return HTTP 200 with 0 jobs — not a network failure, just a misconfigured platform (e.g. configured as SmartRecruiters but actually Workday). `src/jobs.mjs` prints an "Empty ATS" section at the end of every scan listing offenders.

**Start with `node src/probe-ats.mjs --empty`**, which classifies every empty board so you only chase the actionable ones:

| State | Meaning | Action |
|-------|---------|--------|
| `BROKEN` | Endpoint errors or returns HTML instead of JSON | Fix the config — usually the ATS was decommissioned |
| `GONE` | The ATS has no such account | Re-home to the company's current ATS |
| `ABANDONED` | Real account, but empty every scan for 14+ consecutive scans | Re-home — the account is live but unused |
| `DORMANT` | Real account, recently empty | Nothing — it's a hiring freeze, it'll come back |

The streak (`data/empty-ats.json`) is what separates `ABANDONED` from `DORMANT`; a board with no opening for two weeks of scans is not between reqs. Note that SmartRecruiters returns `200 {"totalFound":0}` for a nonexistent slug and `404`s the `/v1/companies/{slug}` metadata endpoint for *every* slug, real or not — the only reliable liveness check is that `jobs.smartrecruiters.com/{slug}` redirects to `careers.smartrecruiters.com/{slug}` rather than to the bare root.

**Fix:**
1. Visit the company's careers page, identify the real ATS from the URL/network requests.
2. `node src/probe-ats.mjs --company "Company Name"` to auto-probe (add `--apply` to patch `portals.yml` automatically).
3. Verify: `node src/jobs.mjs --companies "Company Name" --all --dry-run`.
4. Update `portals.yml` (wrong slug, wrong `scan_method:`, or a new custom adapter in `src/ats.mjs` — see `saicjobs`/`bainrss`/`schwabicims` as examples) and commit immediately.
5. Genuinely no public API → set `scan_method: websearch`.

Full audit trail of past fixes: `/home/echen/.claude/projects/-home-echen-career-ops/memory/project_dead_ats_endpoints.md`.

**SPA-locked (need a headless browser, not worth it yet):** Microsoft (Eightfold, session-token gated), Meta (internal GraphQL, rotated tokens), GitHub (iCIMS, JS-only render). Left on `scan_method: websearch`.
