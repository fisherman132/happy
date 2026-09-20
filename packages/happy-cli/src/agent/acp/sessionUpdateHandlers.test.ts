import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_TIMEOUT_MS, handleAgentMessageChunk, type HandlerContext, type SessionUpdate } from './sessionUpdateHandlers';
import { geminiTransport } from '../transport/handlers/GeminiTransport';
import { DefaultTransport } from '../transport';

function makeContext(transport: HandlerContext['transport']): {
  ctx: HandlerContext;
  emitted: import('../core').AgentMessage[];
} {
  const emitted: import('../core').AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport,
    activeToolCalls: new Set(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
  return { ctx, emitted };
}

const boldHeaderChunk = '**模块设计**\n下面是具体的模块划分…';
const plainChunk = '普通的正文内容';

describe('handleAgentMessageChunk', () => {
  it('routes bold-led chunks to thinking for Gemini (legacy behavior)', () => {
    const { ctx, emitted } = makeContext(geminiTransport);

    const result = handleAgentMessageChunk(
      { sessionUpdate: 'agent_message_chunk', content: { text: boldHeaderChunk } } as SessionUpdate,
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      { type: 'event', name: 'thinking', payload: { text: boldHeaderChunk, streaming: true } },
    ]);
  });

  it('keeps bold-led answer content as model output for other agents', () => {
    // Kimi and friends start ordinary answer paragraphs with bold headers;
    // those must reach the app as visible text, not collapsed thinking.
    const { ctx, emitted } = makeContext(new DefaultTransport('kimi'));

    const result = handleAgentMessageChunk(
      { sessionUpdate: 'agent_message_chunk', content: { text: boldHeaderChunk } } as SessionUpdate,
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      { type: 'model-output', textDelta: boldHeaderChunk },
    ]);
    expect(ctx.setIdleTimeout).toHaveBeenCalledWith(expect.any(Function), DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('emits plain chunks as model output for Gemini too', () => {
    const { ctx, emitted } = makeContext(geminiTransport);

    handleAgentMessageChunk(
      { sessionUpdate: 'agent_message_chunk', content: { text: plainChunk } } as SessionUpdate,
      ctx,
    );

    expect(emitted).toEqual([
      { type: 'model-output', textDelta: plainChunk },
    ]);
  });

  it('ignores updates without text content', () => {
    const { ctx, emitted } = makeContext(new DefaultTransport('kimi'));

    const result = handleAgentMessageChunk(
      { sessionUpdate: 'agent_message_chunk' } as SessionUpdate,
      ctx,
    );

    expect(result.handled).toBe(false);
    expect(emitted).toEqual([]);
  });
});
