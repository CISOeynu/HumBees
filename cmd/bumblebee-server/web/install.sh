#!/usr/bin/env bash
# bumblebee agent installer (macOS + Linux)
# Served pre-configured by bumblebee-server.
#
# Usage — no flags needed, server/port are pre-filled:
#   curl -fsSL http://SERVER:PORT/install.sh | bash
#
# Override any default:
#   curl -fsSL http://SERVER:PORT/install.sh | bash -s -- --interval 12 --profile deep
#
set -euo pipefail

SERVER="__SERVER__"
PORT="__PORT__"
INTERVAL_HOURS="48"
PROFILE="baseline"
VERSION="latest"
BINARY_URL=""
AUTH_TOKEN=""
INSTALL_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server)      SERVER="$2";         shift 2 ;;
    --port)        PORT="$2";           shift 2 ;;
    --interval)    INTERVAL_HOURS="$2"; shift 2 ;;
    --profile)     PROFILE="$2";        shift 2 ;;
    --version)     VERSION="$2";        shift 2 ;;
    --binary-url)  BINARY_URL="$2";     shift 2 ;;
    --auth-token)  AUTH_TOKEN="$2";     shift 2 ;;
    --install-dir) INSTALL_DIR="$2";    shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[ -z "$SERVER" ] && { echo "error: server address not set" >&2; exit 1; }

log() { printf '[bumblebee-install] %s\n' "$1"; }

case "$(uname -s)" in
  Linux*)  PLATFORM="linux"  ;;
  Darwin*) PLATFORM="darwin" ;;
  *) echo "error: unsupported OS. Windows is not supported." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "error: unsupported arch '$(uname -m)'" >&2; exit 1 ;;
esac
log "platform: $PLATFORM/$ARCH"

[ -z "$INSTALL_DIR" ] && INSTALL_DIR="$HOME/.bumblebee"
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/logs"
BIN_PATH="$INSTALL_DIR/bin/bumblebee"

# ── resolve download URL ────────────────────────────────────────────────
if [ -z "$BINARY_URL" ]; then
  if [ "$VERSION" = "latest" ]; then
    log "resolving latest release from GitHub..."
    RELEASE_TAG="$(curl -fsSL "https://api.github.com/repos/perplexityai/bumblebee/releases/latest" \
      | grep '"tag_name"' | head -n1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
    [ -z "$RELEASE_TAG" ] && { echo "error: could not resolve latest tag" >&2; exit 1; }
  else
    RELEASE_TAG="$VERSION"
  fi
  RELEASE_VER="${RELEASE_TAG#v}"
  BINARY_URL="https://github.com/perplexityai/bumblebee/releases/download/$RELEASE_TAG/bumblebee_${RELEASE_VER}_${PLATFORM}_${ARCH}.tar.gz"
fi

log "downloading $BINARY_URL"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BINARY_URL" -o "$TMP/agent.tar.gz"
tar -xzf "$TMP/agent.tar.gz" -C "$TMP"
FOUND="$(find "$TMP" -name "bumblebee" -type f | head -n1)"
[ -z "$FOUND" ] && { echo "error: binary not found in archive" >&2; exit 1; }
cp "$FOUND" "$BIN_PATH"; chmod +x "$BIN_PATH"
log "installed: $BIN_PATH ($($BIN_PATH --version 2>/dev/null || echo 'version unknown'))"

# ── build scan command ──────────────────────────────────────────────────
HTTP_URL="http://${SERVER}:${PORT}/ingest"
RUN_CMD=("$BIN_PATH" scan --profile "$PROFILE" --output http --http-url "$HTTP_URL" --http-gzip --http-allow-insecure)
ENV_LINES=()
if [ -n "$AUTH_TOKEN" ]; then
  RUN_CMD+=(--http-auth bearer --http-token-env BUMBLEBEE_AUTH_TOKEN)
  ENV_LINES+=("BUMBLEBEE_AUTH_TOKEN=$AUTH_TOKEN")
fi

# ── schedule ────────────────────────────────────────────────────────────
case "$PLATFORM" in
  linux)
    CRON_FILE="$INSTALL_DIR/bumblebee.cron"
    { for e in "${ENV_LINES[@]}"; do echo "$e"; done
      printf '0 */%s * * * %s >> %s/logs/scan.log 2>&1\n' \
        "$INTERVAL_HOURS" "${RUN_CMD[*]}" "$INSTALL_DIR"; } > "$CRON_FILE"
    ( crontab -l 2>/dev/null | grep -v "$BIN_PATH" || true; cat "$CRON_FILE" ) | crontab -
    log "scheduled via cron every ${INTERVAL_HOURS}h"
    ;;
  darwin)
    PLIST="$HOME/Library/LaunchAgents/com.bumblebee.scan.plist"
    mkdir -p "$(dirname "$PLIST")"
    SECS=$(( INTERVAL_HOURS * 3600 ))
    { echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo '  <key>Label</key><string>com.bumblebee.scan</string>'
      echo '  <key>ProgramArguments</key><array>'
      for arg in "${RUN_CMD[@]}"; do echo "    <string>$arg</string>"; done
      echo '  </array>'
      [ ${#ENV_LINES[@]} -gt 0 ] && {
        echo '  <key>EnvironmentVariables</key><dict>'
        for e in "${ENV_LINES[@]}"; do
          echo "    <key>${e%%=*}</key><string>${e#*=}</string>"
        done; echo '  </dict>'; }
      echo "  <key>StartInterval</key><integer>$SECS</integer>"
      echo '  <key>RunAtLoad</key><true/>'
      echo "  <key>StandardOutPath</key><string>$INSTALL_DIR/logs/scan.log</string>"
      echo "  <key>StandardErrorPath</key><string>$INSTALL_DIR/logs/scan.log</string>"
      echo '</dict></plist>'; } > "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    log "scheduled via launchd every ${INTERVAL_HOURS}h"
    ;;
esac

# ── initial scan ────────────────────────────────────────────────────────
log "running initial scan (this may take a moment)..."
if [ -n "$AUTH_TOKEN" ]; then
  BUMBLEBEE_AUTH_TOKEN="$AUTH_TOKEN" "${RUN_CMD[@]}" >/dev/null 2>&1 \
    || log "scan exited non-zero — check $INSTALL_DIR/logs/scan.log"
else
  "${RUN_CMD[@]}" >/dev/null 2>&1 \
    || log "scan exited non-zero — check $INSTALL_DIR/logs/scan.log"
fi
log "done — this endpoint will report to http://${SERVER}:${PORT} every ${INTERVAL_HOURS}h"
