# Dispatcher workspace

The `.workspace/` directory next to this dispatcher's `CLAUDE.md` is **this dispatcher only** — personalization, ad-hoc artifacts, and long-term notes that don't belong in AutoMemory or any sibling repo.

Layout (relative to `.workspace/`):

- `profile/persona.md` — how this dispatcher should talk to the user. Imported below.
- `profile/user-profile.md` — who the user is, role, preferences. Imported below.
- `profile/principles.md` — house rules, do's, don'ts. Imported below.
- `notes/` — long-term human-curated local notes; free-form filenames; **not** auto-imported.
- `artifacts/` — dispatcher-generated intermediate output; filenames `<YYYYMMDD>-<slug>.md` so `find -mtime` cleanup is trivial; **not** auto-imported.

When the dispatcher would otherwise write to `/tmp/<topic>.md`, prefer `<dispatcher-dir>/.workspace/artifacts/<YYYYMMDD>-<slug>.md` instead — artifacts survive reboots and stay attached to this dispatcher. Teammate session lookup lives in `tm history`; the workspace does not mirror or replace it.

@profile/persona.md
@profile/user-profile.md
@profile/principles.md
