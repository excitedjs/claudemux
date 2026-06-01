# Component: the `feishu-channel` plugin

`feishu-channel` is a second plugin shipped from this repo: a Claude Code
**channel** for Feishu (飞书). It bridges Feishu events into a running Claude
Code session and replies back, over a long-lived WebSocket — so no public
webhook URL is needed. Its rationale is in
[decision feishu-channel-plugin](/.agents/decisions/feishu-channel-plugin.md) and
[decision feishu-channel-event-registry](/.agents/decisions/feishu-channel-event-registry.md).

## Why it lives here

claudemux orchestrates Claude Code sessions; a *channel* lets a user **reach**
a session from outside the terminal. The two are complementary, so the
Feishu channel ships from the same repo and the same
[`marketplace.json`](/.claude-plugin/marketplace.json) — but as a **separate
plugin**, not as part of the claudemux plugin. They install independently.

## Stack — and why it differs from claudemux

claudemux is Bash. `feishu-channel` is **TypeScript on Node**. The job is a
long-lived WebSocket server plus an MCP server — a persistent networked
process, not a CLI — which is poorly served by Bash. The server runs through
[`tsx`](https://tsx.is), the Node TypeScript runner, so the `src/` modules run
as written, with no build step; the test suite runs on `vitest`.

## How a channel works

The plugin ships an MCP server (declared in
`plugins/feishu-channel/.mcp.json`) that advertises the `claude/channel`
capability. The server:

1. Opens a WebSocket to the Feishu Open Platform (`lark.WSClient`).
2. Receives the events the bot is subscribed to and routes each, by
   `event_type`, to a registered **event handler**.
3. The handler decodes the payload and — for chat messages — applies access
   control.
4. An approved event is forwarded into the Claude Code session as a
   `notifications/claude/channel` notification, rendered as a
   `<channel source="feishu">` block.

Claude replies through MCP tools the server exposes (`reply`, `react`,
`edit_message`), which call the Feishu API. Channels are a Claude Code
research-preview feature (requires Claude Code ≥ 2.1.80).

A delivered chat message is also given a 👀 reaction on Feishu the moment it
reaches the session — a receipt signal for the sender — and the reaction is
cleared automatically when Claude replies into that chat. The `message_id →
reaction_id` map this needs is held in memory in `createChannelCore`, not on
disk. See [decision feishu-channel-received-reaction-indicator](/.agents/decisions/feishu-channel-received-reaction-indicator.md).

## The event registry — the extensibility seam

Event handling is a registry, not a per-event branch in the server. Each
Feishu event type is one `EventHandler` (`src/events.ts`) that declares its
`event_type` and maps a raw payload to a channel delivery. Adding a new event
type is **one handler module under `src/handlers/` plus one registration
line** in `createChannelCore` — the core pipeline and the transport do not
change. Three handlers exist:

- `im.message.receive_v1` — inbound chat messages (`src/handlers/im-message.ts`).
- `drive.notice.comment_add_v1` — document comments and replies
  (`src/handlers/doc-comment.ts`).
- `im.chat.member.bot.added_v1` — the bot was added to a group; arms a one-shot
  peer-bot discovery baseline (`src/handlers/bot-member.ts`). It never delivers
  to the model.

See [decision feishu-channel-event-registry](/.agents/decisions/feishu-channel-event-registry.md)
for the rationale.

## Layout

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (`name: feishu-channel`, own `version`) |
| `.mcp.json` | MCP server declaration — launches the server via `npm run start` |
| `package.json` | Node project; runtime deps `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, `tsx` |
| `src/events.ts` | The `EventHandler` interface and the `EventRegistry` |
| `src/server.ts` | `createChannelCore` — registry dispatch + the outbound tools |
| `src/feishu.ts` | The Feishu transport boundary (event-type agnostic) |
| `src/connection.ts` | Pure log-line builders for the WebSocket connection lifecycle |
| `src/identity-store.ts` | App-wide `open_id → name` map for peer bots (per `appId`, cross-chat) |
| `src/chat-bots-store.ts` | Per-`(appId, chatId)` bot membership + one-shot injection state |
| `src/bot-discovery.ts` | Auto-observe + the baseline/delta context builder with its commit hook |
| `src/handlers/*.ts` | One module per Feishu event type |
| `src/*.ts` | Core logic — access control, content parsing, pairing, … |
| `scripts/configure.ts` | Credential factory — writes `.env`, verifies against Feishu |
| `commands/configure.md` | The `/feishu-channel:configure` slash command |
| `test/*.test.ts` | `vitest` unit tests; input-heavy modules use `fast-check` |
| `test/feishu-live.ts` | Live integration test against the real Feishu platform |
| `skills/` | The `access` skill and the channel ownership `handoff` skill |

The core logic is written as small modules with **no live-Feishu dependency**
so it unit-tests without a running server or connection.

## Foot-guns

- **Node is required** (v22 or later) and is not a claudemux dependency. The
  plugin installs its own dependencies — including its `tsx` TypeScript runner
  — on first channel launch, through the `start` script `.mcp.json` invokes.
- The plugin has its **own** `version` in its own `plugin.json`, bumped
  independently of claudemux. Release intent is declared with a Changesets
  fragment under the package name `claude-channel-feishu` (release surface
  `src/**` in [`.changeset/config.json`](/.changeset/config.json)); the same
  release pipeline aggregates it. See
  [components/repo-tooling.md](/.agents/components/repo-tooling.md).
- `drive.notice.comment_add_v1` is decoded through the Feishu SDK's own
  `normalizeComment` — the authoritative payload reference — and the handler
  fetches the comment text and document title from Feishu, because a comment
  event payload carries only the comment's identifiers. See
  [decision feishu-doc-comment-enrichment](/.agents/decisions/feishu-doc-comment-enrichment.md).
  The comment is fetched with `fileComment.batchQuery`, not the single-comment
  `fileComment.get` — `get` serves only whole-document comments and 404s on a
  comment anchored to a text selection, which is most of them. When a comment
  arrives with an empty body, the endpoint is the thing to check before the
  bot's scopes; see
  [decision feishu-doc-comment-fetch-via-batch-query](/.agents/decisions/feishu-doc-comment-fetch-via-batch-query.md).
- Group messages are gated by `access.json`'s `groupPolicy`, set by
  `/feishu-channel:configure`: `block` (the bot ignores groups), `allowlist`
  (each group authorized as a unit by pairing — decision feishu-channel-group-pairing), or
  `follow-user` (a group message is gated on the sender's `allowFrom` allowlist
  alone, no per-group setup). See
  [decision feishu-channel-group-policy-modes](/.agents/decisions/feishu-channel-group-policy-modes.md).
- The channel connects to Feishu **directly**, not through the session's HTTP
  proxy. `.mcp.json` clears `HTTP_PROXY` / `HTTPS_PROXY` (upper and lower case)
  in the MCP server's environment, so a proxy set for the Claude Code session
  does not apply to this server. The empty `env` values in `.mcp.json` are
  load-bearing — `test/mcp-config.test.ts` fails if they are dropped. See
  [decision feishu-channel-launch-without-session-proxy](/.agents/decisions/feishu-channel-launch-without-session-proxy.md).
- `src/feishu.ts` wires the `WSClient`'s `onError` / `onReconnecting` /
  `onReconnected` callbacks and a startup-grace watchdog, so a failed or
  dropped connection is logged instead of retrying silently. The log wording
  is built by the pure functions in `src/connection.ts`.
- **Peer-bot discovery is observe-driven, and observing never widens the gate.**
  A peer bot's `open_id` is learned passively from any bot message and from
  `/introduce`, recorded into `identity-store` + `chat-bots-store`, and surfaced
  to the model as a one-shot baseline/delta plus a sender line — committed only
  after the session notification succeeds (`ChannelDelivery.commit`, run in
  `createChannelCore`). The access gate's trust set is the `/introduce`-authorized
  bots (`introducedOpenIds`) only; auto-observe writes the discovery set
  (`openIds`) but not that. `im.chat.member.bot.added_v1` carries no added-bot
  `open_id` and reaches only the bot being added, so it can trigger "I joined"
  but cannot enumerate peers — there is no Feishu API to list a group's bots.
  The `feishu_list_chat_bots` MCP tool re-queries the local discovery store
  after compaction. See
  [decision feishu-channel-bot-discovery](/.agents/decisions/feishu-channel-bot-discovery.md).
- **A proxy self-reports an opaque identity `metadata` bag at `register`**, kept
  on `RegisteredSession` and surfaced verbatim in
  `feishu_channel_status().sessions[]`, so a coordinator locates a session by a
  readable key instead of from `pid`. The channel core never interprets a
  metadata key — keys are a convention, not schema, which keeps the wire type
  orchestrator-neutral for a feishu-only install. `deriveProxyMetadata` in
  `src/server.ts` composes two contributors: a neutral `cwd` from
  `CLAUDE_PROJECT_DIR` (a Claude Code standard), and `claudemuxIdentityFromEnv`
  — the single named seam that reads claudemux's `CLAUDEMUX_TEAMMATE_NAME` env
  into `metadata.teammate_name` (best-effort: absent for the dispatcher and for
  non-claudemux sessions, so it adds no dependency on claudemux). The ownership
  tools `feishu_channel_acquire` / `feishu_channel_grant` take a neutral `match`
  selector (subset-equality over `metadata`) resolved in `channel-owner.ts`;
  internal ownership is still stored by opaque `sessionId`.

## See also

- [decisions/feishu-channel-plugin.md](/.agents/decisions/feishu-channel-plugin.md) — why a second plugin, why a separate TypeScript project.
- [decisions/feishu-channel-event-registry.md](/.agents/decisions/feishu-channel-event-registry.md) — the event registry and core design choices.
- [decisions/feishu-channel-received-reaction-indicator.md](/.agents/decisions/feishu-channel-received-reaction-indicator.md) — the received-reaction indicator on inbound chat messages.
- [decisions/feishu-channel-bot-discovery.md](/.agents/decisions/feishu-channel-bot-discovery.md) — auto-discovery of peer bots' Open IDs and one-shot injection.
- [components/repo-tooling.md](/.agents/components/repo-tooling.md) — the CI `feishu-channel` job.
- [root.md](/.agents/root.md) — repo layout.
