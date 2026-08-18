#!/usr/bin/env bash
# Build + publish the NJ Transit departure board.
#
# Caddy serves the SPA straight from ./dist, so a build is the deploy. The API
# proxy runs as njtransit-api.service and is restarted here so credential or
# server changes take effect.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CADDYFILE="/etc/caddy/Caddyfile"
HOSTNAME_="njtransit.carlosmartinezt.com"
UNIT="njtransit-api"

echo "▶ Installing dependencies…"
npm ci

echo "▶ Building production bundle…"
npm run build
echo "✓ Build complete → $ROOT/dist"

# ── API service ───────────────────────────────────────────────────────────────

# A user unit, so no sudo — lingering keeps it running across reboots.
if systemctl --user list-unit-files | grep -q "^${UNIT}.service"; then
  echo "▶ Restarting $UNIT…"
  systemctl --user restart "$UNIT"
  sleep 1
  if systemctl --user is-active --quiet "$UNIT"; then
    echo "✓ $UNIT running"
  else
    echo "✗ $UNIT failed to start:"
    journalctl --user -u "$UNIT" -n 30 --no-pager
    exit 1
  fi
else
  echo "▶ Installing $UNIT…"
  mkdir -p "$HOME/.config/systemd/user"
  cp "$ROOT/deploy/njtransit-api.service" "$HOME/.config/systemd/user/"
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  echo "✓ $UNIT installed and started"
fi

# ── Caddy ─────────────────────────────────────────────────────────────────────

# Caddy serves dist/ straight off disk, so a build never needs a reload — only a
# changed site block does. Comparing the live block against the repo's keeps the
# everyday deploy sudo-free, which matters because `sudo systemctl reload caddy`
# fails outright when there's no terminal to type a password into.
caddy_block() {
  awk -v host="$HOSTNAME_" '
    index($0, host " {") == 1 { inblock = 1 }
    inblock { print }
    inblock && /^}/ { inblock = 0 }
  ' "$1" 2>/dev/null | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^$/d'
}

if ! grep -q "$HOSTNAME_" "$CADDYFILE" 2>/dev/null; then
  cat <<EOF

────────────────────────────────────────────────────────────────────────
ONE-TIME SETUP (not yet done):

1. DNS — there is no *.carlosmartinezt.com wildcard; every subdomain has
   its own record. Add one for njtransit in Cloudflare, matching the
   journal record (proxied, pointing at 5.161.231.48).

2. Caddy — append the site block and reload:

     sudo sh -c 'cat $ROOT/deploy/njtransit.Caddyfile >> $CADDYFILE'
     sudo systemctl reload caddy

Caddy provisions HTTPS automatically once DNS resolves. After that every
deploy is just: ./ops/deploy.sh
────────────────────────────────────────────────────────────────────────
EOF
elif [ "$(caddy_block "$CADDYFILE")" = "$(caddy_block "$ROOT/deploy/njtransit.Caddyfile")" ]; then
  echo "✓ Caddy config unchanged; no reload needed"
  echo "✓ Live at https://$HOSTNAME_"
else
  echo "⚠ The live Caddy site block differs from deploy/njtransit.Caddyfile:"
  diff <(caddy_block "$CADDYFILE") <(caddy_block "$ROOT/deploy/njtransit.Caddyfile") || true
  cat <<EOF

Reloading alone won't apply this — $CADDYFILE is root-owned and shared with
the other sites, so edit the njtransit block there by hand, then:

     sudo systemctl reload caddy

The build and the API are deployed either way; only the site config is stale.
EOF
fi

# ── smoke test ────────────────────────────────────────────────────────────────

echo "▶ Checking the API…"
if curl -fsS --max-time 5 "http://127.0.0.1:3057/api/health" >/dev/null; then
  SOURCE=$(curl -fsS "http://127.0.0.1:3057/api/health" | grep -o '"source":"[a-z]*"' || true)
  echo "✓ API healthy ($SOURCE)"
else
  echo "✗ API is not answering on 127.0.0.1:3057"
  exit 1
fi
