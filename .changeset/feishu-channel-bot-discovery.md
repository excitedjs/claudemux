---
"claude-channel-feishu": minor
---

feishu-channel: auto-discover peer bots' Open IDs in a group and surface them to the model. Any bot message (passive auto-observe) and the `/introduce` handshake now record peers into a per-app identity map (`open_id → name`, reused across chats) and a per-chat membership store; the `im.chat.member.bot.added_v1` event arms a one-shot baseline that is injected — together with incremental "new bot" deltas and a sender line for peer-bot messages — onto the next delivered mention, committed only after the session notification succeeds. A new `feishu_list_chat_bots` MCP tool lets the model re-query a chat's known bots after compaction. Auto-observe is discovery only: it never widens the access gate, whose trust set remains the `/introduce`-authorized bots.
