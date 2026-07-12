#!/usr/bin/env bash
# bumblebee agent uninstaller
#
# Removes the scheduled scan and optionally the installed binary.
# Run this on the machine where install-agent.sh was previously run.
#
# Usage:
#   curl -fsSL http://YOUR-SERVER:8080/uninstall.sh | bash
#   (or run the script directly if you have a local copy)
#
# Flags:
#   --keep-binary   remove the schedule but keep ~/.bumblebee/bin/bumblebee
#   --install-dir   override install dir (default ~/.bumblebee)
#
set -euo pipefail

KEEP_BINARY=false
INSTALL_DIR="$HOME/.bumblebee"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-binary)  KEEP_BINARY=true; shift ;;
    --install-dir)  INSTALL_DIR="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

log() { printf '[bumblebee-uninstall] %s\n' "$1"; }

case "$(uname -s)" in
  Linux*)   PLATFORM="linux" ;;
  Darwin*)  PLATFORM="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *) PLATFORM="unknown" ;;
esac

removed=0

# ── macOS: launchd ──────────────────────────────────────────────────────
if [ "$PLATFORM" = "darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.bumblebee.scan.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    log "removed launchd agent: $PLIST"
    removed=1
  else
    log "no launchd agent found at $PLIST"
  fi
fi

# ── Linux: cron ─────────────────────────────────────────────────────────
if [ "$PLATFORM" = "linux" ]; then
  if crontab -l 2>/dev/null | grep -q bumblebee; then
    crontab -l 2>/dev/null | grep -v bumblebee | crontab -
    log "removed cron entry"
    removed=1
  else
    log "no cron entry found for bumblebee"
  fi
fi

# ── Windows: Task Scheduler ──────────────────────────────────────────────
if [ "$PLATFORM" = "windows" ]; then
  if schtasks //Query //TN BumblebeeScan >/dev/null 2>&1; then
    schtasks //Delete //TN BumblebeeScan //F >/dev/null
    log "removed Task Scheduler task: BumblebeeScan"
    removed=1
  else
    log "no Task Scheduler task found named BumblebeeScan"
  fi
fi

# ── kill any running scan process ────────────────────────────────────────
if pkill -f "bumblebee scan" 2>/dev/null; then
  log "stopped running bumblebee scan process"
fi

# ── remove install directory ─────────────────────────────────────────────
if [ "$KEEP_BINARY" = "true" ]; then
  log "keeping $INSTALL_DIR (--keep-binary set)"
else
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "removed $INSTALL_DIR"
    removed=1
  else
    log "install dir not found: $INSTALL_DIR"
  fi
fi

if [ "$removed" -eq 0 ]; then
  log "nothing to remove — bumblebee agent does not appear to be installed on this machine"
else
  log "done — bumblebee agent has been removed from this machine"
fi
