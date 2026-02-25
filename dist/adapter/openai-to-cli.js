/**
 * Converts OpenAI chat request format to Claude CLI input
 */
const MODEL_MAP = {
    "claude-opus-4": "opus",
    "claude-sonnet-4": "sonnet",
    "claude-haiku-4": "haiku",
    "claude-code-cli/claude-opus-4": "opus",
    "claude-code-cli/claude-sonnet-4": "sonnet",
    "claude-code-cli/claude-haiku-4": "haiku",
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",
};

export function extractModel(model) {
    if (MODEL_MAP[model]) return MODEL_MAP[model];
    const stripped = model.replace(/^[^/]+\//, "");
    if (MODEL_MAP[stripped]) return MODEL_MAP[stripped];
    return "sonnet";
}

/**
 * Extract plain text from message content (string OR array of content blocks)
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
 * Simple hash for deriving stable session IDs
 */
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
    // Use first user message as stable key
    const firstUser = body.messages?.find(m => m.role === "user");
    const seed = extractText(firstUser?.content || "").slice(0, 120);
    return `auto_${simpleHash(seed)}`;
}

/**
 * Convert a single message to a formatted string
 */
function formatMessage(msg) {
    const text = extractText(msg.content);
    switch (msg.role) {
        case "system":
            return `<system>\n${text}\n</system>`;
        case "user":
            return text;
        case "assistant":
            return `<assistant_response>\n${text}\n</assistant_response>`;
        case "tool":
        case "function":
            return `<tool_result>\n${text}\n</tool_result>`;
        default:
            return text;
    }
}

/**
 * Convert FULL messages array to prompt (for session initialization).
 * Formats conversation history clearly so Claude understands context.
 */
export function messagesToPrompt(messages) {
    if (!messages || messages.length === 0) return "";

    // Separate system messages from conversation
    const systemMsgs = messages.filter(m => m.role === "system");
    const convMsgs = messages.filter(m => m.role !== "system");

    const parts = [];

    if (systemMsgs.length > 0) {
        parts.push(systemMsgs.map(m => `<system>\n${extractText(m.content)}\n</system>`).join("\n"));
    }

    if (convMsgs.length === 1) {
        // Single message - just send it directly
        parts.push(extractText(convMsgs[0].content));
    } else if (convMsgs.length > 1) {
        // Multi-turn: show previous turns as context, last message as prompt
        const prevTurns = convMsgs.slice(0, -1);
        const lastMsg = convMsgs[convMsgs.length - 1];

        if (prevTurns.length > 0) {
            parts.push("<conversation_history>");
            parts.push(prevTurns.map(formatMessage).join("\n\n"));
            parts.push("</conversation_history>");
            parts.push("<current_message>");
        }
        parts.push(extractText(lastMsg.content));
        if (prevTurns.length > 0) {
            parts.push("</current_message>");
        }
    }

    return parts.join("\n\n").trim();
}

/**
 * Extract only NEW messages since lastCount (for incremental mode).
 * Claude CLI already has previous context via session ID.
 */
export function extractIncrementalPrompt(messages, lastCount) {
    const newMessages = messages.slice(lastCount);
    if (newMessages.length === 0) {
        // Fallback: resend last user message
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        return lastUser ? extractText(lastUser.content) : "";
    }

    // If only one new user message, send directly
    if (newMessages.length === 1 && newMessages[0].role === "user") {
        return extractText(newMessages[0].content);
    }

    // Multiple new messages (e.g., tool results + new user message)
    return newMessages.map(formatMessage).join("\n\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request) {
    return {
        prompt: messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user,
    };
}
