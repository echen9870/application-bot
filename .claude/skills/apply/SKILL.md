---
name: apply
description: Process the Potential sheet — moves checked jobs to Applied, unchecked to Ignored, then clears Potential
user_invocable: true
args: flags
argument-hint: "[--dry-run]"
---

Run the apply processor with:

```bash
node apply.mjs {{flags}}
```

Print the full output. When done, summarize:
- How many jobs moved to Applied
- How many moved to Ignored
- Remind the user to run /scan to refill Potential if needed
