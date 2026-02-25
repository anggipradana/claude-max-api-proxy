/**
 * Session Manager - Enhanced
 *
 * Maps conversation IDs to Claude CLI session IDs and tracks message counts
 * to enable incremental message sending (avoid resending full history).
 */
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";

const SESSION_FILE = path.join(process.env.HOME || "/tmp", ".claude-max-proxy-sessions.json");
// Session TTL: 72 hours (long-lived conversations)
const SESSION_TTL_MS = 72 * 60 * 60 * 1000;

class SessionManager {
    sessions = new Map();
    loaded = false;

    async load() {
        if (this.loaded) return;
        try {
            const data = await fs.readFile(SESSION_FILE, "utf-8");
            const parsed = JSON.parse(data);
            this.sessions = new Map(Object.entries(parsed));
            this.loaded = true;
            console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
        } catch {
            this.sessions = new Map();
            this.loaded = true;
        }
    }

    async save() {
        try {
            const data = Object.fromEntries(this.sessions);
            await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error("[SessionManager] Save error:", err);
        }
    }

    /**
     * Get or create a session mapping
     * Returns { claudeSessionId, messageCount, isNew }
     */
    getOrCreate(externalId, model = "sonnet") {
        const existing = this.sessions.get(externalId);
        if (existing) {
            existing.lastUsedAt = Date.now();
            existing.model = model;
            return { claudeSessionId: existing.claudeSessionId, messageCount: existing.messageCount, isNew: false };
        }
        const claudeSessionId = uuidv4();
        const mapping = {
            externalId,
            claudeSessionId,
            model,
            messageCount: 0,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
        };
        this.sessions.set(externalId, mapping);
        console.log(`[SessionManager] New session: ${externalId.slice(0, 20)}... → ${claudeSessionId}`);
        this.save();
        return { claudeSessionId, messageCount: 0, isNew: true };
    }

    /**
     * Update message count after successful response
     */
    updateMessageCount(externalId, count) {
        const session = this.sessions.get(externalId);
        if (session) {
            session.messageCount = count;
            session.lastUsedAt = Date.now();
            this.save();
        }
    }

    /**
     * Reset a session (force full history resend next time)
     */
    reset(externalId) {
        const session = this.sessions.get(externalId);
        if (session) {
            session.messageCount = 0;
            // Generate new claude session ID so old context is discarded
            session.claudeSessionId = uuidv4();
            session.lastUsedAt = Date.now();
            console.log(`[SessionManager] Reset session: ${externalId.slice(0, 20)}...`);
            this.save();
            return true;
        }
        return false;
    }

    /**
     * Delete a session entirely
     */
    delete(externalId) {
        const deleted = this.sessions.delete(externalId);
        if (deleted) this.save();
        return deleted;
    }

    /**
     * Clean up expired sessions
     */
    cleanup() {
        const cutoff = Date.now() - SESSION_TTL_MS;
        let removed = 0;
        for (const [key, session] of this.sessions) {
            if (session.lastUsedAt < cutoff) {
                this.sessions.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[SessionManager] Cleaned ${removed} expired sessions`);
            this.save();
        }
        return removed;
    }

    getAll() {
        return Array.from(this.sessions.values()).map(s => ({
            externalId: s.externalId,
            claudeSessionId: s.claudeSessionId,
            model: s.model,
            messageCount: s.messageCount,
            createdAt: new Date(s.createdAt).toISOString(),
            lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        }));
    }

    get size() { return this.sessions.size; }
}

export const sessionManager = new SessionManager();
sessionManager.load().catch(err => console.error("[SessionManager] Load error:", err));

// Cleanup every 6 hours
setInterval(() => sessionManager.cleanup(), 6 * 60 * 60 * 1000);
