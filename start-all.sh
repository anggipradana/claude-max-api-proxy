#!/bin/bash
# Start claude-proxy + claude-code-telegram bot

echo "[0/2] Ensuring Telegram IPv4 in /etc/hosts..."
if ! grep -q "api.telegram.org" /etc/hosts 2>/dev/null; then
    echo '@anggi1' | sudo -S bash -c 'echo "149.154.166.110 api.telegram.org" >> /etc/hosts' 2>/dev/null
    echo "  Added api.telegram.org → 149.154.166.110"
else
    echo "  api.telegram.org already in /etc/hosts"
fi

echo "[1/2] Killing old processes..."

# Kill anything on port 3456 (proxy)
fuser -k 3456/tcp 2>/dev/null && echo "  Killed process on port 3456"

# Kill old telegram bot
pkill -f "claude-telegram-bot" 2>/dev/null && echo "  Killed old claude-telegram-bot"

# Wait for port 3456 to be fully free
for i in $(seq 1 10); do
    ss -tlnp | grep -q 3456 || break
    sleep 1
done

echo "[2/2] Starting claude-max-api proxy (with auto-restart)..."

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

echo "[3/3] Starting claude-code-telegram bot (with auto-restart)..."

# Run bot in tmux window 'telegram' with restart loop
tmux kill-window -t claude-fixed:telegram 2>/dev/null
tmux new-window -t claude-fixed -n telegram
tmux send-keys -t claude-fixed:telegram "cd /home/anggi/claude-telegram-bot && while true; do
    env -u CLAUDECODE -u CLAUDE_CODE /home/anggi/.local/bin/claude-telegram-bot --config-file .env 2>&1 | tee /tmp/claude-telegram-bot.log
    echo '[telegram-bot] Crashed or exited. Restarting in 5s...'
    sleep 5
done" Enter 2>/dev/null

sleep 5

if grep -q "Application started" /tmp/claude-telegram-bot.log 2>/dev/null; then
    echo "  Telegram bot: OK (@xcbrduckxbot)"
else
    echo "  Telegram bot: FAILED (check /tmp/claude-telegram-bot.log)"
fi

echo ""
echo "Done! Bot @xcbrduckxbot should be active on Telegram."
