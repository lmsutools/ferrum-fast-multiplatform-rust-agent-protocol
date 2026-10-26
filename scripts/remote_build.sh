#!/usr/bin/env bash
# remote_build.sh: sync the workspace to a remote VM or Vast.ai instance over SSH,
# build there, fetch artifacts, and prevent idle cloud bill waste while the local LLM reviews.
#
# Supports both standard Linux VMs (Hetzner/AWS/GCP) AND Vast.ai Docker containers
# (including `ssh://root@ssh5.vast.ai:41892` URLs, `--port <port>`, and `--vast-id <id>`).
#
# Usage:
#   scripts/remote_build.sh <ssh-host-or-ssh-url> [options] -- <cargo args...>
#   scripts/remote_build.sh <ssh-host-or-ssh-url> --install-watchdog [idle-minutes]
#
# Options:
#   --port <port>                Custom SSH port (auto-extracted if host is ssh://user@host:port)
#   --vast-id <instance-id>      Vast.ai instance ID (used by --poweroff / --destroy to stop billing via Vast.ai API)
#   --dir <remote-path>          Remote workspace directory (default: ~/src/<repo-name>)
#   --fetch <path-glob>          Rsync matching remote artifacts into ./remote-artifacts/
#   --poweroff                   Immediately stop/power off the VM or Vast.ai instance right after
#                                fetching artifacts (use before handing results to the local LLM!)
#   --destroy                    Destroy the Vast.ai instance after the build (stops both compute & storage billing)
#   --install-watchdog [mins]    Install a dead-man's switch (works on both systemd VMs and Vast.ai containers)
#                                that stops the instance after <mins> (default: 15) of zero cargo/rustc activity.
#
# Examples:
#   scripts/remote_build.sh ssh://root@ssh5.vast.ai:41892 --vast-id 123456 --install-watchdog 15
#   scripts/remote_build.sh ssh://root@ssh5.vast.ai:41892 --vast-id 123456 --poweroff -- nextest run --workspace --profile ci
set -euo pipefail

