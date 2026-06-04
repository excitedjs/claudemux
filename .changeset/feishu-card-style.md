---
"claude-channel-feishu": minor
---

Size-adaptive styling for reply cards. Long replies are wrapped in an expanded `collapsible_panel` (blue border) with a tinted header so they read as one foldable surface; short one-liners pass through untouched so they stay light. A table-bearing body is left at top level because a table cannot live inside a `collapsible_panel`. Styling is applied in the channel's send and edit paths over the renderer output, so the shared renderer is unchanged.
