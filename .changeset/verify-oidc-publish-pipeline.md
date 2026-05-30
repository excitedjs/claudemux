---
"@excitedjs/tm": patch
---

Trigger a real release run to verify the npm OIDC trusted-publishing fix end to end. This entry exists solely to exercise the release → publish pipeline after dropping `actions/setup-node`'s `registry-url`, so a stable version is bumped, pushed, and published via OIDC trusted publishing. It carries no functional or user-facing change.
