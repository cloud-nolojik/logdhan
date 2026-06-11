#!/bin/bash
#
# run-remote-dryrun.sh — sync the latest backend code to the server and run the
# paper-spec dry-run there (where the live Kite session + production Mongo are).
#
# Usage:
#   ./run-remote-dryrun.sh                    # replay today (IST)
#   ./run-remote-dryrun.sh --date=2026-06-10  # replay a specific past day
#
# What it does:
#   1. rsync backend/ (src + scripts, no node_modules) to the server
#      — NOTE: this puts new code on disk but does NOT restart pm2, so the
#        running backend is untouched. The new code goes live only on the next
#        pm2 restart / deploy-continous.sh run. (You're deploying tonight
#        anyway — this just front-loads the file copy.)
#   2. ssh in and run scripts/dryrun-paper-day.js with the production .env
#      (valid Kite token from the 06:00 refresh + production Mongo).
#   3. tee the output to a local log: dryrun-remote-<date>.log
#
# NO ORDERS ARE PLACED, NOTHING IS WRITTEN to orb_* collections — the dry-run
# script is read-only by design.

set -euo pipefail

# === CONFIG (same target as deploy-continous.sh) ===
REMOTE_USER="root"
REMOTE_HOST="64.227.179.191"
REMOTE_DIR="/var/www/logdhan"
# Read the password from deploy-continous.sh so it lives in ONE place only.
REMOTE_PASSWORD=$(grep -m1 '^REMOTE_PASSWORD=' "$(dirname "$0")/deploy-continous.sh" | cut -d'"' -f2)

if ! command -v sshpass &> /dev/null; then
  echo "⚠️  sshpass not found. Install: brew install hudochenkov/sshpass/sshpass"
  exit 1
fi
if [ -z "$REMOTE_PASSWORD" ]; then
  echo "⚠️  Could not read REMOTE_PASSWORD from deploy-continous.sh"
  exit 1
fi

DATE_ARG="${1:-}"
LOG_DATE="${DATE_ARG#--date=}"; LOG_DATE="${LOG_DATE:-$(date '+%Y-%m-%d')}"
LOCAL_LOG="dryrun-remote-${LOG_DATE}.log"

# === STEP 1: sync backend code (no node_modules, no restart) ===
echo "🚚 Syncing backend → ${REMOTE_HOST}:${REMOTE_DIR}/backend (no pm2 restart)..."
sshpass -p "$REMOTE_PASSWORD" rsync -az --exclude 'node_modules' --exclude 'logs' \
  -e "ssh -o StrictHostKeyChecking=no" \
  "$(dirname "$0")/backend/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/backend"

# === STEP 2: run the dry-run remotely, stream + capture output ===
echo "🏃 Running dry-run on server (${LOG_DATE})... output → ${LOCAL_LOG}"
echo "─────────────────────────────────────────────────────────────"
sshpass -p "$REMOTE_PASSWORD" ssh -o StrictHostKeyChecking=no \
  "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd ${REMOTE_DIR}/backend && node scripts/dryrun-paper-day.js ${DATE_ARG}" \
  | tee "$LOCAL_LOG"

echo "─────────────────────────────────────────────────────────────"
echo "✅ Done. Full output saved to ${LOCAL_LOG}"
