# Career-Ops — Eric Chen's Job Search Pipeline

**Branch:** `bot-main` (working branch). `main` tracks upstream santifer/career-ops — never merge upstream into bot-main without reviewing diffs.
**User:** Eric Chen · echen9870@gmail.com
**Stack:** Node.js ESM (.mjs), Google Sheets API (not markdown files), googleapis, js-yaml, dotenv

---

## Session Start Checklist (run silently)

1. Verify `service-account.json` exists — if missing, copy from Windows Downloads:
   ```bash
   cp /mnt/c/Users/echen/Downloads/application-bot-494504-ecc22924b5cc.json service-account.json
   ```
2. Verify `.env` has `GOOGLE_SPREADSHEET_ID` set (ID: `1yt7LzUNz_wG-HEiRmhmHk826EGeskgBOrk7ABGNV5lY`)
3. `service-account.json` is gitignored — NEVER commit it

---

## Directory Layout

```
career-ops/
  src/
    # Entry-point scripts (have main() guarded by import.meta.url check)
    jobs.mjs              ← job scanner (main daily script)
    apply.mjs             ← process Potential sheet → Applied/Ignored + record training labels
    score.mjs             ← write Match Score (col K) to Potential, sort by score
    train.mjs             ← retrain feedback model from apply/ignore labels (--bootstrap seeds from sheets)
    prune.mjs             ← remove dead links from Potential (HTTP, no browser)
    gmail-sync.mjs        ← Gmail → Sheets status sync
    write-potential.mjs   ← append jobs to Potential (stdin JSON array)
    check-liveness.mjs    ← probe all API endpoints in portals.yml for health
    probe-ats.mjs         ← discover ATS API endpoints for websearch-only companies
    gmail-auth.mjs        ← one-time OAuth setup for Gmail

    # Shared modules (no main(); imported by the above)
    config.mjs            ← single portals.yml loader with consistent defaults
    sheets-client.mjs     ← Google Sheets auth + getColumn/getSheetId/redRowRequest
    filters.mjs           ← isUS, extractMinYOE, buildTitleFilter, yoeLabel, country lists
    ats.mjs               ← Greenhouse/Ashby/Lever/SmartRecruiters URLs + parsers + parseLink
    fetch.mjs             ← fetchJson/fetchResponse with timeout + retry/backoff
    potential-writer.mjs  ← appendToPotential, fetchSeenLinks, buildCheckboxRequest
    ml/
      parser.mjs          ← resume parser (PDF→pdf-parse→Gemini cleanup, or TXT/MD direct)
      scorer.mjs          ← resume×job scoring: MiniLM embeddings, cosine + feedback-model blend
      model.mjs           ← logistic-regression feedback model (train/predict/holdout-eval, data/model.json)
      training-data.mjs   ← labeled apply/ignore store (data/training-data.json, keyed by link)
      descriptions.mjs    ← job-description cache (data/job-descriptions.json, keyed by link)
  test/
    test-all.mjs          ← test suite (node:test, no deps)
    test-ml.mjs           ← standalone ML pipeline test (no Sheets needed)
  portals.yml             ← company list + scan config
  .env                    ← secrets (gitignored)
  service-account.json    ← Google service account (gitignored)
  gmail-credentials.json  ← Gmail OAuth app credentials (gitignored, user-provided)
  gmail-token.json        ← Gmail OAuth token (gitignored, created by gmail-auth.mjs)
  package.json            ← scripts: scan, apply, score, train, prune, probe, gmail, test
```

**Run scripts:** always `node src/<file>.mjs`, never `node <file>.mjs` (flat root is stale).

---

## Reference Docs (load on demand, not by default)

This file covers what's needed every session. For deeper detail, load the relevant doc when the task touches it:

| File | Load when... |
|------|--------------|
| `docs/module-apis.md` | writing/editing code in `src/` and you need exact function signatures |
| `docs/pipeline-scripts.md` | debugging or modifying jobs/apply/score/prune/write-potential/gmail-sync — write flows, filter order, flags |
| `docs/ats-config.md` | adding a company to `portals.yml`, or investigating an "Empty ATS" scan result |
| `docs/common-bugs.md` | something's behaving unexpectedly — checkboxes gone, wrong-row writes, stale prune results |

