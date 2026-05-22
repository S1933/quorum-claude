---
name: quorum-agent
description: Delegate an open-ended task to the default Quorum agent provider and stream the result.
argument-hint: "<task instruction>"
---

Run `bun run src/cli/index.ts agent "$ARGUMENTS"`.

Steps:
1. If `$ARGUMENTS` is empty, ask the user what task to run before invoking the CLI.
2. Resolve the repo root.
3. Invoke `bun run <repo>/src/cli/index.ts agent "$ARGUMENTS"`. Forward `--provider <id>` if the user prefixed an arg of the form `provider=<id>`.
4. Stream the agent output to the user. Surface usage tokens from stderr verbatim if printed.

This is a thin adapter. Do not reinterpret or rewrite the agent's reply.
