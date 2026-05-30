---
"@excitedjs/tm": patch
---

Mark the release bot's version-bump commit with `[skip ci]` so it no longer starts a redundant second round of CI, secret scanning, and the release workflow. The bump commit is pushed with a GitHub App token, which would otherwise re-trigger every `push`-based workflow on a commit that only changes the version and changelog; publishing already runs in the same workflow run as the bump. This changeset also exercises the release → publish pipeline end to end to confirm the change.
