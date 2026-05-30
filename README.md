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

## Install

```bash
git clone https://github.com/S1933/quorum.git
cd quorum
bun install
```

## Configure

```bash
cp quorum.yaml.example quorum.yaml
```

Minimal config shape:

```yaml
version: 1

defaults:
  pipeline: default

providers:
  claude-code-local:
    type: claude-code
    model: claude-opus-4-8

personas:
  security:
    description: Security review
    system: Find security risks in this diff. Be specific and cite lines.

reviewers:
  sec-claude-local:
    persona: security
    provider: claude-code-local

pipelines:
  default:
    parallel: true
    reviewers: [sec-claude-local]
    consensus:
      strategy: overlap-v1
```

For the ready-to-copy starter config, see [`quorum.yaml.example`](quorum.yaml.example).

Set `fileExtensions` on a reviewer to run it only when at least one changed file matches.
Reviewers without `fileExtensions` always run.

```yaml
reviewers:
  backend-claude-local:
    persona: backend-senior
    provider: claude-code-local
    fileExtensions: [go]

  frontend-claude-local:
    persona: frontend-senior
    provider: claude-code-local
    fileExtensions: [ts, tsx]

  arch-claude-local:
    persona: architecture
    provider: claude-code-local
    fileExtensions: [php, go, ts, tsx]
```

Available personas in the example config:

| Persona | Description |
| --- | --- |
| `security` | Adversarial security review |
| `backend-senior` | Senior backend engineering review |
| `frontend-senior` | Senior frontend engineering review |
| `architecture` | Architecture and maintainability review |
| `performance` | Performance and scalability review |

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

# Add with file filter and custom id
bun quorum reviewer add --provider=claude-code --persona=backend-senior --ext=go --id=backend-go-reviewer --pipeline=default

# List all reviewers, providers, personas, and pipelines
bun quorum reviewers

# Install Quorum skill symlinks for AI agents
bun quorum install-skills

# Print a clean JSON review report to stdout
bun quorum review --json

# Equivalent explicit format flag
bun quorum review --format json
```

JSON mode outputs only the JSON to stdout. Use `--report <path>` to write to a file.

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
