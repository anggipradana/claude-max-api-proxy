/**
 * Claude Code CLI Subprocess Manager - Enhanced
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";

// 15 minutes - enough for complex multi-step agent tasks
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

export class ClaudeSubprocess extends EventEmitter {
    process = null;
    buffer = "";
    timeoutId = null;
    isKilled = false;

    async start(prompt, options) {
        const args = this.buildArgs(options);
        const timeout = options.timeout || DEFAULT_TIMEOUT;

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });

                this.timeoutId = setTimeout(() => {
                    if (!this.isKilled) {
                        this.isKilled = true;
                        this.process?.kill("SIGTERM");
                        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
                    }
                }, timeout);

                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        reject(new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"));
                    } else {
                        reject(err);
                    }
                });

                // Write prompt via stdin to avoid E2BIG (arg list too long) for large contexts
                this.process.stdin?.write(prompt, "utf8");
                this.process.stdin?.end();
                console.error(`[Subprocess] Spawned PID:${this.process.pid} session:${options.sessionId || "none"} model:${options.model}`);

                this.process.stdout?.on("data", (chunk) => {
                    const data = chunk.toString();
                    this.buffer += data;
                    this.processBuffer();
                });

                this.process.stderr?.on("data", (chunk) => {
                    const text = chunk.toString().trim();
                    if (text) console.error(`[Subprocess stderr]:`, text.slice(0, 300));
                });

                this.process.on("close", (code) => {
                    console.error(`[Subprocess] PID:${this.process?.pid} exited code:${code}`);
                    this.clearTimeout();
                    if (this.buffer.trim()) this.processBuffer();
                    this.emit("close", code);
                });

                resolve();
            } catch (err) {
                this.clearTimeout();
                reject(err);
            }
        });
    }

    buildArgs(options) {
        const args = [
            "--print",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", options.model,
            // Tools for agent capability
            "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch",
            "--dangerously-skip-permissions",
        ];

        if (options.sessionId) {
            if (options.isNewSession) {
                // First time: create new session with this ID
                args.push("--session-id", options.sessionId);
            } else {
                // Subsequent requests: resume existing session
                args.push("--resume", options.sessionId);
            }
        } else {
            // No session tracking - stateless mode
            args.push("--no-session-persistence");
        }

        // No prompt in args - prompt is passed via stdin to avoid E2BIG
        return args;
    }

    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    this.emit("content_delta", message);
                } else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                } else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            } catch {
                this.emit("raw", trimmed);
            }
        }
    }

    clearTimeout() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    kill(signal = "SIGTERM") {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }

    isRunning() {
        return this.process !== null && !this.isKilled && this.process.exitCode === null;
    }
}

export async function verifyClaude() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: "pipe" });
        let output = "";
        proc.stdout?.on("data", chunk => { output += chunk.toString(); });
        proc.on("error", () => resolve({ ok: false, error: "Claude CLI not found." }));
        proc.on("close", code => {
            if (code === 0) resolve({ ok: true, version: output.trim() });
            else resolve({ ok: false, error: "Claude CLI non-zero exit" });
        });
    });
}

export async function verifyAuth() {
    return { ok: true };
}
