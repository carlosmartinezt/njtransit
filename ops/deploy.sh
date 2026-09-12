#!/usr/bin/env bash
# Build + publish the NJ Transit departure board to Vercel.
#
# Builds locally with `vercel build` and ships the output with
# `--prebuilt`, so a broken build fails here in a few seconds instead of
# halfway through a remote deploy, and what's tested is what ships.
#
# First time on a machine:  npm i -g vercel && vercel link
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-production}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "✗ The Vercel CLI isn't installed:  npm i -g vercel"
  exit 1
fi

if [ ! -f .vercel/project.json ]; then
  echo "✗ This directory isn't linked to a Vercel project yet:  vercel link"
  exit 1
fi

echo "▶ Installing dependencies…"
npm ci

if [ "$TARGET" = "production" ] || [ "$TARGET" = "prod" ]; then
  PROD_FLAG="--prod"
  echo "▶ Building for production…"
else
  PROD_FLAG=""
  echo "▶ Building a preview…"
fi

# Pulls the project's env vars, then builds into .vercel/output.
vercel build $PROD_FLAG

echo "▶ Deploying…"
URL=$(vercel deploy --prebuilt $PROD_FLAG)
echo "✓ Deployed → $URL"

# ── smoke test ────────────────────────────────────────────────────────────────

# /api/health is the one endpoint that reports whether this deployment can
# actually do its job: live credentials, and a store that persists. A preview
# with `store: memory` is a deployment that forgets every gate it learns.
echo "▶ Checking the API…"
HEALTH=$(curl -fsS --max-time 15 "$URL/api/health" || true)

if [ -z "$HEALTH" ]; then
  echo "✗ /api/health did not answer. Check: vercel logs $URL"
  exit 1
fi

echo "  $HEALTH"

case "$HEALTH" in
  *'"source":"sample"'*)
    echo "⚠ Serving the SAMPLE board — NJT_USERNAME / NJT_PASSWORD are not set on this environment."
    echo "  vercel env add NJT_USERNAME production"
    ;;
esac

case "$HEALTH" in
  *'"persistent":false'*)
    echo "⚠ No Redis on this environment — gate history will be lost on every cold start."
    echo "  vercel integration add upstash    # then redeploy"
    ;;
esac

echo "✓ Live at $URL"
