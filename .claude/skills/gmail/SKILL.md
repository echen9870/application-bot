---
name: gmail
description: Sync Gmail inbox for application status updates (offers, interviews, rejections) and write them to Applied sheet
user_invocable: true
args: flags
argument-hint: "[--days N] [--dry-run]"
---

## First-time setup

**One-time only** (if you haven't already):

1. Ensure Gmail API is enabled in GCP Console (project `application-bot-494504`)
2. Create OAuth 2.0 credentials (Desktop app) and save as `gmail-credentials.json`
3. Authorize:
   ```bash
   node src/gmail-auth.mjs
   ```
   Opens browser, approve access, saves `gmail-token.json` (gitignored)

## Run sync

```bash
node src/gmail-sync.mjs {{flags}}
```

**Flags:**
- `--days N` — scan last N days (default: 7)
- `--dry-run` — preview without writing to Applied sheet

**What it does:**
- Searches Gmail for keywords: "application", "interview", "offer", "decision", "assessment", "take-home", etc.
- Classifies emails: Offer > Interview > Rejected (first match wins)
- Matches company name from sender/subject against Applied sheet (normalized: case-insensitive, legal suffixes stripped)
- Updates Applied column F with new status only if it improves (Applied→Rejected→Interview→Offer; Rejected never downgrades)
- Red-formats rows newly marked Rejected

Print the output and summarize:
- How many emails processed
- How many status updates written
- Any companies that couldn't be matched
- Remind user that unmatched emails are silently skipped and won't break the sync
