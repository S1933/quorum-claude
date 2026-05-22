---
name: quorum-review
description: Run the configured Quorum review pipeline against the current diff and render the consensus report.
argument-hint: "[pipeline-id] [--base <ref>]"
---

Run `bun run src/cli/index.ts review` against the user's local quorum configuration.

Arguments: `$ARGUMENTS`

Steps:
1. Resolve the repo root (`git rev-parse --show-toplevel`).
2. Invoke `bun run <repo>/src/cli/index.ts review $ARGUMENTS`. If `$ARGUMENTS` starts with a non-flag token, treat it as the pipeline id and pass it as `--pipeline <token>`.
3. Stream stdout/stderr from the CLI as it runs. Do not paraphrase — let the terminal renderer write directly.
4. When the run completes, surface the report path (`.quorum/last-review.md`) and offer to open it.

Failure modes to surface:
- Missing `quorum.yaml`: tell the user where to put it, point at `quorum.yaml.example`.
- Missing env vars (e.g. `OPENROUTER_API_KEY`): cite the variable name and the provider that needs it.
- Empty diff: report that there is nothing to review against the chosen base ref.

This command is a thin shell. All domain logic lives in `src/`.