---

## Google Sheets Architecture

**Spreadsheet ID:** `1yt7LzUNz_wG-HEiRmhmHk826EGeskgBOrk7ABGNV5lY`
**Service account:** `application-bot@application-bot-494504.iam.gserviceaccount.com`

### Sheet tabs — columns and 0-based array indices

**Potential** (raw scan output; user checks ✓ then runs apply):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Applied? (BOOLEAN checkbox) |
| B | B | 1 | Date Found (YYYY-MM-DD) |
| C | C | 2 | Date Posted (YYYY-MM-DD) |
| D | D | 3 | Company |
| E | E | 4 | Role |
| F | F | 5 | Location |
| G | G | 6 | Link (URL) |
| H | H | 7 | YOE label ("New Grad", "2+ YOE", etc.) |
| I | I | 8 | Notes |
| J | J | 9 | Source ("scan" or "websearch") — controls what prune checks |
| K | K | 10 | Match Score (1–10, written by `score.mjs`; blank until scored) |

**Applied** (active applications):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Date Applied (YYYY-MM-DD) |
| B | B | 1 | Company |
| C | C | 2 | Role |
| D | D | 3 | Location |
| E | E | 4 | Link (URL) — used for dedup |
| F | F | 5 | Status (Applied / Interview / Rejected / Offer) |
| G | G | 6 | Notes |

**Ignored** (skipped jobs):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Date Found |
| B | B | 1 | Company |
| C | C | 2 | Role |
| D | D | 3 | Location |
| E | E | 4 | Link (URL) — used for dedup |

### Critical Sheets API behaviors

- **Checkbox cells** return `"TRUE"`/`"FALSE"` strings (not booleans) from `values.get`. `apply.mjs` handles both `"TRUE"` and the legacy `"✓"`.
- **Trailing empty rows** are omitted from `values.get` responses. Intermediate empty rows are included. This makes **column B (Date Found) a reliable row counter**: `(await sheets.spreadsheets.values.get({ range: 'Potential!B2:B' })).data.values.length + 2` = first empty row number. Both `jobs.mjs` and `write-potential.mjs` use this pattern.
- **Always use `values.update` (not `values.append`) when writing to Potential.** `values.append` detects a "table" ending at the last row with a checkbox `FALSE` value (row 1001) and appends below it. `values.update` with an explicit range writes to the correct row.
- **Column A checkbox validation is wiped when `apply.mjs` clears `Potential!A2:K`.** `jobs.mjs` and `write-potential.mjs` re-apply it via `buildCheckboxRequest()` after every append. If checkboxes vanish, see `docs/common-bugs.md` for the restore command.

---

## Job Scanner, Apply, Score, Prune, Gmail Sync

**Daily workflow:** `npm run scan` → review Potential sheet (sorted by Match Score) → check ✓ → `npm run apply`

- `npm run scan` = scan all API companies (`jobs.mjs`) → prune dead links (`prune.mjs`) → score + sort by Match Score (`score.mjs`). One command does the whole intake.
- `npm run apply` — moves checked Potential rows → Applied, unchecked → Ignored, clears Potential. This is also the **feedback loop**: each decision becomes a training label (applied=1/ignored=0) and the scoring model retrains, so future Match Scores learn what you actually apply to.
- `node src/train.mjs` — retrain the feedback model manually; `--bootstrap` seeds labels from historical Applied/Ignored sheets.
- `node src/gmail-sync.mjs` — scans Gmail for application status updates, writes to Applied col F.
- `echo '[...]' | node src/write-potential.mjs` — append websearch results to Potential (used by `/websearch-jobs`, `/scanall`).

**Cost optimization:** `/scanall` and `/websearch-jobs` are token-heavy (95 web searches) — invoke with the cheapest model: `claude --model claude-haiku-4-5-20251001 /scanall`. `prune.mjs`/`score.mjs` are plain Node scripts — run directly, never inside a Claude session.

