import { describe, expect, it, vi } from 'vitest';
import { getSessionName } from './sessionUtils';

vi.mock('@/text', () => ({ t: (key: string) => key }));

const baseSession = {
    id: 'session-1',
    active: true,
    activeAt: 1,
    createdAt: 1,
    updatedAt: 1,
    seq: 1,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
} as any;

describe('getSessionName', () => {
    it('uses an explicit metadata name before the generated summary', () => {
        expect(getSessionName({
            ...baseSession,
            metadata: {
                name: 'Release check',
                summary: { text: 'Generated summary', updatedAt: 1 },
            },
        })).toBe('Release check');
    });

    it('falls back to the generated summary when the explicit name is blank', () => {
        expect(getSessionName({
            ...baseSession,
            metadata: {
                name: '   ',
                summary: { text: 'Generated summary', updatedAt: 1 },
            },
        })).toBe('Generated summary');
    });
});
