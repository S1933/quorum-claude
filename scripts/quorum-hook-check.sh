#!/usr/bin/env bash
set -e

# ---- Quorum pre-commit check ----
# Shared by Codex CLI and OpenCode Go hooks.
# Checks for high/critical findings and blocks the commit if found.
# Set QUORUM_BYPASS=1 to skip.

TARGET_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$TARGET_ROOT" ]; then
  echo '{"decision":"allow"}' >&1
  exit 0
fi

cd "$TARGET_ROOT"

if [ "$QUORUM_BYPASS" = "1" ]; then
  echo '{"decision":"allow"}' >&1
  exit 0
fi

if ! command -v quorum &>/dev/null && ! [ -f ./src/cli/index.ts ]; then
  echo '{"decision":"allow"}' >&1
  exit 0
fi

CMD="quorum"
[ -f ./src/cli/index.ts ] && CMD="bun run ./src/cli/index.ts"

OUTPUT=$($CMD review --json --config quorum.yaml 2>&1 || true)

CRITICAL=$(echo "$OUTPUT" | jq -r '.findings[] | select(.severity=="critical" or .severity=="high") | .severity' 2>/dev/null | wc -l || echo 0)

if [ "$CRITICAL" -gt 0 ]; then
  echo "Quorum found $CRITICAL high/critical findings. Set QUORUM_BYPASS=1 to bypass." >&2
  echo '{"decision":"block","reason":"Quorum found '$CRITICAL' high/critical findings"}' >&1
  exit 2
fi

echo '{"decision":"allow"}' >&1
exit 0