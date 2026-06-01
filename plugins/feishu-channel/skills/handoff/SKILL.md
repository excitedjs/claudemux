---
name: handoff
description: Understand and operate Feishu channel ownership handoff between a dispatcher and teammate sessions. Use when the user wants to talk directly to a teammate through the Feishu channel, hand the channel back to the dispatcher, check who currently owns the channel, recover a dead teammate owner, or asks about "飞书 channel 交接 / channel ownership / 交还 dispatcher / 让我和 TM 直接说 / 把 channel 还给 dispatcher".
---

# Feishu channel handoff

The Feishu channel has one global long connection, owned by the daemon. Claude
Code sessions do not own that Feishu WebSocket directly; they connect to the
daemon through proxy MCP transports. The daemon decides which proxy receives
inbound Feishu messages.

## Mental model

There are three separate concepts. Do not merge them:

- **Daemon / WS ownership** — the daemon owns the single Feishu WebSocket.
  Normal Dispatcher/TM sessions should not reason about this layer.
- **Channel delivery ownership** — the daemon records which Claude session
  receives inbound Feishu messages right now. This skill operates this layer.
- **Access policy** — sender/group pairing and allowlist rules. Use the
  `access` skill for that; it is independent of handoff.

Channel delivery ownership is explicit daemon state:

- The Dispatcher is the default owner.
- Ordinary teammate sessions cannot steal ownership.
- The Dispatcher can grant or assign ownership to a live teammate session.
- The current teammate owner can return ownership to the Dispatcher.
- If the owner is offline, inbound messages remain pending instead of being
  silently delivered to a different Claude context.
- If a teammate owner is dead and will not return, the Dispatcher can reclaim.

## Roles

A proxy identifies itself as either:

- `dispatcher` — the coordinator session that can grant, assign, and reclaim
  ownership.
- `session` — an ordinary teammate session.

The daemon trusts the proxy role sent at registration. If status shows no
dispatcher, handoff cannot safely work: relaunch the Dispatcher with the channel
plugin environment that marks it as dispatcher.

## Inspect the current state

Use the MCP tool:

```text
feishu_channel_status({})
```

Read these fields:

- `owner_session_id` — the session that owns channel delivery.
- `dispatcher_session_id` — the current Dispatcher proxy session.
- `granted_session_id` — a teammate session allowed to acquire next, if any.
- `effective_target_session_id` — the live session that will receive messages
  right now; `null` means inbound rows stay pending.
- `lease_epoch` — increments on real ownership transitions. Use it to confirm
  a handoff or return actually happened.
- `sessions` — live proxy sessions. Each carries `sessionId`, `pid`,
  `proxyVersion`, `role`, and a `metadata` bag the proxy self-reported at
  registration. The channel treats `metadata` as opaque string pairs; an
  orchestrator fills well-known keys. A claudemux teammate reports
  `metadata.teammate_name` (its `tm` name) and `metadata.cwd`, so you locate a
  teammate by name without reverse-engineering it from `pid`:

  ```text
  feishu_channel_status().sessions.find(s => s.metadata?.teammate_name === "<name>")
  ```

  The dispatcher's own session has no `teammate_name`; a non-claudemux session
  may carry only `cwd` or an empty bag.

If `owner_session_id` names an offline teammate and
`effective_target_session_id` is `null`, messages are not lost. They stay in
the daemon queue until the owner returns or the Dispatcher reclaims ownership.

## Dispatcher hands the channel to a teammate

Preferred direct transfer — target the teammate by name:

```text
feishu_channel_acquire({ "match": { "teammate_name": "<name>" } })
```

The Dispatcher may also assign an explicit `session_id` from
`feishu_channel_status().sessions`. Pass `session_id` **or** `match`, not both;
`match` selects the live session whose `metadata` equals every given key, and
errors clearly when nothing matches or when more than one does (the message
lists the candidate session ids — pass `session_id` to disambiguate). After the
call, run status again and check:

- `owner_session_id` is the teammate session id.
- `effective_target_session_id` is the same teammate session id.
- `lease_epoch` increased.

Now Feishu inbound messages go to that teammate's Claude context.

## Dispatcher grants a teammate permission to acquire

Use this when the product flow is: "Dispatcher tells the TM to take the
channel", and the TM should perform the final acquire through its own MCP
connection.

Dispatcher (by name, or by an explicit `session_id`):

```text
feishu_channel_grant({ "match": { "teammate_name": "<name>" } })
```

Then instruct that teammate to call:

```text
feishu_channel_acquire({})
```

The grant is single-target. A different teammate cannot use it, and an
ungranted teammate cannot acquire the channel just by calling acquire.

## Teammate returns the channel to Dispatcher

The current teammate owner calls:

```text
feishu_channel_return_to_dispatcher({})
```

Then check status:

- `owner_session_id` equals `dispatcher_session_id`.
- `effective_target_session_id` equals `dispatcher_session_id`, if the
  Dispatcher proxy is live.
- `lease_epoch` increased.

This is the normal "let me talk to Dispatcher again" path.

## Dispatcher recovers a dead owner

If the current owner is a teammate that crashed or will not come back, status
will show `owner_session_id` as that teammate and `effective_target_session_id`
as `null`. The Dispatcher can force recovery:

```text
feishu_channel_reclaim({})
```

Use reclaim only as recovery. For normal cooperative handoff, prefer
`feishu_channel_return_to_dispatcher` from the teammate owner.

## Failure handling

- `no live channel proxy session` — the target session id is not connected.
  Recheck status and use a live id.
- `no live channel proxy matching` — no live session's `metadata` matches the
  `match` selector. Recheck status; the teammate may not be connected, or may be
  an older proxy that reports no `teammate_name`.
- `ambiguous match` — more than one live session matched. The message lists the
  candidate session ids; pass one as `session_id` to disambiguate.
- `pass only one of session_id / match` — supply a single selector, not both.
- `channel ownership was not granted by the dispatcher` — an ordinary teammate
  tried to acquire without a Dispatcher grant. Ask the Dispatcher to grant or
  directly assign.
- `only the dispatcher may ...` — the tool must be run from the Dispatcher
  proxy, not an ordinary teammate.
- `no live dispatcher channel proxy is registered` — return/reclaim cannot
  complete because the daemon does not see a Dispatcher. Relaunch or reconnect
  the Dispatcher first.

## Safety rules

- Never infer ownership from "latest connected session". Use status.
- Never ask an arbitrary teammate to acquire unless the Dispatcher has granted
  it or directly assigned it.
- Do not replay a message manually into a different owner context just because
  the current owner is offline. Leave it pending or have Dispatcher reclaim.
- Treat handoff as routing of future Feishu channel delivery, not as a transfer
  of conversation memory between Claude sessions.
