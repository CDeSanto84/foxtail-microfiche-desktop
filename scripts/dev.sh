#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
[[ -f .env ]] || cp .env.example .env

echo "[1/3] Starting PostgreSQL + FastAPI containers..."
docker compose up -d --build

echo "[2/3] Installing desktop dependencies if needed..."
cd "$ROOT/apps/desktop"
[[ -d node_modules ]] || npm install

echo "[3/3] Launching Foxtail Microfiche..."
npm run dev
