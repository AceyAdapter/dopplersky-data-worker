#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "❌ verify failed: $1"; exit 1; }

npm run verify || fail "typecheck, tests, or build"
test "$(readlink CLAUDE.md)" = "AGENTS.md" || fail "CLAUDE.md symlink"
test "$(wc -l < AGENTS.md)" -le 180 || fail "AGENTS.md exceeds 180 lines"

echo "✅ verify passed"
