// HAPPY_RECONNECT_* env vars are scoped to a single resume-spawned child process.
// They tell that one child to attach to an existing happySessionId instead of
// creating a new one. If they leak into the daemon's environment they propagate
// to every spawned child via {...process.env}, causing every new session to
// reconnect to the same old session id (and inherit its old metadata.path).
export const RECONNECT_ENV_KEYS = [
    'HAPPY_RECONNECT_SESSION_ID',
    'HAPPY_RECONNECT_ENCRYPTION_KEY',
    'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
    'HAPPY_RECONNECT_SEQ',
    'HAPPY_RECONNECT_METADATA_VERSION',
    'HAPPY_RECONNECT_AGENT_STATE_VERSION',
] as const;

export function stripReconnectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned = { ...env };
    for (const key of RECONNECT_ENV_KEYS) {
        delete cleaned[key];
    }
    return cleaned;
}

export function deleteReconnectEnvFromProcess(): void {
    for (const key of RECONNECT_ENV_KEYS) {
        delete process.env[key];
    }
}
