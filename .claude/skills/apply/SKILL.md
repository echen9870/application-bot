---
name: apply
description: Process the Potential sheet — moves checked jobs to Applied, unchecked to Ignored, records training labels + retrains the scoring model, then clears Potential
user_invocable: true
args: flags
argument-hint: "[--dry-run]"
---

Run the apply processor with:

```bash
node src/apply.mjs {{flags}}
```

Print the full output. When done, summarize:
- How many jobs moved to Applied
- How many moved to Ignored
- How many training labels were recorded and whether the feedback model retrained (both happen automatically; failures there don't block apply)
- Remind the user to run /scan to refill Potential if needed
