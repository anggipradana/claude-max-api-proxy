# claude-max-api-proxy

> OpenAI-compatible API server that wraps **Claude Code CLI** so you can use your Claude Max subscription with any OpenAI-compatible client (OpenClaw, Cursor, Continue, etc.).

Originally forked from [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) — significantly improved for production use.

## What's New in v2.0

### Incremental Session Messaging
Long conversations no longer resend the full history every request. The proxy tracks message counts per session:
- **First request** → sends full history, creates Claude CLI session (`--session-id`)
- **Subsequent requests** → sends only **new messages** via `--resume` (fast, no token waste)

```
[Routes] Session hdr_my-chat... INIT: 3 messages      ← first request
[Routes] Session hdr_my-chat... INCR: 3→4 (+1)        ← next request, only 1 new message sent
```

### Prompt via Stdin (no more E2BIG)
Previously, large conversations would crash with `Error: spawn E2BIG` (argument list too long). Prompts are now written to the subprocess **stdin**, bypassing OS arg size limits.

### Tool Use Support
Claude can now execute tools (Bash, file reads, web search, etc.) via:
```
--allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch
--dangerously-skip-permissions
```

### Session Management API
New endpoints for managing conversation sessions:
```
GET    /v1/sessions          → list all active sessions
DELETE /v1/sessions          → reset all sessions
DELETE /v1/sessions/:id      → reset a specific session
```

### Smart Session Derivation
Session IDs are derived automatically (no client setup required):
1. `X-Session-Id` header (explicit)
2. `user` field in request body
3. Hash of the first user message (auto)

### Extended Timeout
Default timeout increased from **5 minutes → 15 minutes** for complex agent tasks.

### OpenAI Content Array Support
Handles both string and array content format (`[{type: "text", text: "..."}]`) from modern OpenAI clients.

---

## Requirements

- Node.js ≥ 20
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated (`claude --version`)
- Claude Max subscription

## Install

```bash
npm install -g claude-max-api-proxy
```

Or clone and run directly:
```bash
git clone https://github.com/anggipradana/claude-max-api-proxy
cd claude-max-api-proxy
npm install
npm start
```

## Usage

```bash
# Start the proxy (must NOT be run inside a Claude Code session)
claude-max-api

# Or use the helper script (unsets CLAUDECODE env var automatically)
bash start-proxy.sh
```

The server starts at `http://127.0.0.1:3456`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + non-streaming) |
| `GET`  | `/v1/models` | List available models |
| `GET`  | `/health` | Health check + session count |
| `GET`  | `/v1/sessions` | List all active sessions |
| `DELETE` | `/v1/sessions` | Reset all sessions |
| `DELETE` | `/v1/sessions/:id` | Reset a specific session |

## Models

| Model ID | Maps to |
|----------|---------|
| `claude-sonnet-4` | `claude --model sonnet` |
| `claude-opus-4` | `claude --model opus` |
| `claude-haiku-4` | `claude --model haiku` |

## Session Headers

```bash
# Pin a conversation to a named session
curl -H "X-Session-Id: my-chat-123" ...

# Or use the user field
curl -d '{"user": "my-chat-123", "messages": [...]}' ...
```

## Example

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: test-1" \
  -d '{
    "model": "claude-sonnet-4",
    "stream": false,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Architecture

```
Client (OpenClaw/Cursor/etc.)
    ↓ HTTP (OpenAI format)
claude-max-api-proxy (Express)
    ↓ session tracking + prompt formatting
Claude Code CLI subprocess
    ├── --print --output-format stream-json
    ├── --session-id <uuid>   (first request)
    ├── --resume <uuid>       (subsequent requests)
    ├── --allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch
    └── --dangerously-skip-permissions
```

## ⚠ CLAUDECODE env var

If you run the proxy from within a Claude Code session, the `CLAUDECODE` env var will prevent nested CLI spawning. Always start the proxy from a clean shell:

```bash
unset CLAUDECODE && claude-max-api
```

Or use the provided `start-proxy.sh` script.

## Known Limitations

- Claude CLI sessions are file-based (`~/.claude/projects/`). Old sessions accumulate over time — use `DELETE /v1/sessions` to clear them.
- The `--resume` flag requires the previous session to have completed successfully.
- Tool execution requires Claude Max subscription with appropriate permissions.

## License

MIT
