# Common Bugs & Known Quirks

Load this when something is behaving unexpectedly — checkboxes vanished, writes landed in the wrong row, prune/scan looks broken, etc. — before re-deriving the cause from scratch.

## Google Sheets API gotchas

- **Checkbox cells** return `"TRUE"`/`"FALSE"` strings (not booleans) from `values.get`. `apply.mjs` handles both `"TRUE"` and the legacy `"✓"`. Formula cells (e.g. `=IF(...)`) can return real booleans, so `categorizeRows` coerces via `String(r[0] ?? '')` to handle both safely.
- **Trailing empty rows** are omitted from `values.get` responses; intermediate empty rows are included. This makes **column B (Date Found) a reliable row counter**: `values.length + 2` = first empty row number. Both `jobs.mjs` and `write-potential.mjs` use this pattern.
- **`values.append` writes to the wrong row.** Sheets detects checkbox `FALSE` values as table content, so append lands below row 1001. Always use `values.update` with an explicit range computed from the column B counter.
- **Checkbox validation gets wiped.** `apply.mjs` clears `Potential!A2:T`, which wipes column A data validation. `jobs.mjs` and `write-potential.mjs` re-apply it via `buildCheckboxRequest()` after every append, extending the end row past any overflow (`Math.max(1001, lastWrittenRow + 1)`).

**If checkboxes disappear, restore them:**
```bash
node -e "import('./src/sheets-client.mjs').then(async ({createSheetsClient,getSheetId,SPREADSHEET_ID})=>{const s=createSheetsClient();const id=await getSheetId(s,'Potential');await s.spreadsheets.batchUpdate({spreadsheetId:SPREADSHEET_ID,requestBody:{requests:[{setDataValidation:{range:{sheetId:id,startRowIndex:1,endRowIndex:1001,startColumnIndex:0,endColumnIndex:1},rule:{condition:{type:'BOOLEAN'},showCustomUi:true}}}]}});console.log('done')})"
```

## Pipeline behavior quirks

- **SmartRecruiters rate limiting:** During bulk scans (300+ companies), some SR endpoints return 404 transiently — safe to ignore.
- **`git filter-repo` history loss:** `portals.yml` endpoint additions were lost once in a history rewrite (see Security section in CLAUDE.md). Commit `portals.yml` changes immediately after bulk probe runs.
- **Concurrent Ashby board fetches share one Promise:** `prune.mjs:getBoardIds` caches the in-flight Promise (not the resolved Set), so concurrent workers hitting the same Ashby company share a single fetch instead of racing it.
- **Lever board API false positives — fixed.** Prune hits `api.lever.co/v0/postings/{slug}/{id}` (individual endpoint, 404 = dead) instead of the board listing, which used to leave closed jobs looking alive.
- **Source column drives prune scope.** `jobs.mjs` tags rows `Source = scan`; `write-potential.mjs` tags `Source = websearch`. `prune.mjs` checks both by default (`--websearch-only` restores the old scan-skipping behavior). Don't manually clear column J.
- **write-potential.mjs requires piped stdin** — running it bare prints usage and exits.
- **Feedback model missing or training data lost:** `node src/train.mjs --bootstrap` rebuilds labels from the Applied/Ignored sheets and retrains. Scoring degrades gracefully to pure cosine when `data/model.json` is absent — nothing breaks, scores just lose the learned preference signal.
- For the "Empty ATS" (HTTP 200, 0 jobs) failure mode, see `docs/ats-config.md`.
