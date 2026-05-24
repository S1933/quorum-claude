---
name: quorum-init
description: Create a starter Quorum configuration for the current project.
argument-hint: "[--provider <type>] [--model <id>] [--personas <ids>] [--force]"
allowed-tools: Bash(git rev-parse:*), Bash(command -v:*), Bash(test:*), Bash(bun run:*), Bash(quorum init:*), Bash(cat:*)
---

Create `quorum.yaml` in the user's current project.

Arguments: `$ARGUMENTS`

Steps:
1. Resolve the target project root with `git rev-parse --show-toplevel`.
2. Keep the command working directory on that target root; do not `cd` into the Quorum plugin repo.
3. Build `INIT_ARGS` from `$ARGUMENTS`.
4. If `INIT_ARGS` does not include `--provider`, ask the user which provider to use before running commands, then add `--provider <type>` to `INIT_ARGS`. Supported providers:
   - `claude-code`
   - `openrouter`
   - `codex-cli`
   - `continue-dev`
   - `cursor-agent`
   - `gemini-cli`
   - `kilo-code`
   - `opencode-go`
   - `ollama`
5. If `INIT_ARGS` does not include `--personas`, ask which personas to enable, then add `--personas <comma-separated-ids>` to `INIT_ARGS`. Supported personas:
   - `security`
   - `backend-senior`
   - `architecture`
   - `performance`
6. If the user does not choose a model, omit `--model` and let Quorum use the provider default.
7. Resolve the Quorum CLI in this order:
   - If `QUORUM_CLI` is set, use it.
   - Else if `quorum` is on `PATH`, use `quorum`.
   - Else if `../quorum/src/cli/index.ts` exists from the target root, use that path.
   - Else fail with a clear message asking the user to set `QUORUM_CLI=/absolute/path/to/quorum/src/cli/index.ts`.
8. Invoke:
   - `bun run "$QUORUM_CLI" init $INIT_ARGS --config "$TARGET_ROOT/quorum.yaml"` when using a `.ts` CLI path.
   - `quorum init $INIT_ARGS --config "$TARGET_ROOT/quorum.yaml"` when using the installed binary.
9. Do not overwrite an existing `quorum.yaml` unless the user passed `--force` or explicitly confirms overwriting. If they confirm, rerun with `--force`.
10. After creation, print the exact CLI output and show the generated `quorum.yaml` content in a fenced `yaml` block.

Failure modes to surface:
- Existing `quorum.yaml`: ask whether to overwrite or stop.
- Missing Quorum CLI: ask the user to export `QUORUM_CLI` or install/link the `quorum` binary.
- Missing provider credentials: mention the needed setup, such as `OPENROUTER_API_KEY` for `openrouter`.
