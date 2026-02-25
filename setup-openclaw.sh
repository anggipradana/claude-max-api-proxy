#!/bin/bash
# =============================================================================
# setup-openclaw.sh
# Automatically configures OpenClaw to use claude-max-api-proxy
# =============================================================================

set -e

PROXY_PORT="${CLAUDE_PROXY_PORT:-3456}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}/v1"
OPENCLAW_DIR="${OPENCLAW_DIR:-/root/.openclaw}"
AGENT_DIR="${OPENCLAW_DIR}/agents/main/agent"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
success() { echo -e "${GREEN}[OK]${RESET}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }

# ── Check root / sudo ─────────────────────────────────────────────────────────
need_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo &>/dev/null; then
        sudo "$@"
    else
        error "This script needs root access to write to ${OPENCLAW_DIR}. Run as root or install sudo."
    fi
}

write_as_root() {
    local file="$1"
    local content="$2"
    echo "$content" | need_sudo tee "$file" > /dev/null
    success "Written: $file"
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     claude-max-api-proxy × OpenClaw Setup            ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── Checks ────────────────────────────────────────────────────────────────────
info "Checking requirements..."

command -v openclaw &>/dev/null || error "OpenClaw not found. Install from https://openclaw.dev"
command -v node &>/dev/null     || error "Node.js not found."
command -v claude &>/dev/null   || error "Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code"

OPENCLAW_VER=$(openclaw --version 2>/dev/null | head -1 || echo "unknown")
success "OpenClaw: $OPENCLAW_VER"
success "Node.js:  $(node --version)"
success "Claude:   $(claude --version 2>/dev/null | head -1)"

# ── Check openclaw config dir ─────────────────────────────────────────────────
if [ ! -d "$AGENT_DIR" ]; then
    error "OpenClaw agent dir not found: $AGENT_DIR\nRun 'openclaw gateway run' once to initialize, then re-run this script."
fi

# ── Check proxy is running ────────────────────────────────────────────────────
info "Checking if proxy is running on port ${PROXY_PORT}..."
if curl -sf --max-time 3 "http://127.0.0.1:${PROXY_PORT}/health" &>/dev/null; then
    success "Proxy is running on port ${PROXY_PORT}"
else
    warn "Proxy not running. Starting it now..."
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$SCRIPT_DIR/start-proxy.sh" ]; then
        nohup bash "$SCRIPT_DIR/start-proxy.sh" > /tmp/claude-proxy.log 2>&1 &
        sleep 5
        curl -sf --max-time 3 "http://127.0.0.1:${PROXY_PORT}/health" &>/dev/null \
            && success "Proxy started successfully" \
            || error "Failed to start proxy. Check /tmp/claude-proxy.log"
    else
        error "Proxy not running and start-proxy.sh not found.\nStart the proxy manually: node dist/server/standalone.js"
    fi
fi

# ── Backup existing configs ───────────────────────────────────────────────────
info "Backing up existing OpenClaw config..."
TS=$(date +%Y%m%d_%H%M%S)
need_sudo cp "${AGENT_DIR}/models.json"       "${AGENT_DIR}/models.json.bak.${TS}"       2>/dev/null && success "Backed up models.json" || true
need_sudo cp "${AGENT_DIR}/auth-profiles.json" "${AGENT_DIR}/auth-profiles.json.bak.${TS}" 2>/dev/null && success "Backed up auth-profiles.json" || true
need_sudo cp "${OPENCLAW_DIR}/openclaw.json"   "${OPENCLAW_DIR}/openclaw.json.bak.${TS}"   2>/dev/null && success "Backed up openclaw.json" || true

# ── Write models.json ─────────────────────────────────────────────────────────
info "Writing models.json..."
write_as_root "${AGENT_DIR}/models.json" '{
  "providers": {
    "claude-proxy": {
      "baseUrl": "'"${PROXY_URL}"'",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6 (via Max Proxy)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 200000,
          "maxTokens": 32000
        },
        {
          "id": "claude-sonnet-4",
          "name": "Claude Sonnet 4 (via Max Proxy)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 200000,
          "maxTokens": 32000
        },
        {
          "id": "claude-opus-4",
          "name": "Claude Opus 4 (via Max Proxy)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 200000,
          "maxTokens": 32000
        },
        {
          "id": "claude-haiku-4",
          "name": "Claude Haiku 4 (via Max Proxy)",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 200000,
          "maxTokens": 32000
        },
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5 (via Max Proxy)",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}'

# ── Write auth-profiles.json ──────────────────────────────────────────────────
info "Writing auth-profiles.json..."
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
write_as_root "${AGENT_DIR}/auth-profiles.json" '{
  "version": 1,
  "profiles": {
    "claude-proxy:default": {
      "type": "api_key",
      "provider": "claude-proxy",
      "key": "dummy"
    }
  },
  "lastGood": {
    "claude-proxy": "claude-proxy:default"
  },
  "usageStats": {
    "claude-proxy:default": {
      "lastUsed": '"${NOW_MS}"',
      "errorCount": 0
    }
  }
}'

# ── Patch openclaw.json (only the model/agent section) ────────────────────────
info "Patching openclaw.json (model config only)..."

OPENCLAW_JSON="${OPENCLAW_DIR}/openclaw.json"

need_sudo python3 - <<PYEOF
import json, sys

path = "${OPENCLAW_JSON}"
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    # Minimal config if file doesn't exist
    cfg = {}

# Patch only model-related keys
cfg.setdefault("agents", {}).setdefault("defaults", {})
cfg["agents"]["defaults"]["model"] = {
    "primary":   "claude-proxy/claude-sonnet-4",
    "fallbacks": ["claude-proxy/claude-haiku-4"]
}
cfg["agents"]["defaults"]["models"] = {
    "claude-proxy/claude-opus-4":   {},
    "claude-proxy/claude-sonnet-4": {},
    "claude-proxy/claude-haiku-4":  {}
}

# Remove legacy provider auth entries if present
cfg.pop("auth", None)

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)

print("Patched:", path)
PYEOF
success "openclaw.json patched"

# ── Reload openclaw gateway ───────────────────────────────────────────────────
info "Reloading OpenClaw gateway..."
OPENCLAW_PID=$(pgrep -f "openclaw-gateway" 2>/dev/null | head -1 || true)
if [ -n "$OPENCLAW_PID" ]; then
    need_sudo kill -SIGUSR1 "$OPENCLAW_PID" 2>/dev/null \
        && success "Sent SIGUSR1 to OpenClaw gateway (PID ${OPENCLAW_PID}) — reloading config" \
        || warn "Could not send SIGUSR1. Restart OpenClaw manually."
else
    warn "OpenClaw gateway not running. Start it with: openclaw gateway run"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}✓ Setup complete!${RESET}"
echo ""
echo -e "  Primary model : ${BOLD}claude-proxy/claude-sonnet-4${RESET}"
echo -e "  Fallback      : ${BOLD}claude-proxy/claude-haiku-4${RESET}"
echo -e "  Proxy URL     : ${BOLD}${PROXY_URL}${RESET}"
echo ""
echo -e "  Verify: ${CYAN}curl http://127.0.0.1:${PROXY_PORT}/health${RESET}"
echo ""
