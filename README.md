# Quorum

[![CI](https://github.com/S1933/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/S1933/quorum/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-6b46c1)](#claude-code-plugin)

Provider-agnostic consensus review for AI-assisted code changes.

Quorum runs multiple AI reviewers on a git diff and highlights findings they agree on.
Works as a Bun CLI or Claude Code plugin.

## Features

- Multi-reviewer consensus on the same git diff, with findings grouped by file, line, and category.
- Provider-agnostic execution across APIs, local models, and agent CLIs.
- YAML-defined personas, reviewer overrides, file filters, and parallel or sequential pipelines.
- Terminal progress plus Markdown/JSON reports, available from the CLI or Claude Code slash commands.

## Review Workflow

```mermaid
flowchart LR
    changes["Changes<br/><small>Git diff / Pull Request</small>"]
    config["Config<br/><small>quorum.yaml</small>"]

    subgraph providers["Providers / Brains"]
        gpt["GPT-5.5"]
        opus["Claude Opus 4.5"]
        gemini["Gemini Pro"]
        deepseek["DeepSeek"]
    end

    subgraph personas["Personas / Review Lens"]
        security["security<br/><small>Adversarial security review</small>"]
        backend["backend-senior<br/><small>Senior backend engineering review</small>"]
        frontend["frontend-senior<br/><small>Senior frontend engineering review</small>"]
        architecture["architecture<br/><small>Architecture and maintainability review</small>"]
        performance["performance<br/><small>Performance and scalability review</small>"]
    end

    subgraph reviewers["Reviewers / AI Agents"]
        r1["Security Reviewer<br/><small>Provider + security persona</small>"]
        r2["Backend Reviewer<br/><small>Provider + backend-senior persona</small>"]
        r3["Frontend Reviewer<br/><small>Provider + frontend-senior persona</small>"]
        r4["Architecture Reviewer<br/><small>Provider + architecture persona</small>"]
        r5["Performance Reviewer<br/><small>Provider + performance persona</small>"]
    end

    pipeline["Pipeline<br/><small>Review meeting orchestration</small>"]
    findings["Findings<br/><small>Structured review results</small>"]
    consensus["Consensus<br/><small>Compare overlaps and agreement</small>"]
    report["Report<br/><small>Markdown / JSON output</small>"]

    changes --> config
    config --> providers
    config --> personas

    providers --> reviewers
    personas --> reviewers

    reviewers --> pipeline
    pipeline --> findings
    findings --> consensus
    consensus --> report

    classDef main fill:#f7f3ff,stroke:#6d28d9,stroke-width:1.5px,color:#111827;
    classDef group fill:#ffffff,stroke:#c4b5fd,stroke-width:1px,color:#111827;
    classDef output fill:#ecfdf5,stroke:#16a34a,stroke-width:1.5px,color:#111827;

    class changes,config,pipeline,findings,consensus main;
    class report output;
    class gpt,opus,gemini,deepseek,security,backend,frontend,architecture,performance,r1,r2,r3,r4,r5 group;
```

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

# Print loaded config with secrets redacted
bun quorum config

# Print a clean JSON review report to stdout
bun quorum review --json

# Equivalent explicit format flag
bun quorum review --format json
```

JSON mode outputs only the JSON to stdout. Use `--report <path>` to write to a file.

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

For local plugin development:

```bash
claude --plugin-dir ./plugin
```

Then run `/quorum:quorum-review` or `/quorum:quorum-config` in Claude Code.

### Claude Code Hook

Auto-run Quorum review before commits. See [docs/CLAUDE_CODE_HOOK.md](docs/CLAUDE_CODE_HOOK.md) for setup instructions.

Blocks commits with `high` or `critical` severity findings:

```bash
# Normal commit (runs Quorum check)
git commit -m "message"

# Bypass the check
QUORUM_BYPASS=1 git commit -m "message"
```

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
