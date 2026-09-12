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
  ENVIRONMENT="production"
  echo "▶ Building for production…"
else
  PROD_FLAG=""
  ENVIRONMENT="preview"
  echo "▶ Building a preview…"
fi

# Project settings and environment variables, fetched fresh every time. A build
# against a stale local copy is how a deployment ends up with yesterday's
# credentials, or none at all.
#
# The file goes first because `vercel pull` leaves an existing one alone when it
# considers it current, which means a variable deleted on the project stays in
# the local copy and goes on being built in. That is not hypothetical: it is how
# a removed SITE_ORIGIN kept baking "[SENSITIVE]" into 70 canonical URLs.
rm -f .vercel/.env.*.local
vercel pull --yes --environment="$ENVIRONMENT"

# Builds into .vercel/output using what was just pulled.
vercel build $PROD_FLAG

echo "▶ Deploying…"
# The CLI answers in JSON, so the URL has to be read out of it rather than taken
# as the last line of output.
DEPLOY_JSON=$(vercel deploy --prebuilt $PROD_FLAG)
URL=$(printf '%s' "$DEPLOY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployment"]["url"])')
echo "✓ Deployed → $URL"

# ── smoke test ────────────────────────────────────────────────────────────────

# /api/health is the one endpoint that reports whether this deployment can
# actually do its job: live credentials, and a store that persists. A preview
# with `store: memory` is a deployment that forgets every gate it learns.
#
# Through `vercel curl`, because Deployment Protection covers every *.vercel.app
# URL on this project — a plain curl gets the SSO redirect, not the board.
echo "▶ Checking the API…"
HEALTH=$(vercel curl "$URL/api/health" -s --max-time 20 2>/dev/null | tail -1 || true)

case "$HEALTH" in
  *'"ok":true'*) ;;
  *)
    echo "✗ /api/health did not answer. Check: vercel logs $URL"
    exit 1
    ;;
esac

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
    echo "  vercel integration add upstash/upstash-kv    # then redeploy"
    ;;
esac

echo "✓ Live at $URL"
