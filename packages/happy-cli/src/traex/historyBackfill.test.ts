import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));

import { buildTraexHistoryBackfillEnvelopes } from './historyBackfill';

describe('buildTraexHistoryBackfillEnvelopes', () => {
  it('maps TraeX rollout user and assistant messages into Happy session envelopes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-traex-history-'));
    process.env.TRAECLI_HOME = dir;
    await writeFile(join(dir, 'state_5.sqlite'), '');
    const rolloutPath = join(dir, 'rollout.jsonl');
    await writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-09-20T06:33:14.426Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'thread-1',
          completed_at_ms: 1000,
          item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-20T06:33:17.613Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'thread-1',
          completed_at_ms: 2000,
          item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'world' }] },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-20T06:33:18.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'other-thread',
          item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'skip' }] },
        },
      }),
    ].join('\n'));
    mocks.execFileSync.mockReturnValue(`${rolloutPath}\n`);

    const envelopes = buildTraexHistoryBackfillEnvelopes('thread-1');

    expect(envelopes.map((envelope) => [envelope.role, envelope.ev])).toEqual([
      ['user', { t: 'text', text: 'hello' }],
      ['agent', { t: 'text', text: 'world' }],
    ]);
    expect(envelopes.map((envelope) => envelope.id)).toEqual(['u1', 'a1']);
  });
});
