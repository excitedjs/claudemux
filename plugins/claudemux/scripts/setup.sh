#!/usr/bin/env bash
# setup.sh — seed CLAUDE.md, idle dir, and TM_DISPATCHER_DIR for a
# claudemux dispatcher.
#
# The "dispatcher directory" is wherever the user runs `claude` from to drive
# teammates. There's no global registry; the runtime derives it at invocation
# (TM_DISPATCHER_DIR env if set, $PWD fallback for `tm`; each teammate
# session's recorded cwd for the SessionStart hook).
#
# Idempotent steps (in execution order):
#   1. Remove ~/.config/claudemux/config if present (no longer read; the
#      runtime derives the dispatcher dir from env or cwd).
#   2. Copy CLAUDE.md.template to <dispatcher-dir>/CLAUDE.md (skipped if the
#      existing CLAUDE.md already matches). On a customized CLAUDE.md that
#      differs from the template, pass --force to inject only the
#      @.workspace/imports.md marker block at the top; the body is
#      preserved.
#   3. Ensure /tmp/claude-idle/ exists (the directory `tm wait` / `tm send` polls).
#   4. Merge TM_DISPATCHER_DIR=<dispatcher-dir> into the dispatcher root's
#      .claude/settings.json `env` block. Claude Code injects entries from
#      that file as env at every claude launch, so `tm` reads the right
#      dispatcher dir even when the Bash tool's cwd has drifted to a sibling
#      repo. Idempotent: jq merge preserves any other env / setting keys
#      the user already has.
#   5. Seed <dispatcher-dir>/.workspace/ from templates/workspace/: profile
#      stubs (HTML-comment only — inert until edited), imports.md, notes/
#      and artifacts/ with their own README.md. Never overwrites a file
#      that already exists.
#   6. Initialize <dispatcher-dir>/.workspace/ as its own independent git
#      repo and make an initial commit. Skipped if .workspace/.git/ already
#      exists, if git is missing, or if the commit step fails (recovery
#      instructions printed in that case). Completely independent of any
#      git tracking at the dispatcher-dir level.
#   7. Print verification next steps.
#
# Not done here:
#   - Installing hooks. They ship with the plugin (hooks/hooks.json) and
#     follow the plugin's install/uninstall lifecycle.
#   - Starting tmux, claude, or any teammate.
#   - Editing ~/.claude/settings.json. The /claudemux:setup command's Step 2
#     handles Remote Control opt-in.
#   - Checking system dependencies (tmux, jq, claude). Step 0 of the
#     /claudemux:setup command handles those with explicit user prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PLUGIN_ROOT/templates/CLAUDE.md.template"
WORKSPACE_TEMPLATE_DIR="$PLUGIN_ROOT/templates/workspace"
IDLE_DIR="/tmp/claude-idle"
LEGACY_CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/claudemux/config"

force=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) force=1; shift ;;
        -h|--help)
            cat <<EOF
setup.sh — seed CLAUDE.md + idle dir for a claudemux dispatcher.

Usage:
  $(basename "$0") [--force]

Options:
  --force           On a customized CLAUDE.md that differs from the
                    template, inject the @.workspace/imports.md marker
                    block at the top instead of leaving the file alone.
                    The body is preserved; this is additive only.

Paths:
  template          $TEMPLATE
EOF
            exit 0 ;;
        *) echo "setup.sh: unknown flag: $1" >&2; exit 1 ;;
    esac
done

DISPATCHER_DIR="$PWD"
[[ -d "$DISPATCHER_DIR" ]] || { echo "setup.sh: dispatcher dir does not exist: $DISPATCHER_DIR" >&2; exit 1; }
DISPATCHER_DIR="$(cd "$DISPATCHER_DIR" && pwd)"
TARGET_CLAUDE_MD="$DISPATCHER_DIR/CLAUDE.md"

say() { echo "[setup] $*"; }

# Inject the workspace-imports marker block into an existing customized
# CLAUDE.md at the top, preserving everything else. Idempotent: skips if
# the block already exists. Inserts immediately after the first markdown
# heading; if there is no heading at all, appends to end of file.
inject_workspace_imports() {
    local target="$1"
    if grep -qF '<!-- claudemux-workspace-imports:start -->' "$target"; then
        say "$target already has the workspace imports marker — skipping inject"
        return 0
    fi

    local tmp
    tmp=$(mktemp "$target.XXXXXX")
    if awk '
        BEGIN { inserted = 0 }
        !inserted && /^#/ {
            print
            print ""
            print "<!-- claudemux-workspace-imports:start -->"
            print "@.workspace/imports.md"
            print "<!-- claudemux-workspace-imports:end -->"
            inserted = 1
            next
        }
        { print }
        END {
            if (!inserted) {
                print ""
                print "<!-- claudemux-workspace-imports:start -->"
                print "@.workspace/imports.md"
                print "<!-- claudemux-workspace-imports:end -->"
            }
        }
    ' "$target" > "$tmp"; then
        mv "$tmp" "$target"
        say "injected @.workspace/imports.md marker block at the top of $target"
    else
        rm -f "$tmp"
        echo "setup.sh: awk failed while injecting marker block into $target" >&2
        return 1
    fi
}

