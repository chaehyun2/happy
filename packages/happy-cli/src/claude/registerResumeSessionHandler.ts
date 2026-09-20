// Type-only so this handler adds nothing to the module graph: importing
// RpcHandlerManager for its value pulls in apiSession -> registerCommonHandlers,
// which reaches for node:child_process `exec` at import time and breaks any
// suite that mocks that module partially (claudeRemoteLauncher.test.ts).
import type { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import type { Session } from "./session";
import { logger } from "@/ui/logger";

interface ResumeSessionRequest {
    // No parameters needed
}

interface ResumeSessionResponse {
    success: boolean;
    message: string;
}

export function registerResumeSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    session: Session,
    abortCurrentSession: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<ResumeSessionRequest, ResumeSessionResponse>('resumeSession', async () => {
        logger.debug('[resumeSession] Resume session request received');

        const result = session.requestResume();
        if (!result.success) {
            return result;
        }

        // Abort the current Claude process so the loop restarts with --resume
        await abortCurrentSession();

        return {
            success: true,
            message: 'Session resume initiated'
        };
    });
}
