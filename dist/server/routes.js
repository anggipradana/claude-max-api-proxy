/**
 * API Route Handlers - Enhanced
 *
 * OpenAI-compatible endpoints with smart session management:
 * - First request in a session: sends full conversation history
 * - Subsequent requests: sends only NEW messages (incremental)
 * - Claude CLI persists context via --session-id
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { extractModel, deriveSessionId, messagesToPrompt, extractIncrementalPrompt } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";

/**
 * Handle POST /v1/chat/completions
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;

    try {
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: { message: "messages is required and must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
            });
            return;
        }

        // --- Session Management ---
        await sessionManager.load();
        const externalSessionId = deriveSessionId(req, body);
        const model = extractModel(body.model || "claude-sonnet-4");
        const { claudeSessionId, messageCount, isNew } = sessionManager.getOrCreate(externalSessionId, model);

        // Determine prompt: full history for new sessions, incremental for existing
        let prompt;
        const totalMessages = body.messages.length;

        if (isNew || messageCount === 0 || totalMessages <= messageCount) {
            // New session OR history rewound/reset → send full history
            prompt = messagesToPrompt(body.messages);
            console.error(`[Routes] Session ${externalSessionId.slice(0, 16)}... INIT: ${totalMessages} messages`);
        } else {
            // Existing session → only send new messages (incremental)
            prompt = extractIncrementalPrompt(body.messages, messageCount);
            console.error(`[Routes] Session ${externalSessionId.slice(0, 16)}... INCR: ${messageCount}→${totalMessages} (+${totalMessages - messageCount})`);
        }

        const cliInput = {
            prompt,
            model,
            sessionId: claudeSessionId,
            isNewSession: isNew || messageCount === 0,
        };

        const subprocess = new ClaudeSubprocess();

        // Update message count after we get a response (via callback)
        const onSuccess = () => {
            sessionManager.updateMessageCount(externalSessionId, totalMessages);
        };

        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, onSuccess);
        } else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, onSuccess);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({ error: { message, type: "server_error", code: null } });
        }
    }
}

async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, onSuccess) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    res.write(":ok\n\n");

    return new Promise((resolve) => {
        let isFirst = true;
        let lastModel = cliInput.model;
        let isComplete = false;
        let hasContent = false;

        res.on("close", () => {
            if (!isComplete) subprocess.kill();
            resolve();
        });

        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) {
                hasContent = true;
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: isFirst ? "assistant" : undefined, content: text }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
            }
        });

        subprocess.on("assistant", (message) => {
            if (message.message?.model) lastModel = message.message.model;
        });

        subprocess.on("result", () => {
            isComplete = true;
            onSuccess();
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });

        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "server_error", code: null } })}\n\n`);
                res.end();
            }
            resolve();
        });

        subprocess.on("close", (code) => {
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    res.write(`data: ${JSON.stringify({ error: { message: `Process exited with code ${code}`, type: "server_error", code: null } })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });

        subprocess.start(cliInput.prompt, { model: cliInput.model, sessionId: cliInput.sessionId, isNewSession: cliInput.isNewSession })
            .catch(err => {
                console.error("[Streaming] Start error:", err);
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: null } })}\n\n`);
                    res.end();
                }
                resolve();
            });
    });
}

async function handleNonStreamingResponse(res, subprocess, cliInput, requestId, onSuccess) {
    return new Promise((resolve) => {
        let finalResult = null;

        subprocess.on("result", (result) => { finalResult = result; });

        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
            }
            resolve();
        });

        subprocess.on("close", (code) => {
            if (finalResult) {
                onSuccess();
                res.json(cliResultToOpenai(finalResult, requestId));
            } else if (!res.headersSent) {
                res.status(500).json({
                    error: { message: `Claude CLI exited with code ${code} without response`, type: "server_error", code: null },
                });
            }
            resolve();
        });

        subprocess.start(cliInput.prompt, { model: cliInput.model, sessionId: cliInput.sessionId, isNewSession: cliInput.isNewSession })
            .catch(error => {
                if (!res.headersSent) {
                    res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
                }
                resolve();
            });
    });
}

/**
 * GET /v1/models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-haiku-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
        ],
    });
}

/**
 * GET /health
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        sessions: sessionManager.size,
        timestamp: new Date().toISOString(),
    });
}

/**
 * GET /v1/sessions - List all active sessions
 */
export async function handleSessionsList(_req, res) {
    await sessionManager.load();
    res.json({ sessions: sessionManager.getAll(), total: sessionManager.size });
}

/**
 * DELETE /v1/sessions/:id - Reset a specific session
 */
export async function handleSessionReset(req, res) {
    await sessionManager.load();
    const id = req.params.id;
    const reset = sessionManager.reset(id);
    if (reset) {
        res.json({ ok: true, message: `Session ${id} reset` });
    } else {
        res.status(404).json({ error: { message: `Session ${id} not found`, type: "not_found", code: null } });
    }
}

/**
 * DELETE /v1/sessions - Reset ALL sessions
 */
export async function handleSessionsResetAll(_req, res) {
    await sessionManager.load();
    const sessions = sessionManager.getAll();
    for (const s of sessions) sessionManager.reset(s.externalId);
    res.json({ ok: true, message: `Reset ${sessions.length} sessions` });
}
