# Quorum

[![CI](https://github.com/S1933/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/S1933/quorum/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-6b46c1)](#claude-code-plugin)

Provider-agnostic consensus review for AI-assisted code changes.

Quorum runs several AI reviewers on the same git diff, compares their findings, then highlights issues multiple reviewers agree on. It can run as a Bun CLI or as a Claude Code plugin.

## How It Works

```text
git diff + quorum.yaml
        |
        v
review pipeline
        |
        v
reviewers + providers
        |
        v
structured findings
        |
        v
consensus report
```

## Features

- Portable personas independent from provider choice
- Parallel or sequential review pipelines
- YAML config with `env:VAR` and `${VAR}` secret interpolation
- Consensus grouping by file, line range, and category
- Terminal output and Markdown report rendering
- Machine-readable JSON output for scripts, CI, and editor integrations
- Claude Code slash commands

## Supported Providers

| Status | Provider | Type |
|---|---|---|
| 🟢 → | OpenRouter | `openrouter` |
| 🟢 → | Claude Code | `claude-code` |
| 🟢 → | Codex CLI | `codex-cli` |
| 🟢 → | Continue.dev | `continue-dev` |
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
    model: claude-opus-4-7

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

## Use The CLI

```bash
# Review current changes against the default branch
bun quorum review

# Run a named pipeline
bun quorum review consensus-security

# Same, explicit flag
bun quorum review --pipeline consensus-security

# Print loaded config with secrets redacted
bun quorum config

# Print a clean JSON review report to stdout
bun quorum review --json

# Equivalent explicit format flag
bun quorum review --format json
```

In JSON mode, stdout contains only the JSON document. Pass `--report <path>` to write the same JSON document to a file.

## Claude Code Plugin

Install from the Claude Code plugin marketplace:

```bash
claude plugin marketplace add S1933/quorum
claude plugin install quorum@quorum-plugins
```

Available slash commands:

| Command | Purpose |
|---|---|
| `/quorum-review` | Run the default review pipeline on the current diff |
| `/quorum-review <pipeline>` | Run a named pipeline |
| `/quorum-config` | Show loaded config with secrets redacted |
| `/quorum-init` | Create a starter `quorum.yaml` for the current project |

For local plugin development:

```bash
claude --plugin-dir ./plugin
```

Then run `/quorum:quorum-review` or `/quorum:quorum-config` in Claude Code.

## Consensus

V1 ships `overlap-v1`.

Findings are grouped when they share:

- same file path
- overlapping line range, with a two-line tolerance
- same category: `security`, `performance`, `architecture`, `correctness`, or `style`

Groups with multiple reviewers get an agreement badge. Single-reviewer findings are still reported separately.

Example:

- Reviewer A: `src/auth.ts:42`, `security`
- Reviewer B: `src/auth.ts:43`, `security`
- Result: one agreement group, `2 reviewers agreed`
- Reviewer C: `src/db.ts:10`, `performance`
- Result: one single-reviewer finding

## Roadmap

- Harden packaging and installation for the standalone `quorum` binary
- Add a CI-native review command with predictable exit-code policy and PR annotation support
- Improve provider diagnostics for missing binaries, bad credentials, malformed model output, and timeouts
- Add compatibility checks against real Claude Code, OpenCode, Ollama, and OpenRouter versions
- Semantic deduplication beyond file and line overlap
- Contradiction detection between reviewers
- Per-reviewer trust, calibration, and weighted voting
- External provider plugin loading and a provider-author guide
- Review history, interactive triage, and a web dashboard

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deeper design notes.
