#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env; copy .env.example and configure local services." >&2
  exit 1
fi

npm run build
exec npm start
