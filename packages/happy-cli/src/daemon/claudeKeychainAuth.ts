import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { logger } from '@/ui/logger';

const execFileAsync = promisify(execFile);

/** Keychain service name Claude Code uses for its OAuth credentials on macOS. */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Whether Claude Code's OAuth credentials live in a macOS Keychain item that
 * this process can read.
 *
 * - `readable`: the item exists and is readable here — Claude manages its own
 *   tokens, nothing to inject.
 * - `locked`: the item exists but the Keychain is locked in this security
 *   session (`errSecInteractionNotAllowed`, exit 36) — a spawned Claude would
 *   report "Not logged in", so the credentials file has to be injected.
 * - `absent`: no such item (exit 44) or not macOS — Claude reads
 *   ~/.claude/.credentials.json directly, nothing to inject.
 */
export async function probeClaudeKeychainCredentials(): Promise<'readable' | 'locked' | 'absent'> {
    if (process.platform !== 'darwin') {
        return 'absent';
    }
    try {
        await execFileAsync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w']);
        return 'readable';
    } catch (error) {
        // 36 = errSecInteractionNotAllowed (Keychain locked for this session),
        // 44 = item not found. Anything else is treated as "no Keychain creds".
        return (error as { code?: number }).code === 36 ? 'locked' : 'absent';
    }
}

/**
 * Read the Claude Code OAuth credentials (access + refresh token) from the
 * on-disk credentials file (~/.claude/.credentials.json).
 *
 * Recent Claude Code versions store OAuth credentials in the macOS Keychain.
 * The Happy daemon runs under launchd (PPID 1) in a security session where the
 * login Keychain is locked, so a daemon-spawned Claude cannot read those
 * credentials and reports "Not logged in · Please run /login". The credentials
 * file, by contrast, is readable by any process of the same user, so injecting
 * its tokens via CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_REFRESH_TOKEN lets
 * daemon-spawned sessions authenticate off the file and bypass the Keychain.
 *
 * The refresh token is injected alongside the access token so the spawned
 * session can renew its access token in-memory. Without it, a long-running
 * session keeps a static access token and fails with "OAuth access token has
 * been revoked" as soon as another process rotates the file token.
 *
 * This is a last resort: injected tokens are a snapshot. The auth server
 * rotates the refresh token on use, so a session holding an injected refresh
 * token loses the race as soon as any other Claude process refreshes, and then
 * fails with "401 OAuth access token has expired". Only inject when the
 * spawned Claude genuinely cannot reach the credentials itself (Keychain
 * locked) — see probeClaudeKeychainCredentials above.
 *
 * Returns null when the file is missing/unreadable or has no OAuth access
 * token.
 */
export async function readClaudeOAuthFromCredentialsFile(): Promise<{ accessToken: string; refreshToken?: string } | null> {
    try {
        const credentialsPath = join(os.homedir(), '.claude', '.credentials.json');
        const raw = await fs.readFile(credentialsPath, 'utf8');
        const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
        const oauth = parsed.claudeAiOauth;
        if (!oauth?.accessToken) {
            return null;
        }
        return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken };
    } catch {
        return null;
    }
}

/**
 * Environment that lets a daemon-spawned Claude authenticate when its OAuth
 * credentials sit in a macOS Keychain this process cannot read.
 *
 * Injects nothing unless all of these hold:
 * - the session is Claude's (an omitted agent defaults to Claude; codex,
 *   gemini, openclaw and agy must never inherit Claude credentials),
 * - the daemon environment carries no auth of its own,
 * - ~/.claude/.credentials.json actually holds a token, and
 * - the Keychain item exists but is locked in this security session.
 *
 * When the Keychain item is readable or absent, Claude reads and refreshes the
 * credentials file itself; injecting a snapshot would only pin the session to a
 * refresh token that the next rotation invalidates.
 *
 * The file is read before the Keychain is probed even though the Keychain
 * decides the outcome: with no token on disk there is nothing to inject either
 * way, and this order keeps the common case off a `security` subprocess.
 *
 * Every daemon path that spawns a session needs this. One that skips it starts
 * a session reporting "Not logged in · Please run /login".
 */
export async function claudeLockedKeychainAuthEnv(agent: string | undefined): Promise<Record<string, string>> {
    if (agent !== undefined && agent !== 'claude') {
        return {};
    }
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        return {};
    }
    const fileOauth = await readClaudeOAuthFromCredentialsFile();
    if (!fileOauth) {
        return {};
    }
    const keychainState = await probeClaudeKeychainCredentials();
    if (keychainState !== 'locked') {
        logger.debug(`[DAEMON RUN] Leaving Claude auth to the session itself (keychain: ${keychainState})`);
        return {};
    }
    const authEnv: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: fileOauth.accessToken };
    if (fileOauth.refreshToken) {
        // Provide the refresh token + refresh flag so the spawned session renews
        // its access token in-memory instead of failing with "OAuth access token
        // has been revoked" once the file token rotates.
        // CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH keeps the refresh in-memory (no
        // write-back), so concurrent sessions don't race.
        authEnv.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = fileOauth.refreshToken;
        authEnv.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH = '1';
    }
    logger.debug('[DAEMON RUN] Injected Claude OAuth token (+refresh) from ~/.claude/.credentials.json (Keychain locked)');
    return authEnv;
}
