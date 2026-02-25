/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import fs from "fs";
import path from "path";
import os from "os";

// ─── Model Map ────────────────────────────────────────────────────────────────
// Maps OpenAI/external model IDs → claude CLI --model value
// Versioned IDs (e.g. claude-sonnet-4-6) are passed through as-is.
// Aliases map to claude CLI shorthand (sonnet / opus / haiku).
const MODEL_MAP = {
    // ── Versioned Claude models (passed through to CLI) ──
    "claude-opus-4-5":              "claude-opus-4-5",
    "claude-sonnet-4-5":            "claude-sonnet-4-5",
    "claude-haiku-4-5":             "claude-haiku-4-5",
    "claude-haiku-4-5-20251001":    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6":            "claude-sonnet-4-6",

    // ── Family aliases ──
    "claude-opus-4":    "opus",
    "claude-sonnet-4":  "sonnet",
    "claude-haiku-4":   "haiku",
    "opus":             "opus",
    "sonnet":           "sonnet",
    "haiku":            "haiku",

    // ── claude-code-cli/ prefixed variants ──
    "claude-code-cli/claude-opus-4":            "opus",
    "claude-code-cli/claude-sonnet-4":          "sonnet",
    "claude-code-cli/claude-haiku-4":           "haiku",
    "claude-code-cli/claude-opus-4-5":          "claude-opus-4-5",
    "claude-code-cli/claude-sonnet-4-5":        "claude-sonnet-4-5",
    "claude-code-cli/claude-haiku-4-5":         "claude-haiku-4-5",
    "claude-code-cli/claude-sonnet-4-6":        "claude-sonnet-4-6",

    // ── GPT compatibility aliases (drop-in for OpenAI clients) ──
    "gpt-4o":               "sonnet",
    "gpt-4o-mini":          "haiku",
    "gpt-4o-2024-11-20":    "sonnet",
    "gpt-4":                "opus",
    "gpt-4-turbo":          "opus",
    "gpt-4-turbo-preview":  "opus",
    "gpt-3.5-turbo":        "haiku",
    "gpt-3.5-turbo-0125":   "haiku",
    "o1":                   "opus",
    "o1-mini":              "sonnet",
    "o1-preview":           "opus",
    "o3-mini":              "sonnet",
};

export function extractModel(model) {
    if (!model) return "sonnet";
    if (MODEL_MAP[model]) return MODEL_MAP[model];
    // Strip provider prefix (e.g. "openrouter/claude-sonnet-4" → "claude-sonnet-4")
    const stripped = model.replace(/^[^/]+\//, "");
    if (MODEL_MAP[stripped]) return MODEL_MAP[stripped];
    // Pass through unknown versioned model IDs to Claude CLI
    if (model.startsWith("claude-")) return model;
    return "sonnet";
}

// ─── Model list for /v1/models endpoint ──────────────────────────────────────
export const AVAILABLE_MODELS = [
    // Latest versioned
    { id: "claude-sonnet-4-6",  family: "sonnet", description: "Claude Sonnet 4.6 — latest sonnet" },
    { id: "claude-sonnet-4-5",  family: "sonnet", description: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5",   family: "haiku",  description: "Claude Haiku 4.5 — latest haiku" },
    { id: "claude-opus-4-5",    family: "opus",   description: "Claude Opus 4.5" },
    // Family aliases
    { id: "claude-opus-4",   family: "opus",   description: "Claude Opus 4 (latest opus)" },
    { id: "claude-sonnet-4", family: "sonnet", description: "Claude Sonnet 4 (latest sonnet)" },
    { id: "claude-haiku-4",  family: "haiku",  description: "Claude Haiku 4 (latest haiku)" },
    // GPT aliases
    { id: "gpt-4o",           family: "sonnet", description: "GPT-4o alias → claude-sonnet-4" },
    { id: "gpt-4o-mini",      family: "haiku",  description: "GPT-4o-mini alias → claude-haiku-4" },
    { id: "gpt-4",            family: "opus",   description: "GPT-4 alias → claude-opus-4" },
    { id: "gpt-3.5-turbo",    family: "haiku",  description: "GPT-3.5-turbo alias → claude-haiku-4" },
];

// ─── Content extraction ───────────────────────────────────────────────────────

/**
 * Extract plain text from message content (string OR OpenAI content block array).
 */
export function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(c => c.type === "text")
            .map(c => c.text || "")
            .join("");
    }
    return String(content ?? "");
}

