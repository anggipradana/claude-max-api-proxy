#!/bin/bash
# Start claude-max-api-proxy safely outside of any Claude Code session

unset CLAUDECODE
unset CLAUDE_CODE

# Kill existing proxy instance (safe - uses /proc to avoid matching shell)
for pid in $(pgrep -x node 2>/dev/null); do
    cmd=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ')
    if echo "$cmd" | grep -q "max-api"; then
        kill "$pid" 2>/dev/null && echo "Killed old proxy PID $pid"
    fi
done

sleep 1

exec node "$(dirname "$0")/dist/server/standalone.js" "$@"
