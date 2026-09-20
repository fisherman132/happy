import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    encryptRaw: vi.fn(async (value: unknown) => `encrypted:${JSON.stringify(value)}`),
    decryptRaw: vi.fn(async (_value: string) => ({
        path: '/project',
        machineId: 'machine-1',
        name: 'server-name',
        flavor: 'traex',
    })),
    state: {
        sessions: {} as Record<string, any>,
        applySessionMetadata: vi.fn(),
    },
}));

vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: mocks.emitWithAck } }));
vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => ({
                encryptRaw: mocks.encryptRaw,
                decryptRaw: mocks.decryptRaw,
            }),
        },
    },
}));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('./agentModesPending', () => ({
    markAgentModePushPending: vi.fn(),
    clearAgentModePushPending: vi.fn(),
}));

import { sessionSetName } from './ops';

describe('sessionSetName', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.state.sessions = {
            'session-1': {
                metadata: {
                    path: '/project',
                    machineId: 'machine-1',
                    flavor: 'traex',
                },
                metadataVersion: 7,
            },
        };
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 8, metadata: 'encrypted' });
    });

    it('updates local metadata optimistically and pushes encrypted session metadata', async () => {
        sessionSetName('session-1', '  Release check  ');
        await vi.waitFor(() => expect(mocks.emitWithAck).toHaveBeenCalledTimes(1));

        expect(mocks.state.applySessionMetadata).toHaveBeenCalledWith('session-1', {
            path: '/project',
            machineId: 'machine-1',
            flavor: 'traex',
            name: 'Release check',
        });
        expect(mocks.encryptRaw).toHaveBeenCalledWith({
            path: '/project',
            machineId: 'machine-1',
            flavor: 'traex',
            name: 'Release check',
        });
        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: 'session-1',
            metadata: expect.stringContaining('Release check'),
            expectedVersion: 7,
        });
    });

    it('clears the explicit name when the user submits a blank value', async () => {
        mocks.state.sessions['session-1'].metadata.name = 'Old name';

        sessionSetName('session-1', '   ');
        await vi.waitFor(() => expect(mocks.emitWithAck).toHaveBeenCalledTimes(1));

        expect(mocks.state.applySessionMetadata).toHaveBeenCalledWith('session-1', {
            path: '/project',
            machineId: 'machine-1',
            flavor: 'traex',
        });
        expect(mocks.encryptRaw).toHaveBeenCalledWith({
            path: '/project',
            machineId: 'machine-1',
            flavor: 'traex',
        });
    });

    it('merges a rename over the latest metadata after a version conflict', async () => {
        mocks.emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 9, metadata: 'server-metadata' })
            .mockResolvedValueOnce({ result: 'success', version: 10, metadata: 'encrypted' });

        sessionSetName('session-1', 'Client name');
        await vi.waitFor(() => expect(mocks.emitWithAck).toHaveBeenCalledTimes(2));

        expect(mocks.decryptRaw).toHaveBeenCalledWith('server-metadata');
        expect(mocks.encryptRaw).toHaveBeenLastCalledWith({
            path: '/project',
            machineId: 'machine-1',
            name: 'Client name',
            flavor: 'traex',
        });
        expect(mocks.emitWithAck.mock.calls[1][1]).toMatchObject({
            sid: 'session-1',
            expectedVersion: 9,
        });
    });
});
