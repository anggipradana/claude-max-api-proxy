#!/bin/bash
# Start claude-proxy + openclaw gateway
# Run as anggi user (uses sudo for openclaw)

echo "[0/3] Ensuring Telegram IPv4 in /etc/hosts..."
if ! grep -q "api.telegram.org" /etc/hosts 2>/dev/null; then
    echo '@anggi1' | sudo -S bash -c 'echo "149.154.166.110 api.telegram.org" >> /etc/hosts' 2>/dev/null
    echo "  Added api.telegram.org → 149.154.166.110"
else
    echo "  api.telegram.org already in /etc/hosts"
fi

echo "[1/3] Killing old processes..."

# Kill anything on port 3456 (proxy)
fuser -k 3456/tcp 2>/dev/null && echo "  Killed process on port 3456"

# Kill old openclaw gateway
for pid in $(pgrep -f "openclaw-gateway" 2>/dev/null); do
    echo '@anggi1' | sudo -S kill "$pid" 2>/dev/null && echo "  Killed openclaw PID $pid"
done

# Delete stale lock files
echo '@anggi1' | sudo -S rm -f /tmp/openclaw-0/gateway.*.lock 2>/dev/null

# Wait for port 3456 to be fully free
for i in $(seq 1 10); do
    ss -tlnp | grep -q 3456 || break
    sleep 1
done

echo "[2/3] Starting claude-max-api proxy (with auto-restart)..."

# Run proxy in tmux window 'proxy' with restart loop
tmux kill-window -t claude-fixed:proxy 2>/dev/null
tmux new-window -t claude-fixed -n proxy
tmux send-keys -t claude-fixed:proxy "while true; do
    env -u CLAUDECODE -u CLAUDE_CODE FIRST_TOKEN_TIMEOUT_MS=300000 node /home/anggi/.npm-global/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js 2>&1 | tee /tmp/proxy-new.log
    echo '[proxy] Crashed or exited. Restarting in 3s...'
    sleep 3
done" Enter 2>/dev/null

sleep 5

if curl -s --max-time 3 http://localhost:3456/health > /dev/null; then
    echo "  Proxy: OK (port 3456)"
else
    echo "  Proxy: FAILED (check /tmp/proxy-new.log)"
fi

echo "[3/3] Starting openclaw gateway..."
python3 -c "
import subprocess, time

proc = subprocess.Popen(
    ['sudo', '-S', '-u', 'root', 'sh', '-c',
     'HOME=/root USER=root NODE_OPTIONS=\'--no-network-family-autoselection --dns-result-order=ipv4first\' exec openclaw gateway run'],
    stdin=subprocess.PIPE,
    stdout=open('/tmp/openclaw-new-run.log', 'w'),
    stderr=subprocess.STDOUT,
    start_new_session=True
)
proc.stdin.write(b'@anggi1\n')
proc.stdin.flush()
proc.stdin.close()
print(f'  openclaw PID: {proc.pid}')
"

sleep 8
if ss -tlnp 2>/dev/null | grep -q 18789; then
    echo "  OpenClaw: OK (port 18789)"
else
    echo "  OpenClaw: FAILED (check /tmp/openclaw-new-run.log)"
fi

echo ""
echo "Done! Bot @xcbrduckxbot should be active on Telegram."
