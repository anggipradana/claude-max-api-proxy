/**
 * Session Manager
 *
 * Maps Clawdbot conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
 */
export interface SessionMapping {
    clawdbotId: string;
    claudeSessionId: string;
    createdAt: number;
    lastUsedAt: number;
    model: string;
}
declare class SessionManager {
    private sessions;
    private loaded;
    /**
     * Load sessions from disk
     */
    load(): Promise<void>;
    /**
     * Save sessions to disk
     */
    save(): Promise<void>;
    /**
     * Get or create a Claude session ID for a Clawdbot conversation
     */
    getOrCreate(clawdbotId: string, model?: string): string;
    /**
     * Get existing session if it exists
     */
    get(clawdbotId: string): SessionMapping | undefined;
    /**
     * Delete a session
     */
    delete(clawdbotId: string): boolean;
    /**
     * Clean up expired sessions
     */
    cleanup(): number;
    /**
     * Get all active sessions
     */
    getAll(): SessionMapping[];
    /**
     * Get session count
     */
    get size(): number;
}
export declare const sessionManager: SessionManager;
export {};
//# sourceMappingURL=manager.d.ts.map