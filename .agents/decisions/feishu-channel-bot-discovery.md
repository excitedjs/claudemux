# Feishu channel: peer-bot Open ID auto-discovery

- **Status:** Accepted
- **Date:** 2026-05-31
- **Affects:** `plugins/feishu-channel/`

## Context

In a group, the model only knows another bot's `open_id` if it was told — and
without that id it cannot `<@open_id>` a peer to collaborate. The original
mechanism was the manual `/introduce` command, which recorded mentioned bots
into a single per-`(appId, chatId)` `observed-bots` store that fed the access
gate. Two gaps motivated this change:

- Discovery was manual and one-shot. A bot already talking in the group was
  invisible until someone ran `/introduce`.
- There was no way for the model to recover a peer's `open_id` after its
  context was compacted away.

Three platform facts (verified against open.feishu.cn) bound the design:

1. **A bot sender's `open_id` is already in the realtime event.**
   `im.message.receive_v1` carries `sender.sender_id.open_id` (`ou_…`); the
   `cli_…` app_id only appears in the REST message-history API and in the event
   *header* (the receiving app), never as the sender identity. So surfacing a
   peer's id needs no `cli_ → ou_` mapping.
2. **`im.chat.member.bot.added_v1` is weak.** Its payload carries the operator's
   id and the chat, **not the added bot's `open_id`**, and Feishu delivers it
   only to the bot being added (a bot already in the group is not notified when
   another bot joins). There is also no API to list a group's bot members.
3. **`open_id` is per-app, not per-chat.** Within one app a bot's `open_id` is
   stable across every chat, so identity can be stored once per `appId`.

## Decision

Split the old store into two and drive discovery from observation, not commands:

- **`identity-store.ts`** — `feishu-bot-identity-{appId}.json`, an app-wide
  `open_id → {name, source, firstSeenAt, lastSeenAt, firstSeenChat}` map, reused
  across every chat the app serves (fact 3).
- **`chat-bots-store.ts`** — `feishu-chat-bots-{appId}-{chatId}.json`, per-chat
  membership and one-shot injection state. It keeps **two** member sets:
  `openIds` (everything discovered, feeds discovery) and `introducedOpenIds`
  (only `/introduce`-authorized bots, feeds the gate). This separation is the
  load-bearing decision: **passive observation must never widen who may reach
  the session.**

Discovery sources:

- **auto-observe** (`bot-discovery.observeBotSender`) — any `senderType=bot`
  message in an authorized group records the sender into identity + `openIds`
  (and queues it as a pending new bot), even an ambient message about to be
  dropped by the gate. Discovery only; not `introducedOpenIds`.
- **`/introduce`** — records the mentioned external bots (excluding self) into
  identity + both member sets; the manual backfill for bots auto-observe has
  not seen.
- **`im.chat.member.bot.added_v1`** (`handlers/bot-member.ts`) — used only as a
  "this bot joined chat X" trigger that arms `needsBaselineOnNextMention`; it
  records no identity (fact 2).

Injection (`bot-discovery.buildDiscoveryContext`) is prepended to the next
message the gate **delivers** in that chat: a sender line for a peer-bot
message, a one-shot baseline of known peers on first join, and an incremental
delta for bots discovered since. The builder returns a `commit` callback that
the server (`createChannelCore`) runs **only after `notify` succeeds**
(`ChannelDelivery.commit`) — so a failed delivery does not consume a one-shot
context the model never saw.

`feishu_list_chat_bots(chat_id, include_self?)` is an MCP tool that reads the
local stores so the model can recover peer ids after compaction. It never calls
a Feishu API (fact 2: none exists).

## Consequences

- A freshly joined group's baseline can be empty and fills in as peers speak or
  via `/introduce` — an accepted limitation, since no API enumerates a group's
  bots.
- "A new bot joined while I was here" is discovered only when that bot first
  speaks (auto-observe) or via `/introduce`, never from the join event.
- The access gate's behavior is unchanged: its trust set is still the
  `/introduce`-authorized bots, now read from `chat-bots-store.introducedOpenIds`
  instead of the removed `observed-bots` store.
- File-path builders live in `src/paths.ts` (`botIdentityFile`, `chatBotsFile`);
  the old `observedBotsFile` builder and `observed-bots-store.ts` were removed.

## See also

- [components/feishu-channel.md](/.agents/components/feishu-channel.md) — the component overview.
- [decisions/feishu-channel-event-registry.md](/.agents/decisions/feishu-channel-event-registry.md) — how a new event handler is added.
- [decisions/feishu-channel-group-policy-modes.md](/.agents/decisions/feishu-channel-group-policy-modes.md) — the `groupPolicy` gate the trust set feeds.