# Copy a template file only when the destination does not exist. Used
# for the .workspace/ scaffold so re-runs never clobber user edits.
copy_if_absent() {
    local src="$1" dst="$2"
    if [[ -f "$dst" ]]; then
        return 0
    fi
    cp "$src" "$dst"
    say "wrote $dst"
}

# --- 1. silently remove any legacy config file ---
# Older versions wrote ~/.config/claudemux/config with a DEV_DIR= line. The
# runtime no longer reads it; remove so a future operator does not assume it
# is still authoritative.
if [[ -f "$LEGACY_CONFIG_FILE" ]]; then
    rm -f "$LEGACY_CONFIG_FILE"
    say "removed legacy $LEGACY_CONFIG_FILE"
fi

# --- 2. CLAUDE.md ---
if [[ ! -f "$TEMPLATE" ]]; then
    echo "setup.sh: missing template at $TEMPLATE" >&2
    exit 1
fi

if [[ ! -f "$TARGET_CLAUDE_MD" ]]; then
    cp "$TEMPLATE" "$TARGET_CLAUDE_MD"
    say "wrote $TARGET_CLAUDE_MD from template"
elif cmp -s "$TEMPLATE" "$TARGET_CLAUDE_MD"; then
    say "CLAUDE.md already matches template — skipping"
elif [[ $force -eq 1 ]]; then
    # --force on a customized CLAUDE.md: inject the marker block only.
    # The body stays under the user's control; --force no longer
    # overwrites with the template.
    inject_workspace_imports "$TARGET_CLAUDE_MD"
else
    say "CLAUDE.md exists and differs from template — leaving in place"
    say "  pass --force to inject the @.workspace/imports.md marker block at the top (body untouched)"
    say "  diff: diff $TARGET_CLAUDE_MD $TEMPLATE"
fi

# Detect whether CLAUDE.md actually contains the workspace-imports marker.
# This single boolean flows through to Step 1.5 of the slash command and
# to the final report — it lets both UIs distinguish "workspace scaffolded
# AND imported into context" from "workspace scaffolded but NOT yet
# active until --force injects the marker". Without this gate, a legacy
# CLAUDE.md user would see a setup that claims their personalization is
# active when it is silently inert.
if [[ -f "$TARGET_CLAUDE_MD" ]] && grep -qF '<!-- claudemux-workspace-imports:start -->' "$TARGET_CLAUDE_MD"; then
    workspace_imports_active=1
    say "workspace imports: active (CLAUDE.md contains the marker block)"
else
    workspace_imports_active=0
    say "workspace imports: inactive (CLAUDE.md is missing the marker block — run with --force to inject)"
fi

# --- 3. idle dir ---
mkdir -p "$IDLE_DIR"
say "ensured $IDLE_DIR exists"

# --- 4. write TM_DISPATCHER_DIR into <dispatcher-dir>/.claude/settings.json ---
# Claude Code reads project-root .claude/settings.json on launch and injects
# its `env` block into the spawned claude process. Setting TM_DISPATCHER_DIR
# there means `tm` reads the correct dispatcher dir even when the dispatcher's
# Bash tool has `cd`ed into a sibling repo (Bash tool persists cwd across
# calls; without the env override, tm would resolve repo paths and the
# AutoMemory ledger relative to that drifted cwd).
#
# Idempotency: jq merges the key into any existing `.env` object, preserving
# all other keys (other env vars, hooks, permissions, anything else the user
# has in settings.json). The temp file + mv pattern keeps the write atomic so
# a SIGINT mid-write can't corrupt the file.
SETTINGS_DIR="$DISPATCHER_DIR/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
mkdir -p "$SETTINGS_DIR"

