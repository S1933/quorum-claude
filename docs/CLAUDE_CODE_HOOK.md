# Claude Code Hook Configuration

Auto-run Quorum review before commits using a Claude Code hook.

## Setup

Add this hook to your Claude Code settings. The hook uses the shared check script at `scripts/quorum-hook-check.sh`.

### Option 1: Project-level (checked in)

Create `.claude/settings.json` in your project. See [`docs/claude-settings.json.example`](claude-settings.json.example) for the complete example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git commit*)",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'set -e; TARGET_ROOT=$(git rev-parse --show-toplevel); cd \"$TARGET_ROOT\"; if [ \"$QUORUM_BYPASS\" = \"1\" ]; then echo \"Bypassing Quorum high/critical checks\"; exit 0; fi; if ! command -v quorum &>/dev/null && ! [ -f ./src/cli/index.ts ]; then echo \"Quorum not found, skipping check\"; exit 0; fi; CMD=\"quorum\"; [ -f ./src/cli/index.ts ] && CMD=\"bun run ./src/cli/index.ts\"; OUTPUT=$($CMD review --json --config quorum.yaml 2>&1 || true); CRITICAL=$(echo \"$OUTPUT\" | jq -r \".findings[] | select(.severity==\\\"critical\\\" or .severity==\\\"high\\\") | .severity\" 2>/dev/null | wc -l || echo 0); if [ \"$CRITICAL\" -gt 0 ]; then echo \"{\\\"continue\\\": false, \\\"stopReason\\\": \\\"Quorum found $CRITICAL high/critical findings. Set QUORUM_BYPASS=1 to bypass.\\\"}\" >&2; exit 1; fi; exit 0'",
            "statusMessage": "Running Quorum review..."
          }
        ]
      }
    ]
  }
}
```

### Option 2: User-level (global, all projects)

Add to `~/.claude/settings.json` the same hook configuration above.

## Usage

### Normal commit (with Quorum check)
```bash
git commit -m "your message"
```

The hook will:
1. Run `quorum review --json`
2. Check for `high` or `critical` severity findings
3. Block the commit if any are found
4. Display the number of findings

### Bypass the check
```bash
QUORUM_BYPASS=1 git commit -m "your message"
```

## How it works

The hook:
- Triggers before any `git commit` command in Claude Code
- Runs Quorum review in JSON mode against your current diff
- Parses the JSON output to find high/critical findings
- Blocks the commit with a clear error message if findings are found
- Can be bypassed with `QUORUM_BYPASS=1` environment variable
- Gracefully handles cases where Quorum is not installed

## Requirements

- `jq` (for JSON parsing)
- `quorum` command available OR `./src/cli/index.ts` for local development
- `quorum.yaml` configuration file

## Troubleshooting

If the hook doesn't run:
1. Verify the settings file is in the correct location (`.claude/settings.json` or `~/.claude/settings.json`)
2. Ensure JSON syntax is valid: `jq . .claude/settings.json`
3. Check that `jq` is installed: `which jq`
4. Verify Quorum is available: `quorum review --help` or check for `./src/cli/index.ts`