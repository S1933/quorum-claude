---
name: quorum-config
description: Show the loaded Quorum configuration
argument-hint: ""
allowed-tools: Bash(git rev-parse:*), Bash(command -v:*), Bash(test:*), Bash(bun run:*), Bash(cat:*), Read, Edit, MultiEdit
---

Show the Quorum config. Deprecated — use `bun quorum reviewers` instead.

Raw arguments: `$ARGUMENTS`

Steps:
1. Resolve the target project root with `git rev-parse --show-toplevel`.
2. Keep the command working directory on that target root; do not `cd` into the Quorum plugin repo.
3. Resolve the Quorum CLI in this order:
   - If `QUORUM_CLI` is set, use it.
   - Else if `quorum` is on `PATH`, use `quorum`.
   - Else if `../quorum/src/cli/index.ts` exists from the target root, use that path.
   - Else fail with a clear message asking the user to set `QUORUM_CLI=/absolute/path/to/quorum/src/cli/index.ts`.
4. Invoke `bun quorum reviewers --config "$TARGET_ROOT/quorum.yaml"`.
5. Display the output. Secrets are already redacted by the CLI.