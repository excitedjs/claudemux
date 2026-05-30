---
"@excitedjs/tm": patch
---

Add a `repository` field to the package manifest so npm provenance verification passes. npm checks the published `package.json`'s `repository.url` against the source repository recorded in the OIDC provenance statement; with no field it reads as empty and the publish is rejected with E422. The manifest now points at `git+https://github.com/excitedjs/claudemux.git` with `directory: plugins/claudemux` for the monorepo layout, matching the provenance source URL.
