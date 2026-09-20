import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/utils/MessageQueue2';

import { enqueueCodexUserText } from './codexClearCommand';
import { hashCodexEnhancedMode, type CodexEnhancedMode } from './codexPrompt';
import { enqueueCodexTerminalInput } from './codexTerminalInput';

describe('enqueueCodexTerminalInput', () => {
    it('shares the Codex queue with phone prompts and mirrors terminal text to Happy', () => {
        const queue = new MessageQueue2<CodexEnhancedMode>(hashCodexEnhancedMode);
        const mode: CodexEnhancedMode = {
            permissionMode: 'default',
            model: 'gpt-5.2-codex',
            effort: 'medium',
        };
        const sendSessionProtocolMessage = vi.fn();

        enqueueCodexUserText({ text: 'from phone', mode, queue });
        enqueueCodexTerminalInput({
            text: '/model',
            mode,
            queue,
            sendSessionProtocolMessage,
        });

        expect(queue.queue.map((item) => item.message)).toEqual(['from phone', '/model']);
        expect(sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({
            role: 'user',
            ev: { t: 'text', text: '/model' },
        }));
    });

    it('retains Codex isolated /clear semantics for terminal prompts', () => {
        const queue = new MessageQueue2<CodexEnhancedMode>(hashCodexEnhancedMode);
        const mode: CodexEnhancedMode = { permissionMode: 'default' };

        queue.push('discard me', mode);
        const result = enqueueCodexTerminalInput({
            text: '/clear',
            mode,
            queue,
            sendSessionProtocolMessage: vi.fn(),
        });

        expect(result).toBe('clear');
        expect(queue.queue).toEqual([expect.objectContaining({
            message: '/clear',
            isolate: true,
        })]);
    });
});
