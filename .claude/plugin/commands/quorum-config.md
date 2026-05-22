---
name: quorum-config
description: Show the loaded Quorum configuration (env vars redacted).
---

Run `bun run src/cli/index.ts config` and print the JSON output as a fenced code block.

Steps:
1. Resolve the repo root.
2. Invoke `bun run <repo>/src/cli/index.ts config`.
3. Display the output. Secrets are already redacted by the CLI.
4. If the user asks "why is X provider missing?", point at the resolved config path and the `providers:` block.