For write flows, exact filter order, flags, and per-script internals, load `docs/pipeline-scripts.md`.

---

## portals.yml

Company list + scan config (`scan_config`, `title_filter`, `tracked_companies`). `scan_method` values: `greenhouse`, `ashby`, `smartrecruiters`, `lever`, `workday`, `oraclecloud`, `amazon`, `googlecareers`, `applecareers`, `websearch` (skipped by scanner; needs `/websearch-jobs`).

For adding a company, fixing a broken/"Empty ATS" endpoint, or the full scan_method structure, load `docs/ats-config.md`.

---

## Test Suite

```bash
npm test    # runs test/test-all.mjs — pure Node.js (node:test + node:assert), no extra deps
```

**Run tests before committing any change to `src/jobs.mjs`, `src/filters.mjs`, `src/apply.mjs`, `src/gmail-sync.mjs`, `src/ats.mjs`, or `src/potential-writer.mjs`.**

---

## npm Scripts

| Script | Command |
|--------|---------|
| `npm run scan` | `node src/jobs.mjs && node src/prune.mjs && node src/score.mjs` — full intake: scan, prune, score + sort |
| `npm run scan:all` | same but scan uses `--all` (skip recency filter) |
| `npm run scan:dry` | `node src/jobs.mjs --dry-run` — preview only |
| `npm run jobs` | `node src/jobs.mjs` — scan only, no prune/score |
| `npm run jobs:dry` | `node src/jobs.mjs --dry-run` |
| `npm run apply` | `node src/apply.mjs` — dedup, move rows, record labels + retrain model |
| `npm run apply:dry` | `node src/apply.mjs --dry-run` |
| `npm run prune` | `node src/prune.mjs` |
| `npm run prune:dry` | `node src/prune.mjs --dry-run` |
| `npm run score` | `node src/score.mjs` — score Potential rows, write Match Score (col K) |
| `npm run score:dry` | `node src/score.mjs --dry-run` — print ranking, write nothing |
| `npm run train` | `node src/train.mjs` — retrain feedback model from stored labels |
| `npm run train:bootstrap` | `node src/train.mjs --bootstrap` — seed labels from Applied/Ignored sheets, then train |
| `npm run probe` | `node src/probe-ats.mjs` |
| `npm run probe:apply` | `node src/probe-ats.mjs --apply` |
| `npm run gmail` | `node src/gmail-sync.mjs` |
| `npm run gmail:dry` | `node src/gmail-sync.mjs --dry-run` |
| `npm test` | `node test/test-all.mjs` |

---

## Security

- `service-account.json` — gitignored. Key ID `ecc22924b5cc`. Project `application-bot-494504`. Rotate at GCP Console if compromised.
- Old key `2b632b48` was exposed in git history — scrubbed via `git filter-repo` on 2026-05-02, history force-pushed. Anyone with old clones should re-clone.
- `gmail-credentials.json` and `gmail-token.json` — gitignored, never commit.
- `.env` — gitignored. Required vars: `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_PATH`.

---

## Ethical Use

**Never submit without user review.** Fill forms, generate PDFs, draft answers — always stop before clicking Submit/Apply. The user makes the final call.

---

## Offer Verification (MANDATORY)

Never trust WebSearch/WebFetch to verify if a job posting is still active. For individual link verification always use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Footer/navbar only (no JD text) = closed. Title + description + Apply button = active.

**For bulk sheet verification, prefer `node src/prune.mjs` first** — it checks Greenhouse/Ashby/Lever links via API (free, fast, no tokens). Only fall back to Playwright for links prune can't determine (Stripe, Apple, ByteDance, custom portals).

Exception in batch mode (`claude -p`): use WebFetch and mark report with `**Verification:** unconfirmed (batch mode)`.

---

## CI

`.github/workflows/test.yml` runs `node test/test-all.mjs` on every PR to `main`. Tests are pure Node.js, no secrets required — all pure-function unit tests.
