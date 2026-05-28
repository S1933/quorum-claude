---
name: quorum-init
description: Create or inspect starter Quorum configuration options for the current project.
argument-hint: "[--provider <type>] [--model <id>] [--personas <ids>] [--force] [--list-providers] [--list-personas]"
allowed-tools: Bash(git rev-parse:*), Bash(command -v:*), Bash(test:*), Bash(bun run:*), Bash(quorum init:*), Bash(cat:*)
---

Create `quorum.yaml` in the user's current project, or list supported init options.

Raw arguments: `$ARGUMENTS`

Steps:
1. Parse the raw arguments into an argv list before running Bash:
   - Supported forms: `--help`, `--provider <type>`, `--model <id>`, `--personas <ids>`, `--force`, `--list-providers`, `--list-personas`.
   - Reject any argument containing shell control or expansion characters: `` ` ``, `$`, `;`, `|`, `&`, `<`, `>`, `(`, `)`, newline, carriage return.
   - Reject quotes and backslashes in argument values; ask the user to rerun with a simpler value.
   - Do not build `INIT_ARGS` as a raw string and do not pass raw `$ARGUMENTS` through Bash, `eval`, `sh -c`, command substitution, or an unquoted variable.
2. If the parsed argv includes `--help`, `--list-providers`, or `--list-personas`, run the corresponding `quorum init` command and return its output without asking setup questions.
3. If the parsed argv does not include `--provider`, do not run Bash yet. First show this provider checklist to the user as the first setup step, and ask them to reply with one or more checked items, numbers, ids, or `all`:
   - [ ] `claude-code`
   - [ ] `openrouter`
   - [ ] `codex-cli`
   - [ ] `continue-dev`
   - [ ] `cursor-agent`
   - [ ] `gemini-cli`
   - [ ] `kilo-code`
   - [ ] `opencode-go`
   - [ ] `ollama`
4. Parse the user's provider reply into a comma-separated provider id list. If they replied with `all`, use every supported provider. Add it to the argv as `--provider <comma-separated-provider-ids>` before continuing.
5. Resolve the target project root with `git rev-parse --show-toplevel`.
6. Keep the command working directory on that target root; do not `cd` into the Quorum plugin repo.
7. If the parsed argv does not include `--personas`, ask the user which personas to enable before running `quorum init`, using checked items, numbers, ids, or `all`. Supported personas:
   - `security`
   - `backend-senior`
   - `architecture`
   - `performance`
8. Parse the user's persona reply into a comma-separated persona id list. If they replied with `all`, use every supported persona. Add it to the argv as `--personas <comma-separated-persona-ids>` before continuing.
9. If a single provider is selected and the parsed argv does not include `--model`, ask the user for the model id before running `quorum init`; if they press Enter or ask for the default, omit `--model` and let the CLI use the provider default. Do not pass `--model` with multiple providers.
10. Resolve the Quorum CLI in this order:
   - If `QUORUM_CLI` is set, use it.
   - Else if `quorum` is on `PATH`, use `quorum`.
   - Else if `../quorum/src/cli/index.ts` exists from the target root, use that path.
   - Else fail with a clear message asking the user to set `QUORUM_CLI=/absolute/path/to/quorum/src/cli/index.ts`.
11. Invoke with each argv token shell-quoted individually. The safe shape is:
   - `bun run "$QUORUM_CLI" init '<arg1>' '<arg2>' --config "$TARGET_ROOT/quorum.yaml"` when using a `.ts` CLI path.
   - `quorum init '<arg1>' '<arg2>' --config "$TARGET_ROOT/quorum.yaml"` when using the installed binary.
   - Omit the quoted argument placeholders when there are no parsed args.
12. Do not overwrite an existing `quorum.yaml` unless the user passed `--force` or explicitly confirms overwriting. If they confirm, rerun with `--force`.
13. After creation, print the exact CLI output and show the generated `quorum.yaml` content in a fenced `yaml` block.

Failure modes to surface:
- Existing `quorum.yaml`: ask whether to overwrite or stop.
- Missing Quorum CLI: ask the user to export `QUORUM_CLI` or install/link the `quorum` binary.
- Missing provider credentials: mention the needed setup, such as `OPENROUTER_API_KEY` for `openrouter`.
- Rejected arguments: explain which argument is unsupported and do not run Bash.