# `mktemp <target>.XXXXXX` keeps the temp file on the SAME filesystem as
# the target — guarantees the subsequent `mv` is an atomic inode rename,
# not a cross-FS copy+unlink. Default `mktemp` lands in $TMPDIR (often a
# different filesystem on macOS) and would silently degrade the
# atomicity claim. Apply to both branches so SIGINT or jq failure
# mid-write can't leave a half-written settings.json.
if [[ -f "$SETTINGS_FILE" ]]; then
    existing_val=$(jq -r '.env.TM_DISPATCHER_DIR // ""' "$SETTINGS_FILE" 2>/dev/null || echo "")
    if [[ "$existing_val" == "$DISPATCHER_DIR" ]]; then
        say "$SETTINGS_FILE already has TM_DISPATCHER_DIR=$DISPATCHER_DIR — skipping"
    else
        tmp=$(mktemp "$SETTINGS_FILE.XXXXXX")
        if jq --arg v "$DISPATCHER_DIR" \
              '.env = ((.env // {}) + {TM_DISPATCHER_DIR: $v})' \
              "$SETTINGS_FILE" > "$tmp"; then
            mv "$tmp" "$SETTINGS_FILE"
            if [[ -n "$existing_val" ]]; then
                say "updated TM_DISPATCHER_DIR in $SETTINGS_FILE ($existing_val -> $DISPATCHER_DIR)"
            else
                say "merged TM_DISPATCHER_DIR=$DISPATCHER_DIR into $SETTINGS_FILE (other keys preserved)"
            fi
        else
            rm -f "$tmp"
            echo "setup.sh: failed to update $SETTINGS_FILE (is it valid JSON? run 'jq . $SETTINGS_FILE' to check)" >&2
            exit 1
        fi
    fi
else
    tmp=$(mktemp "$SETTINGS_FILE.XXXXXX")
    if jq -n --arg v "$DISPATCHER_DIR" '{env: {TM_DISPATCHER_DIR: $v}}' > "$tmp"; then
        mv "$tmp" "$SETTINGS_FILE"
        say "wrote $SETTINGS_FILE with TM_DISPATCHER_DIR=$DISPATCHER_DIR"
    else
        rm -f "$tmp"
        echo "setup.sh: failed to write $SETTINGS_FILE" >&2
        exit 1
    fi
fi

# --- 5. .workspace/ scaffold ---
# Seed dispatcher-dir/.workspace/ from templates/workspace/. Setup is
# intentionally additive: copy_if_absent never overwrites a file that
# already exists, so users keep edits across re-runs.
#
# Symlink guard: if .workspace/ is a symlink, refuse to seed or git init.
# The design contract is that <dispatcher-dir>/.workspace/.git/ lives
# *inside* the dispatcher directory; following the symlink would init a
# git repo at the link target (possibly anywhere on the filesystem),
# violating that contract.
WORKSPACE_DIR="$DISPATCHER_DIR/.workspace"
workspace_skipped=0
if [[ -L "$WORKSPACE_DIR" ]]; then
    workspace_skipped=1
    sym_target=$(readlink "$WORKSPACE_DIR")
    say "$WORKSPACE_DIR is a symlink (-> $sym_target) — refusing to seed scaffold or git init"
    say "  the workspace owns its own .git/ at <dispatcher-dir>/.workspace/.git/;"
    say "  following the symlink would init a git repo outside the dispatcher dir."
    say "  fix:  rm \"$WORKSPACE_DIR\"  # then re-run setup for a fresh local .workspace/"
else
    mkdir -p "$WORKSPACE_DIR/profile" "$WORKSPACE_DIR/notes" "$WORKSPACE_DIR/artifacts"

    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/README.md"               "$WORKSPACE_DIR/README.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/imports.md"              "$WORKSPACE_DIR/imports.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/profile/persona.md"      "$WORKSPACE_DIR/profile/persona.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/profile/user-profile.md" "$WORKSPACE_DIR/profile/user-profile.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/profile/principles.md"   "$WORKSPACE_DIR/profile/principles.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/notes/README.md"         "$WORKSPACE_DIR/notes/README.md"
    copy_if_absent "$WORKSPACE_TEMPLATE_DIR/artifacts/README.md"     "$WORKSPACE_DIR/artifacts/README.md"
    say "ensured $WORKSPACE_DIR/ exists with profile / notes / artifacts subdirs"
fi

# --- 6. .workspace/ git archive ---
# Initialize .workspace/ as its own independent git repo and make an
# initial commit. This lets the user track personalization and artifact
# history scoped to this dispatcher, completely independent of any git
# tracking at the dispatcher-dir level (a dispatcher dir is typically a
# parent of many sibling repos and not itself a git working tree).
#
# Skips gracefully when:
#   - .workspace/.git/ already exists (re-run)
#   - git is not installed
#   - git init succeeds but the initial commit fails (most often: no
#     user.email / user.name configured, or GPG signing prompt with no
#     TTY). We leave the .git/ in place and print recovery instructions.
if [[ $workspace_skipped -eq 1 ]]; then
    say "skipped .workspace/ git init (symlink)"
