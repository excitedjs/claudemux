---
"@excitedjs/tm": major
---

Replace the manual dispatcher Markdown ledger with the `tm history` query surface: `tm history` is now flag-only JSON by default, lifecycle verbs record forward session and close metadata, `tm resume` can recover sessions by repo and id, `tm kill --status` records close status, and the removed `tm archive` and legacy `tm history <name>` contracts no longer operate.
