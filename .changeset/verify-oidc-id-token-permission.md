---
"@excitedjs/tm": patch
---

Trigger a real release run to verify the OIDC publish permission fix end to end. This entry exists solely to exercise the release → publish pipeline after granting `id-token: write` at the workflow level, so a stable version is bumped, pushed, and published via OIDC trusted publishing. It carries no functional or user-facing change.