elif [[ -d "$WORKSPACE_DIR/.git" ]]; then
    say "$WORKSPACE_DIR/ is already a git repo — skipping git init"
elif ! command -v git >/dev/null 2>&1; then
    say "git is not installed — skipping .workspace/ git init"
    say "  (install git later, then: cd \"$WORKSPACE_DIR\" && git init && git add . && git commit -m 'initial workspace scaffold')"
else
    if git -C "$WORKSPACE_DIR" init -q 2>/dev/null; then
        git -C "$WORKSPACE_DIR" add . >/dev/null 2>&1 || true
        # Wrap the commit in `if` so set -e does not fire on a non-zero
        # commit exit (a plain `var=$(cmd)` assignment with set -e exits
        # the script if cmd fails — using `if var=$(cmd); then` consumes
        # the exit status as the if-condition instead). The capture also
        # gives us git's actual stderr to surface on failure.
        if commit_out=$(git -C "$WORKSPACE_DIR" commit -m "initial workspace scaffold" 2>&1); then
            say "initialized $WORKSPACE_DIR/ as a git repo and committed the scaffold"
        else
            say "git init OK in $WORKSPACE_DIR/, but the initial commit failed"
            if [[ -n "$commit_out" ]]; then
                printf '%s\n' "$commit_out" | sed 's/^/  git: /'
            fi
            say "  most likely cause: git user.email / user.name not configured, or GPG signing prompt with no TTY."
            say "  fix:  cd \"$WORKSPACE_DIR\" && git add . && git commit -m 'initial workspace scaffold'"
        fi
    else
        say "git init failed in $WORKSPACE_DIR/ — skipping"
    fi
fi

# --- 7. report ---
# Build the workspace bullet conditionally so the report reflects the
# real state — three branches: symlink (skipped), seeded-and-active
# (imports work), seeded-but-inactive (imports inert until --force).
if [[ $workspace_skipped -eq 1 ]]; then
    workspace_note="  * \`.workspace/\` is a symlink — setup did NOT seed or git-init it. Resolve
    the symlink (rm $WORKSPACE_DIR) and re-run setup for a local workspace, or
    manage the link target directory by hand."
elif [[ $workspace_imports_active -eq 1 ]]; then
    workspace_note="  * \`.workspace/\` at $WORKSPACE_DIR holds this dispatcher's persona /
    user / principles profile (HTML-comment stubs until you edit them),
    \`notes/\` for hand-curated content, and \`artifacts/\` for
    dispatcher-generated intermediate output. The three profile files
    are imported into every dispatcher session via .workspace/imports.md.
    \`.workspace/\` is its own git repo, independent of any git activity
    at the dispatcher-dir level."
else
    workspace_note="  * \`.workspace/\` at $WORKSPACE_DIR is seeded with stubs, but the
    imports are NOT YET ACTIVE: your customized CLAUDE.md is missing the
    @.workspace/imports.md marker block, so editing the profile stubs
    would have no effect on dispatcher sessions. Re-run setup with
    --force to inject the marker into your CLAUDE.md (body preserved);
    the personalization workflow becomes live on the next dispatcher
    session after that."
fi

cat <<EOF

[setup] done.

Verify by starting a dispatcher session:
  1. From a regular shell, open a tmux session whose cwd is the dispatcher dir:
       tmux new-session -s dispatcher -c "$DISPATCHER_DIR"
  2. Inside that pane, launch Claude Code:
       claude
  3. Once Claude is at the prompt, spawn a teammate against a sibling repo:
       tm spawn <repo>      # <repo> is a direct subdirectory of $DISPATCHER_DIR
  4. Send a prompt; the reply lands on stdout (tm send is sync round-trip):
       tm send <repo> --prompt 'echo hello'
     You should see the teammate's text reply within a minute.

Notes:
  * \`tm\` is on PATH automatically (Claude Code prepends each installed
    plugin's bin/ directory).
  * \`tm\` reads the dispatcher dir from TM_DISPATCHER_DIR (now written to
    $SETTINGS_FILE) and falls back to \$PWD if that env is unset. The env
    is what protects \`tm\` from Bash-tool cwd drift — sanity-check with
    \`tm doctor\` from inside the dispatcher claude session.
  * The Stop hook touches /tmp/claude-idle/<sid> for every Claude Code
    session, including the dispatcher itself. Nothing waits on that signal.
  * Teammate session lookup lives in tm history. AutoMemory remains
    Claude-owned and is not managed by this script.
$workspace_note
EOF