RAW_HOST="${1:?ssh host or ssh://user@host:port required}"; shift
NAME="$(basename "$PWD")"
RDIR="~/src/$NAME"; FETCH=""; POWEROFF=0; DESTROY=0; INSTALL_WATCHDOG=""; PORT=""; VAST_ID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse ssh://user@host:port or user@host:port automatically
HOST="$RAW_HOST"
if [[ "$RAW_HOST" =~ ^ssh://([^/:]+)(:([0-9]+))?/?$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  PORT="${BASH_REMATCH[3]:-22}"
elif [[ "$RAW_HOST" =~ ^([^:]+):([0-9]+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  PORT="${BASH_REMATCH[2]}"
fi

while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    --vast-id) VAST_ID="$2"; shift 2 ;;
    --dir) RDIR="$2"; shift 2 ;;
    --fetch) FETCH="$2"; shift 2 ;;
    --poweroff) POWEROFF=1; shift ;;
    --destroy) DESTROY=1; POWEROFF=1; shift ;;
    --install-watchdog)
      if [ $# -ge 2 ] && [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        INSTALL_WATCHDOG="$2"; shift 2
      else
        INSTALL_WATCHDOG="15"; shift
      fi
      ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
done
[ "${1:-}" = "--" ] && shift

SSH_OPTS=()
RSYNC_SSH="ssh"
if [ -n "$PORT" ]; then
  SSH_OPTS=(-p "$PORT")
  RSYNC_SSH="ssh -p $PORT"
fi

if [ -n "$INSTALL_WATCHDOG" ]; then
  echo "==> installing ${INSTALL_WATCHDOG}-minute idle auto-shutdown watchdog on $HOST${PORT:+:$PORT}"
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$HOST" "SUDO=''; command -v sudo >/dev/null 2>&1 && [ \"\$(id -u)\" -ne 0 ] && SUDO='sudo'; \
    \$SUDO tee /usr/local/bin/rust-vm-watchdog.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
IDLE_MINS=${INSTALL_WATCHDOG}
HB=/tmp/.remote-build-heartbeat
[ -f \"\$HB\" ] || touch \"\$HB\"
check_once() {
  if pgrep -x 'cargo|rustc|rustdoc|cargo-nextest|lld|rust-lld|mold|wild|cc1' >/dev/null 2>&1; then
    touch \"\$HB\"
    return 0
  fi
  LAST=\$(stat -c %Y \"\$HB\" 2>/dev/null || date +%s)
  NOW=\$(date +%s)
  if [ \$(( (NOW - LAST) / 60 )) -ge \"\$IDLE_MINS\" ]; then
    logger -t rust-vm-watchdog \"No Rust build activity for \${IDLE_MINS}m; stopping instance.\" 2>/dev/null || true
    CID=\"\${CONTAINER_ID:-\${VAST_CONTAINERLABEL:-}}\"
    CID=\"\${CID#C.}\"
    VKEY=\"\${VAST_API_KEY:-\$(cat ~/.vast_api_key 2>/dev/null || true)}\"
    if [ -n \"\$CID\" ] && [ -n \"\$VKEY\" ]; then
      curl -s -X PUT \"https://console.vast.ai/api/v0/instances/\${CID}/\" \
        -H \"Authorization: Bearer \${VKEY}\" -H \"Content-Type: application/json\" \
        -d '{\"state\":\"stopped\"}' >/dev/null 2>&1 || true
    fi
    /sbin/poweroff 2>/dev/null || systemctl poweroff 2>/dev/null || kill -TERM 1 2>/dev/null || true
    exit 0
  fi
}
if [ \"\${1:-}\" = \"--daemon\" ]; then
  while true; do sleep 60; check_once; done
else
  check_once
fi
EOF
  \$SUDO chmod +x /usr/local/bin/rust-vm-watchdog.sh
  touch /tmp/.remote-build-heartbeat
  if [ -d /etc/cron.d ] && pgrep -x 'cron|crond' >/dev/null 2>&1; then
    echo '* * * * * root /usr/local/bin/rust-vm-watchdog.sh' | \$SUDO tee /etc/cron.d/rust-vm-watchdog >/dev/null
    \$SUDO chmod 644 /etc/cron.d/rust-vm-watchdog
  else
    pkill -f '/usr/local/bin/rust-vm-watchdog.sh --daemon' 2>/dev/null || true
    nohup /usr/local/bin/rust-vm-watchdog.sh --daemon >/var/log/rust-vm-watchdog.log 2>&1 &
  fi"
  echo "==> watchdog active on $HOST${PORT:+:$PORT} (stops after ${INSTALL_WATCHDOG}m of zero cargo/rustc activity)"
  [ $# -eq 0 ] && exit 0
fi

[ $# -gt 0 ] || { echo "missing cargo args after --" >&2; exit 1; }

echo "==> sync $PWD -> $HOST${PORT:+:$PORT}:$RDIR"
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $RDIR && touch /tmp/.remote-build-heartbeat"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude '/target' --exclude '/target-*' --exclude '.git/objects' \
  ./ "$HOST:$RDIR/"

echo "==> remote: cargo $*"
BUILD_STATUS=0
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" -t "$HOST" "touch /tmp/.remote-build-heartbeat && cd $RDIR && source ~/.cargo/env 2>/dev/null || true; rustup toolchain install >/dev/null 2>&1 || true; \
  echo \"cores: \$(nproc 2>/dev/null || sysctl -n hw.ncpu), free disk: \$(df -h . | awk 'NR==2{print \$4}')\"; \
  time cargo $*; STATUS=\$?; touch /tmp/.remote-build-heartbeat; exit \$STATUS" || BUILD_STATUS=$?

if [ -n "$FETCH" ] && [ "$BUILD_STATUS" -eq 0 ]; then
  echo "==> fetch $FETCH"
  mkdir -p remote-artifacts
  rsync -az -e "$RSYNC_SSH" "$HOST:$RDIR/$FETCH" remote-artifacts/
  ls -la remote-artifacts
fi

if [ "$POWEROFF" -eq 1 ]; then
  if [ -n "$VAST_ID" ]; then
    ACTION="stop"; [ "$DESTROY" -eq 1 ] && ACTION="destroy"
    echo "==> --${ACTION}: calling Vast.ai API to ${ACTION} instance $VAST_ID so billing drops to \$0 while local LLM reviews"
    if [ -f "$SCRIPT_DIR/vast-cloud.mjs" ]; then
      node "$SCRIPT_DIR/vast-cloud.mjs" "$ACTION" "$VAST_ID" || true
    elif command -v vastai >/dev/null 2>&1; then
      vastai "$ACTION" instance "$VAST_ID" || true
    fi
  else
    echo "==> --poweroff: shutting down $HOST${PORT:+:$PORT} immediately so VM costs \$0 while local LLM reviews"
    ssh "${SSH_OPTS[@]}" "$HOST" "CID=\"\${CONTAINER_ID:-\${VAST_CONTAINERLABEL:-}}\"; CID=\"\${CID#C.}\"; VKEY=\"\${VAST_API_KEY:-\$(cat ~/.vast_api_key 2>/dev/null || true)}\"; \
      if [ -n \"\$CID\" ] && [ -n \"\$VKEY\" ]; then curl -s -X PUT \"https://console.vast.ai/api/v0/instances/\${CID}/\" -H \"Authorization: Bearer \${VKEY}\" -H \"Content-Type: application/json\" -d '{\"state\":\"stopped\"}' >/dev/null 2>&1; fi; \
      nohup sh -c 'sleep 1 && (systemctl poweroff || /sbin/poweroff || kill -TERM 1)' >/dev/null 2>&1 &" || true
  fi
fi

exit "$BUILD_STATUS"
