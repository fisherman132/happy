import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { CLAUDE_LOGIN_EXPIRED_MESSAGE } from './utils/providerAuth';
import type { SessionEnvelope } from '@slopus/happy-wire';

const terminalHarness = vi.hoisted(() => ({
    enabled: false,
    options: null as { onSubmit: (text: string) => void; onRequestExit: () => void } | null,
    remotePromptHandler: null as ((text: string) => void) | null,
    terminal: {
        breakLine: vi.fn(),
        writeAgentText: vi.fn(),
        showRemotePrompt: vi.fn(),
        pick: vi.fn(),
        turnSettled: vi.fn(),
        setBusy: vi.fn(),
        stop: vi.fn(),
    },
}));

// Exercise the real outgoing queue, SDK converter and protocol mapper without
// a terminal, credential store, provider process, relay or push service.
vi.mock('./claudeRemote', () => ({ claudeRemote: vi.fn() }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/ui/messageFormatterInk', () => ({ formatClaudeMessageForInk: vi.fn() }));
vi.mock('@/utils/terminalStdinCleanup', () => ({ cleanupStdinAfterInk: vi.fn() }));
vi.mock('@/agent/acp/terminalChat', () => ({
    startTerminalChat: (options: any) => {
        terminalHarness.options = options;
        return terminalHarness.enabled ? terminalHarness.terminal : null;
    },
}));
vi.mock('node:child_process', () => ({ execSync: () => 'fixture-branch' }));
vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponseLookup = () => new Map();
        handleToolCall = vi.fn();
    },
}));

function fixture() {
    const handlers = new Map<string, () => Promise<void>>();
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const envelopes: SessionEnvelope[] = [];
    const session = {
        sessionId: 'fixture-session', path: '/fixture/project', hookSettingsPath: '/fixture/settings.json',
        queue: { size: () => 0 },
        submitTerminalMessage: vi.fn(async () => {}),
        setRemotePromptHandler: vi.fn((handler: ((text: string) => void) | null) => {
            terminalHarness.remotePromptHandler = handler;
        }),
        consumeOneTimeFlags: vi.fn(),
        api: { push: () => ({ sendSessionNotification: notification }) },
        client: {
            sessionId: 'fixture-happy-session',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) },
            getMetadata: () => ({}),
            onHistoryMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message) => {
                const mapped = mapClaudeLogMessageToSessionEnvelopes(message, state);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
            closeClaudeSessionTurn: vi.fn((status) => {
                const mapped = closeClaudeTurnWithStatus(state, status);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
        },
    };
    const notification = vi.fn();
    const stop = () => { void handlers.get('switch')!(); };
    return { session, state, envelopes, notification, stop };
}

describe('claudeRemoteLauncher provider auth', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(claudeRemote).mockReset();
        terminalHarness.enabled = false;
        terminalHarness.options = null;
        terminalHarness.remotePromptHandler = null;
    });

    it('flushes back-to-back auth output before closing the failed wire turn, without a done push', async () => {
        const { session, state, envelopes, notification, stop } = fixture();
        let eventsAtReady: string[] = [];
        let turnAtReady: string | null | undefined;
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            opts.onCompletionEvent?.(CLAUDE_LOGIN_EXPIRED_MESSAGE);
            opts.onMessage({
                type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Provider login failed' }] },
            } as any);
            await opts.onReady('failed');
            // Verify before cleanup's final flush can hide incorrect ordering.
            eventsAtReady = envelopes.map(envelope => envelope.ev.t);
            turnAtReady = state.currentTurnId;
            stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(eventsAtReady).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'failed' });
        expect(turnAtReady).toBeNull();
        expect(notification).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(envelopes.filter(envelope => envelope.ev.t === 'turn-end')).toHaveLength(1);
    });

    it('shows untruncated host-login guidance for a thrown OAuth error and accepts a later invocation', async () => {
        const { session, notification, stop } = fixture();
        vi.mocked(claudeRemote)
            .mockRejectedValueOnce(new Error('Failed to authenticate: OAuth session expired and could not be refreshed\nhttps://fixture-secret@example.invalid'))
            .mockImplementationOnce(async () => { stop(); });
        await claudeRemoteLauncher(session as any);
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(JSON.stringify(session.client.sendSessionEvent.mock.calls)).not.toContain('fixture-secret');
        expect(notification).not.toHaveBeenCalled();
        expect(claudeRemote).toHaveBeenCalledTimes(2);
    });

    it('shares terminal and phone prompts and switches back to native Claude with /local', async () => {
        terminalHarness.enabled = true;
        const { session, stop } = fixture();
        let remoteOptions: any = null;
        vi.mocked(claudeRemote).mockImplementation(async (options) => {
            remoteOptions = options;
            await new Promise<void>((resolve) => {
                if (options.signal?.aborted) resolve();
                else options.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
        });

        const resultPromise = claudeRemoteLauncher(session as any);
        await vi.waitFor(() => expect(terminalHarness.options).not.toBeNull());
        terminalHarness.options!.onSubmit('hello from terminal');
        await vi.waitFor(() => expect(session.submitTerminalMessage).toHaveBeenCalledWith('hello from terminal'));

        terminalHarness.remotePromptHandler?.('hello from phone');
        expect(terminalHarness.terminal.showRemotePrompt).toHaveBeenCalledWith('hello from phone');

        await vi.waitFor(() => expect(remoteOptions).not.toBeNull());
        remoteOptions.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
        });
        expect(terminalHarness.terminal.writeAgentText).toHaveBeenCalledWith('hello back\n');

        terminalHarness.options!.onSubmit('/local');
        await expect(resultPromise).resolves.toBe('switch');
        expect(terminalHarness.terminal.stop).toHaveBeenCalledOnce();
        expect(session.setRemotePromptHandler).toHaveBeenLastCalledWith(null);

        // Keep the fixture stop closure exercised so it remains valid when
        // provider-auth cases call it directly.
        void stop;
    });
});
