# Quorum

![Quorum Workflow](docs/assets/quorum-workflow.png)

[![CI](https://github.com/S1933/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/S1933/quorum/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Provider-agnostic consensus review for AI-assisted code changes.

Quorum runs multiple AI reviewers on a git diff and highlights findings they agree on.
Works as a Bun CLI.

## Features

- Multi-reviewer consensus on the same git diff, with findings grouped by file, line, and category.
- Provider-agnostic execution across APIs, local models, and agent CLIs.
- YAML-defined personas, reviewer overrides, file filters, and parallel or sequential pipelines.
- Terminal progress plus Markdown/JSON reports, available from the CLI.

## Supported Providers

| Status | Provider | Type |
|---|---|---|
| 🟢 → | OpenRouter | `openrouter` |
| 🟢 → | Claude Code | `claude-code` |
| 🟢 → | Codex CLI | `codex-cli` |
| 🟢 → | Continue.dev | `continue-dev` |
| 🟢 → | Cursor Agent CLI | `cursor-agent` |
| 🟢 → | Gemini CLI | `gemini-cli` |
| 🟢 → | Kilo Code CLI | `kilo-code` |
| 🟢 → | OpenCode Go | `opencode-go` |
| 🟢 → | Ollama | `ollama` |

## Requirements

- [Bun](https://bun.sh) `>= 1.1`

## Quick Start

```bash
git clone https://github.com/S1933/quorum.git
cd quorum
bun install

# Add your first reviewer (run this in your project directory)
bun quorum reviewer add --provider=openrouter --persona=security --model=claude-opus-4
```

## Use The CLI

```bash
# Review current changes against the default branch
bun quorum review

# Run a named pipeline
bun quorum review consensus-security

# Same, explicit flag
bun quorum review --pipeline consensus-security

# Add a reviewer to your config
bun quorum reviewer add --provider=openrouter --persona=security --model=claude-opus-4

# Add with file filter, custom id, and target pipeline
bun quorum reviewer add \
  --provider=claude-code \
  --persona=backend-senior \
  --ext=go \
  --id=backend-go-reviewer \
  --pipeline=default

# List all reviewers, providers, personas, and pipelines
bun quorum reviewers
```

JSON mode: `bun quorum review --json`. Use `--report <path>` to write to a file.

## Consensus

V1 ships `overlap-v1`.

Findings are grouped when they share the same file, line range (±2 lines), and category.
Categories: `security`, `performance`, `architecture`, `correctness`, `style`.
Multiple reviewers get an agreement badge. Single-reviewer findings are reported separately.

Example:

- Reviewer A: `src/auth.ts:42`, `security`
- Reviewer B: `src/auth.ts:43`, `security`
- Result: one agreement group, `2 reviewers agreed`
- Reviewer C: `src/db.ts:10`, `performance`
- Result: one single-reviewer finding

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deeper design notes.
