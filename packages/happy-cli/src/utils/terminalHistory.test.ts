import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';

import { showTerminalHistoryMessage } from './terminalHistory';

function fakeChat() {
    return {
        breakLine: vi.fn(),
        writeAgentText: vi.fn(),
        showRemotePrompt: vi.fn(),
        pick: vi.fn(),
        turnSettled: vi.fn(),
        setBusy: vi.fn(),
        stop: vi.fn(),
    };
}

describe('showTerminalHistoryMessage', () => {
    it('prints historical user and agent text without rendering lifecycle events', () => {
        const chat = fakeChat();

        showTerminalHistoryMessage(chat, {
            role: 'user',
            content: { type: 'text', text: 'raw happy prompt' },
        });
        showTerminalHistoryMessage(chat, {
            role: 'session',
            content: {
                type: 'session',
                data: createEnvelope('user', { t: 'text', text: 'old user prompt' }),
            },
        });
        showTerminalHistoryMessage(chat, {
            role: 'session',
            content: createEnvelope('agent', { t: 'text', text: 'old answer' }),
        });
        showTerminalHistoryMessage(chat, {
            role: 'session',
            content: {
                type: 'session',
                data: createEnvelope('agent', { t: 'turn-start' }),
            },
        });

        expect(chat.showRemotePrompt).toHaveBeenCalledWith('raw happy prompt');
        expect(chat.showRemotePrompt).toHaveBeenCalledWith('old user prompt');
        expect(chat.showRemotePrompt).toHaveBeenCalledTimes(2);
        expect(chat.writeAgentText).toHaveBeenCalledExactlyOnceWith('old answer\n');
    });
});
