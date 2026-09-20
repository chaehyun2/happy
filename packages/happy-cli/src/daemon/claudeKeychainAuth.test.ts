import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
    readFile: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('fs/promises', () => ({ default: { readFile: mocks.readFile } }));
vi.mock('os', () => ({ default: { homedir: () => '/home/fixture' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { claudeLockedKeychainAuthEnv } from './claudeKeychainAuth';

/** Make the promisified execFile resolve, as `security` does when the item is readable. */
function keychainReadable() {
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => cb(null, { stdout: 'token', stderr: '' }));
}

/** 36 = errSecInteractionNotAllowed, 44 = item not found. */
function keychainExits(code: number) {
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => cb(Object.assign(new Error('security failed'), { code })));
}

function credentialsFile(contents: unknown) {
    mocks.readFile.mockResolvedValue(JSON.stringify(contents));
}

const originalPlatform = process.platform;
function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('claudeLockedKeychainAuthEnv', () => {
    beforeEach(() => {
        mocks.execFile.mockReset();
        mocks.readFile.mockReset();
        mocks.readFile.mockRejectedValue(new Error('ENOENT'));
        setPlatform('darwin');
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('injects the file tokens only when the Keychain item is locked', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
        keychainExits(36);

        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'access-1',
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-1',
            // Keeps the refresh in memory, so concurrent sessions don't race on
            // writing a rotated token back to the file.
            CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        });
    });

    it('injects nothing when Claude can read its own Keychain item', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
        keychainReadable();

        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});
    });

    it('injects nothing when there is no Keychain item at all', async () => {
        // Claude reads and refreshes ~/.claude/.credentials.json itself here, so
        // a snapshot would only pin the session to a token the next rotation
        // invalidates.
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1' } });
        keychainExits(44);

        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});
    });

    it('omits the refresh flag when the file carries no refresh token', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-only' } });
        keychainExits(36);

        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'access-only',
        });
    });

    it('never hands Claude credentials to another agent', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1' } });
        keychainExits(36);

        for (const agent of ['codex', 'gemini', 'openclaw', 'agy']) {
            await expect(claudeLockedKeychainAuthEnv(agent)).resolves.toEqual({});
        }
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('treats an omitted agent as Claude', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1' } });
        keychainExits(36);

        await expect(claudeLockedKeychainAuthEnv(undefined)).resolves.toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'access-1',
        });
    });

    it('defers to auth already present in the daemon environment', async () => {
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1' } });
        keychainExits(36);

        process.env.ANTHROPIC_API_KEY = 'sk-fixture';
        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});
        delete process.env.ANTHROPIC_API_KEY;

        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited';
        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});
    });

    it('does not spawn `security` when the credentials file has nothing to inject', async () => {
        // The Keychain decides the outcome, but with no token on disk there is
        // nothing to inject either way. Every session launch goes through here,
        // so the no-op case must not cost a subprocess — and the daemon resume
        // path, which spawns inside an ownership-critical section, must not gain
        // an unpredictable wait.
        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});

        credentialsFile({ claudeAiOauth: {} });
        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});

        mocks.readFile.mockResolvedValue('not json');
        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});

        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it('injects nothing off macOS, where there is no Keychain to be locked out of', async () => {
        setPlatform('linux');
        credentialsFile({ claudeAiOauth: { accessToken: 'access-1' } });

        await expect(claudeLockedKeychainAuthEnv('claude')).resolves.toEqual({});
        expect(mocks.execFile).not.toHaveBeenCalled();
    });
});
