---
"@excitedjs/tm": patch
---

Fix the release pipeline so prerelease versions publish to npm under their channel dist-tag. The publish step now passes `--tag <channel>` (e.g. `--tag beta`) for a prerelease version — npm refuses a tagless prerelease publish — while a stable version stays tagless so npm applies `latest`. The tag is derived from the version itself, so a stable `main` release can never carry a prerelease tag. This unblocks publishing the `3.0.0-beta` line.
