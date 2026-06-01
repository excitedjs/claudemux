---
"@excitedjs/tm": minor
---

`tm spawn`: opt-in per-dispatcher prompt preamble. When `<dispatcherDir>/.tm-preamble.json` exists, a fresh `tm spawn --prompt` prepends the entry matching the resolved repo path (else a dispatcher-wide `default`) to the operator's prompt, so a standing first-turn reminder no longer has to be hand-pasted into every dispatch. Profile keys are matched after resolving symlinks. A missing file is a no-op, a malformed file fails the spawn loudly, and `--no-preamble` opts a single spawn out.