/**
 * Extract image blocks from content and save them to temp files.
 * Returns array of { filePath, mediaType, index }.
 * Caller is responsible for cleaning up temp files.
 */
export function extractImages(content) {
    if (!Array.isArray(content)) return [];
    const images = [];
    content.forEach((block, i) => {
        if (block.type !== "image_url" && block.type !== "image") return;

        let dataUrl = block.image_url?.url || block.source?.data;
        let mediaType = "image/png";

        if (dataUrl && dataUrl.startsWith("data:")) {
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)/);
            if (match) {
                mediaType = match[1];
                const base64Data = match[2];
                const ext = mediaType.split("/")[1] || "png";
                const filePath = path.join(os.tmpdir(), `claude_img_${Date.now()}_${i}.${ext}`);
                try {
                    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
                    images.push({ filePath, mediaType, index: i });
                } catch {
                    // ignore write errors
                }
            }
        } else if (dataUrl && (dataUrl.startsWith("http://") || dataUrl.startsWith("https://"))) {
            // URL-based image — include the URL in the prompt text
            images.push({ url: dataUrl, mediaType, index: i });
        }
    });
    return images;
}

/**
 * Extract combined system prompt text from all system messages.
 * Returns null if no system messages found.
 */
export function extractSystemPrompt(messages) {
    const systemMsgs = messages.filter(m => m.role === "system");
    if (systemMsgs.length === 0) return null;
    return systemMsgs.map(m => extractText(m.content)).join("\n\n");
}

// ─── Session ID derivation ────────────────────────────────────────────────────

export function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Derive a stable session ID from a request.
 * Priority: X-Session-Id header > user field > hash of first user message
 */
export function deriveSessionId(req, body) {
    if (req.headers["x-session-id"]) {
        return `hdr_${req.headers["x-session-id"]}`;
    }
    if (body.user) {
        return `usr_${body.user}`;
    }
    const firstUser = body.messages?.find(m => m.role === "user");
    const seed = extractText(firstUser?.content || "").slice(0, 120);
    return `auto_${simpleHash(seed)}`;
}

// ─── Prompt formatting ────────────────────────────────────────────────────────

/**
 * Format a single message for conversation history.
 * Handles text + image blocks.
 */
function formatMessage(msg) {
    const text = extractText(msg.content);
    const images = Array.isArray(msg.content) ? extractImages(msg.content) : [];
    const imageNote = images.map(img =>
        img.filePath
            ? `[Image: ${img.filePath}]`
            : `[Image URL: ${img.url}]`
    ).join("\n");
    const fullText = [text, imageNote].filter(Boolean).join("\n");

    switch (msg.role) {
        case "system":
            return `<system>\n${fullText}\n</system>`;
        case "user":
            return fullText;
        case "assistant":
            return `<assistant_response>\n${fullText}\n</assistant_response>`;
        case "tool":
        case "function":
            return `<tool_result>\n${fullText}\n</tool_result>`;
        default:
            return fullText;
    }
}

/**
 * Convert FULL messages array to prompt (for INIT / new session).
 * System messages are excluded here — pass them via --system-prompt flag instead.
 */
export function messagesToPrompt(messages) {
    if (!messages || messages.length === 0) return "";

    // Exclude system messages (handled via --system-prompt in subprocess)
    const convMsgs = messages.filter(m => m.role !== "system");
    if (convMsgs.length === 0) return "";

    if (convMsgs.length === 1) {
        return formatMessage(convMsgs[0]);
    }

    // Multi-turn: wrap history + current message
    const prevTurns = convMsgs.slice(0, -1);
    const lastMsg = convMsgs[convMsgs.length - 1];
    const parts = [];

    parts.push("<conversation_history>");
    parts.push(prevTurns.map(formatMessage).join("\n\n"));
    parts.push("</conversation_history>");
    parts.push("<current_message>");
    parts.push(formatMessage(lastMsg));
    parts.push("</current_message>");

    return parts.join("\n\n").trim();
}

/**
 * Extract only NEW messages since lastCount (for INCR / resume mode).
 * System prompt is already part of the session — skip it here too.
 */
export function extractIncrementalPrompt(messages, lastCount) {
    const newMessages = messages.slice(lastCount).filter(m => m.role !== "system");
    if (newMessages.length === 0) {
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        return lastUser ? formatMessage(lastUser) : "";
    }
    if (newMessages.length === 1 && newMessages[0].role === "user") {
        return formatMessage(newMessages[0]);
    }
    return newMessages.map(formatMessage).join("\n\n").trim();
}
