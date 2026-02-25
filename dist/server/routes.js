/**
 * API Route Handlers - Enhanced
 *
 * Features:
 *  - Incremental session messaging (INIT / INCR)
 *  - System prompt via --system-prompt flag
 *  - Concurrency control (semaphore)
 *  - Request stats tracking
 *  - Full model list with versioned + GPT aliases
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess, getActiveSubprocessCount } from "../subprocess/manager.js";
import {
    extractModel, deriveSessionId, extractSystemPrompt,
    messagesToPrompt, extractIncrementalPrompt, AVAILABLE_MODELS,
} from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";

// ─── Session-not-found detection ─────────────────────────────────────────────
function isSessionNotFoundError(result) {
    return result?.is_error === true &&
        Array.isArray(result?.errors) &&
        result.errors.some(e => typeof e === "string" && e.includes("No conversation found"));
}

// ─── Timeout constants ────────────────────────────────────────────────────────
const FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env.FIRST_TOKEN_TIMEOUT_MS || "90000");  // 90s
const INACTIVITY_TIMEOUT_MS  = parseInt(process.env.INACTIVITY_TIMEOUT_MS  || "120000"); // 120s
const KEEPALIVE_INTERVAL_MS  = parseInt(process.env.KEEPALIVE_INTERVAL_MS  || "20000");  // 20s

// ─── Per-session active request guard ─────────────────────────────────────────
const activeSessionRequests = new Set();

// ─── Concurrency Semaphore ────────────────────────────────────────────────────
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4");

class Semaphore {
    constructor(max) {
        this.max = max;
        this.active = 0;
        this.queue = [];
    }
    acquire() {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        this.active--;
        if (this.queue.length > 0) {
            this.active++;
            this.queue.shift()();
        }
    }
}
const semaphore = new Semaphore(MAX_CONCURRENT);

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
    startedAt: Date.now(),
    totalRequests: 0,
    completedRequests: 0,
    errorRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    responseTimes: [],   // rolling last 100
};

function recordResponseTime(ms) {
    stats.responseTimes.push(ms);
    if (stats.responseTimes.length > 100) stats.responseTimes.shift();
}

function avgResponseTime() {
    if (stats.responseTimes.length === 0) return 0;
    return Math.round(stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    const requestStart = Date.now();
    stats.totalRequests++;

    // Reject if queue is full
    if (semaphore.queue.length >= MAX_CONCURRENT * 2) {
        stats.errorRequests++;
        return res.status(429).json({
            error: { message: "Too many concurrent requests. Try again shortly.", type: "rate_limit_error", code: "concurrency_limit" },
        });
    }

    try {
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            stats.errorRequests++;
            return res.status(400).json({
                error: { message: "messages is required and must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
            });
        }

        // ── Session Management ──
        await sessionManager.load();
        const externalSessionId = deriveSessionId(req, body);

        // ── Per-session duplicate request guard ──
        if (activeSessionRequests.has(externalSessionId)) {
            const waitMsg = "⏳ Masih memproses pesan sebelumnya, harap tunggu.";
            if (stream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                const chunk = {
                    id: `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || "claude-sonnet-4",
                    choices: [{ index: 0, delta: { role: "assistant", content: waitMsg }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            } else {
                res.json({
                    id: `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || "claude-sonnet-4",
                    choices: [{ index: 0, message: { role: "assistant", content: waitMsg }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                });
            }
            return;
        }
        activeSessionRequests.add(externalSessionId);

        const model = extractModel(body.model || "claude-sonnet-4");
        const { claudeSessionId, messageCount, isNew } = sessionManager.getOrCreate(externalSessionId, model);

        // ── System prompt (extracted separately → passed via --system-prompt) ──
        const systemPrompt = extractSystemPrompt(body.messages);

        // ── Prompt (INIT vs INCR) ──
        let prompt;
        const totalMessages = body.messages.length;
        const isNewSession = isNew || messageCount === 0;

        if (isNewSession || totalMessages <= messageCount) {
            prompt = messagesToPrompt(body.messages);
            console.error(`[Routes] Session ${externalSessionId.slice(0, 16)}... INIT: ${totalMessages} messages`);
        } else {
            prompt = extractIncrementalPrompt(body.messages, messageCount);
            console.error(`[Routes] Session ${externalSessionId.slice(0, 16)}... INCR: ${messageCount}→${totalMessages} (+${totalMessages - messageCount})`);
        }

        const cliInput = { prompt, model, sessionId: claudeSessionId, isNewSession, systemPrompt };

        const onSuccess = (result) => {
            sessionManager.updateMessageCount(externalSessionId, totalMessages);
            stats.completedRequests++;
            recordResponseTime(Date.now() - requestStart);
            if (result?.usage) {
                stats.totalInputTokens += result.usage.input_tokens || 0;
                stats.totalOutputTokens += result.usage.output_tokens || 0;
            }
        };

        // ── onTimeout: always update message count to prevent INCR explosion ──
        // Never reset session — resetting forces a full INIT on next request which
        // is slow for large contexts and creates an infinite timeout loop.
        // Keeping the session ID means next request is a fast INCR (just new messages).
        const onTimeout = () => {
            stats.errorRequests++;
            sessionManager.updateMessageCount(externalSessionId, totalMessages);
        };

        // ── Run with auto-retry on session-not-found ──
        const runAttempt = async (input) => {
            await semaphore.acquire();
            const subprocess = new ClaudeSubprocess();
            try {
                if (stream) {
                    return await handleStreamingResponse(req, res, subprocess, input, requestId, onSuccess, onTimeout);
                } else {
                    return await handleNonStreamingResponse(res, subprocess, input, requestId, onSuccess, onTimeout);
                }
            } finally {
                semaphore.release();
            }
        };

        try {
            let outcome = await runAttempt(cliInput);

            if (outcome?.sessionError) {
                console.error(`[Routes] Session not found for ${externalSessionId.slice(0, 16)}... — resetting and retrying`);
                sessionManager.reset(externalSessionId);
                const { claudeSessionId: newSessionId } = sessionManager.getOrCreate(externalSessionId, model);
                await runAttempt({
                    ...cliInput,
                    sessionId: newSessionId,
                    isNewSession: true,
                    prompt: messagesToPrompt(body.messages),
                });
            }
        } finally {
            activeSessionRequests.delete(externalSessionId);
        }
    } catch (error) {
        stats.errorRequests++;
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({ error: { message, type: "server_error", code: null } });
        }
    }
}

// ─── Streaming response ───────────────────────────────────────────────────────

async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, onSuccess, onTimeout) {
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
        let finalResult = null;
        let lastActivityAt = Date.now();

        // ── safeResolve: ensures timers are cleared and resolve is called once ──
        let resolved = false;
        const timers = { keepAlive: null, firstToken: null, inactivity: null };
        const safeResolve = (value) => {
            if (resolved) return;
            resolved = true;
            clearInterval(timers.keepAlive);
            clearTimeout(timers.firstToken);
            clearInterval(timers.inactivity);
            resolve(value);
        };

        // ── Helper: send a text chunk then close stream ──
        const sendTimeoutMessage = (msg) => {
            if (!res.writableEnded) {
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: isFirst ? "assistant" : undefined, content: msg }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
        };

        // ── Keepalive ping every 20s to prevent SSE connection drop ──
        timers.keepAlive = setInterval(() => {
            if (!res.writableEnded) res.write(": ping\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        // ── First-token timeout: kill if no content after 90s ──
        timers.firstToken = setTimeout(() => {
            if (isFirst) {
                console.error(`[Streaming] First-token timeout (${FIRST_TOKEN_TIMEOUT_MS}ms) for request ${requestId}`);
                onTimeout();
                subprocess.kill();
                sendTimeoutMessage("⏱️ Waktu tunggu habis. Coba kirim ulang pesan.");
                safeResolve({ sessionError: false });
            }
        }, FIRST_TOKEN_TIMEOUT_MS);

        // ── Inactivity check: kill if no delta for 120s after streaming started ──
        timers.inactivity = setInterval(() => {
            if (!isComplete && !isFirst && (Date.now() - lastActivityAt) > INACTIVITY_TIMEOUT_MS) {
                console.error(`[Streaming] Inactivity timeout (${INACTIVITY_TIMEOUT_MS}ms) for request ${requestId}`);
                onTimeout();
                subprocess.kill();
                sendTimeoutMessage("⚠️ Tidak ada aktivitas. Coba lagi.");
                safeResolve({ sessionError: false });
            }
        }, 10000);

        res.on("close", () => {
            if (!isComplete) subprocess.kill();
            safeResolve({ sessionError: false });
        });

        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) {
                if (isFirst) {
                    // First token received — cancel first-token timeout
                    clearTimeout(timers.firstToken);
                    timers.firstToken = null;
                }
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: isFirst ? "assistant" : undefined, content: text }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
                lastActivityAt = Date.now();
            }
        });

        subprocess.on("assistant", (message) => {
            if (message.message?.model) lastModel = message.message.model;
        });

        subprocess.on("result", (result) => {
            // Auto-recovery: if session file deleted and no content sent yet, retry transparently
            if (isSessionNotFoundError(result) && isFirst) {
                console.error("[Streaming] Session not found, will retry with new session");
                safeResolve({ sessionError: true });
                return;
            }
            finalResult = result;
            isComplete = true;
            onSuccess(result);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            safeResolve({ sessionError: false });
        });

        subprocess.on("error", (error) => {
            stats.errorRequests++;
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "server_error", code: null } })}\n\n`);
                res.end();
            }
            safeResolve({ sessionError: false });
        });

        subprocess.on("close", (code) => {
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    res.write(`data: ${JSON.stringify({ error: { message: `Process exited with code ${code}`, type: "server_error", code: null } })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            safeResolve({ sessionError: false });
        });

        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            isNewSession: cliInput.isNewSession,
            systemPrompt: cliInput.systemPrompt,
        }).catch(err => {
            stats.errorRequests++;
            console.error("[Streaming] Start error:", err);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: null } })}\n\n`);
                res.end();
            }
            safeResolve({ sessionError: false });
        });
    });
}

// ─── Non-streaming response ───────────────────────────────────────────────────

async function handleNonStreamingResponse(res, subprocess, cliInput, requestId, onSuccess, onTimeout) {
    return new Promise((resolve) => {
        let finalResult = null;

        // ── safeResolve: ensures overallTimer is cleared and resolve is called once ──
        let resolved = false;
        const safeResolve = (value) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(overallTimer);
            resolve(value);
        };

        // ── Overall timeout (first-token + inactivity = 210s by default) ──
        const overallTimer = setTimeout(() => {
            console.error(`[NonStreaming] Overall timeout for request ${requestId}`);
            onTimeout();
            subprocess.kill();
            if (!res.headersSent) {
                res.status(503).json({
                    error: { message: "⏱️ Waktu tunggu habis. Coba kirim ulang.", type: "timeout_error", code: "timeout" },
                });
            }
            safeResolve({ sessionError: false });
        }, FIRST_TOKEN_TIMEOUT_MS + INACTIVITY_TIMEOUT_MS);

        subprocess.on("result", (result) => { finalResult = result; });

        subprocess.on("error", (error) => {
            stats.errorRequests++;
            console.error("[NonStreaming] Error:", error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
            }
            safeResolve({ sessionError: false });
        });

        subprocess.on("close", (code) => {
            if (finalResult) {
                // Auto-recovery: session file deleted → retry transparently
                if (isSessionNotFoundError(finalResult)) {
                    console.error("[NonStreaming] Session not found, will retry with new session");
                    safeResolve({ sessionError: true });
                    return;
                }
                onSuccess(finalResult);
                res.json(cliResultToOpenai(finalResult, requestId));
            } else if (!res.headersSent) {
                stats.errorRequests++;
                res.status(500).json({
                    error: { message: `Claude CLI exited with code ${code} without response`, type: "server_error", code: null },
                });
            }
            safeResolve({ sessionError: false });
        });

        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            isNewSession: cliInput.isNewSession,
            systemPrompt: cliInput.systemPrompt,
        }).catch(error => {
            stats.errorRequests++;
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
            }
            safeResolve({ sessionError: false });
        });
    });
}

// ─── GET /v1/models ───────────────────────────────────────────────────────────

export function handleModels(_req, res) {
    const created = Math.floor(Date.now() / 1000);
    res.json({
        object: "list",
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: "model",
            owned_by: "anthropic",
            created,
            description: m.description,
        })),
    });
}

// ─── GET /health ──────────────────────────────────────────────────────────────

export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        sessions: sessionManager.size,
        activeSessions: activeSessionRequests.size,
        activeSubprocesses: getActiveSubprocessCount(),
        concurrencyLimit: MAX_CONCURRENT,
        queuedRequests: semaphore.queue.length,
        timestamp: new Date().toISOString(),
    });
}

// ─── GET /stats ───────────────────────────────────────────────────────────────

export function handleStats(_req, res) {
    const uptimeMs = Date.now() - stats.startedAt;
    res.json({
        uptime: {
            ms: uptimeMs,
            human: formatUptime(uptimeMs),
        },
        requests: {
            total: stats.totalRequests,
            completed: stats.completedRequests,
            errors: stats.errorRequests,
            active: getActiveSubprocessCount(),
            queued: semaphore.queue.length,
        },
        concurrency: {
            limit: MAX_CONCURRENT,
            active: semaphore.active,
        },
        sessions: {
            total: sessionManager.size,
        },
        tokens: {
            totalInput: stats.totalInputTokens,
            totalOutput: stats.totalOutputTokens,
            total: stats.totalInputTokens + stats.totalOutputTokens,
        },
        performance: {
            avgResponseMs: avgResponseTime(),
            sampledRequests: stats.responseTimes.length,
        },
    });
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

// ─── Session endpoints ────────────────────────────────────────────────────────

export async function handleSessionsList(_req, res) {
    await sessionManager.load();
    res.json({ sessions: sessionManager.getAll(), total: sessionManager.size });
}

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

export async function handleSessionsResetAll(_req, res) {
    await sessionManager.load();
    const sessions = sessionManager.getAll();
    for (const s of sessions) sessionManager.reset(s.externalId);
    res.json({ ok: true, message: `Reset ${sessions.length} sessions` });
}
