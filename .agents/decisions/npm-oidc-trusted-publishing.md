# npm publishing uses OIDC trusted publishing, with three configuration preconditions

- **Status:** Accepted
- **Date:** 2026-05-30
- **Affects:** repo tooling — `.github/workflows/claudemux-release.yml`, `plugins/claudemux/package.json`

## Context

The `tm` CLI is published to npm as `@excitedjs/tm` from the `publish` job in
`claudemux-release.yml`. The job uses **OIDC trusted publishing**: npm exchanges
the GitHub Actions OIDC token for a short-lived publish token, so no long-lived
npm token is stored as a repository secret.

Trusted publishing has several independent preconditions. A failure in any one
surfaces as a *generic* npm registry error (`E404`, `ENEEDAUTH`, `E422`) rather
than a precise diagnostic, so each looks unrelated until traced. Bringing the
first CI publish online peeled back three such failures in sequence, each fixed
by a separate PR; only after all three did `@excitedjs/tm@1.3.1` publish (the
first successful CI publish since the package's `1.1.0` bootstrap, which had
been pushed manually outside CI).

## Decision

The `publish` job is configured to satisfy every trusted-publishing
precondition at once:

1. **No `registry-url` on `actions/setup-node` in the publish job.** Pin the
   registry on the publish command instead: `npm publish --registry=https://registry.npmjs.org`.
2. **`id-token: write` granted at the workflow-level `permissions` block**, not
   only on the publish job. The publish job keeps its own
   `permissions: { contents: read, id-token: write }`; the release job has its
   own `permissions: { contents: write }` so it does not inherit an unused
   OIDC scope.
3. **`repository` field present in `plugins/claudemux/package.json`**, pointing
   at the source repo with a monorepo `directory`:

   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/excitedjs/claudemux.git",
     "directory": "plugins/claudemux"
   }
   ```

A fourth precondition lives outside the repo and cannot be set in code: the npm
package must list this workflow as a **trusted publisher** on npmjs.com
(owner `excitedjs`, repo `claudemux`, workflow `claudemux-release.yml`). It was
already configured — confirmed once the in-repo preconditions were met and OIDC
auth began succeeding.

## Consequences

The three in-repo preconditions are foot-guns: each is a one-line change that a
future edit could plausibly undo (re-adding `registry-url` for "explicitness",
moving `id-token` to only the job level, dropping the `repository` field), and
each undo silently breaks publishing with a different misleading error. They are
recorded here with the locating evidence so the next failure is diagnosed in
minutes, not hours.

### Pitfall 1 — `registry-url` injects a placeholder token that shadows OIDC → `E404`

- **Symptom:** provenance signing **succeeds** (statement published to the
  sigstore transparency log), then the registry write fails:
  `npm error code E404` / `404 Not Found - PUT https://registry.npmjs.org/@excitedjs%2ftm`
  / "could not be found or you do not have permission".
- **Root cause:** `actions/setup-node` with `registry-url:` writes an `.npmrc`
  (via `NPM_CONFIG_USERCONFIG`) containing `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`
  and exports a placeholder `NODE_AUTH_TOKEN`. npm reads that placeholder as
  credentials and therefore never runs the tokenless OIDC handshake; it PUTs
  with the garbage token, the registry treats the request as unauthorized, and
  for a scoped package returns a misleading `404`.
- **Fix:** remove `registry-url` from the publish job's `setup-node` (this drops
  both the `.npmrc` auth line and the placeholder token), and pin the registry
  on the publish command with `--registry=https://registry.npmjs.org`.
- **Locating evidence:** run `26690165482`. The publish step env shows
  `NODE_AUTH_TOKEN: XXXXX-XXXXX-XXXXX-XXXXX` and `NPM_CONFIG_USERCONFIG=…/.npmrc`.
  Direct proof of the source: in the same run, `NODE_AUTH_TOKEN` appears in the
  `publish` job's step envs (it has `registry-url`) but **0 times** in the
  `release` job's (it does not).
- Fixed in PR #7.

### Pitfall 2 — workflow-level `permissions` omits `id-token`, capping the job → `ENEEDAUTH`

- **Symptom:** `npm error code ENEEDAUTH` / "need auth … This command requires
  you to be logged in … `npm adduser`". Provenance signing does **not** start at
  all (no sigstore line) — there is no OIDC token to sign with.
- **Root cause:** the publish job declared `permissions: { contents: read, id-token: write }`,
  but the **workflow-level** `permissions` block listed only `contents: write`.
  The workflow-level block bounds what each job may hold: a job can narrow a
  scope but cannot add one the workflow level leaves out, so `id-token` stayed
  `none` at run time and no OIDC token was minted.
- **Fix:** add `id-token: write` to the workflow-level `permissions`. Keep the
  publish job's block; give the release job an explicit
  `permissions: { contents: write }` to confine the OIDC scope to the one job
  that needs it.
- **Locating evidence:** run `26691379807`. The publish job's
  "Set up job → GITHUB_TOKEN Permissions" group shows only `Contents: read` /
  `Metadata: read` — no `id-token` — despite the job-level declaration. The
  release job (no job-level block) shows `Contents: write` (the workflow-level
  value). The repo's `default_workflow_permissions` was already `write`, ruling
  out the repo default as the cap. Decisive tell: the same job-level block's
  `contents: read` *was* applied while its `id-token: write` was dropped — only
  a scope the workflow level omits gets dropped.
- Fixed in PR #8.

### Pitfall 3 — missing `repository` field fails provenance verification → `E422`

- **Symptom:** OIDC auth now fully works (provenance signed, transparency log
  written), and the publish fails only at verification:
  `npm error code E422` / "Error verifying sigstore provenance bundle: Failed
  to validate repository information: package.json: \"repository.url\" is \"\",
  expected to match \"https://github.com/excitedjs/claudemux\" from provenance".
- **Root cause:** `plugins/claudemux/package.json` had no `repository` field.
  With `--provenance`, npm verifies the published manifest's `repository.url`
  against the source repository recorded in the OIDC provenance statement; a
  missing field normalizes to `""` and fails the match.
- **Fix:** add the `repository` field shown in the Decision above. The
  `git+https://…/claudemux.git` URL normalizes to the provenance source URL;
  `directory` marks the package's subpath in the monorepo.
- **Locating evidence:** run `26691978303`. The publish step logs
  "Signed provenance statement …" and "Provenance statement published to
  transparency log", then `E422 … "repository.url" is ""`.
- Fixed in PR #9.

## References

- `/.github/workflows/claudemux-release.yml` — the `publish` job and the
  workflow-level `permissions` block.
- `/plugins/claudemux/package.json` — the `repository` field.
- [decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md) — the release pipeline this publish job is part of.
- [components/repo-tooling.md](/.agents/components/repo-tooling.md) — release tooling overview.
- PRs #7, #8, #9; failing runs `26690165482` (E404), `26691379807` (ENEEDAUTH), `26691978303` (E422).
