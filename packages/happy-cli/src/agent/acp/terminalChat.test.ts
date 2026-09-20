import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeTerminalText, startTerminalChat } from './terminalChat';

describe('sanitizeTerminalText', () => {
  it('strips ANSI sequences and control characters but keeps text, tabs and newlines', () => {
    expect(sanitizeTerminalText('\u001b[32mgreen\u001b[0m plain')).toBe('green plain');
    expect(sanitizeTerminalText('\u001b]0;title\u0007header')).toBe('header');
    expect(sanitizeTerminalText('line1\n\tline2\u0008\u0007')).toBe('line1\n\tline2');
  });
});

function fakeNonTtyStream(): NodeJS.ReadStream {
  return new PassThrough() as unknown as NodeJS.ReadStream;
}

function fakeTtyStream(): NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> } {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
  };
  stream.isTTY = true;
  stream.setRawMode = vi.fn();
  return stream;
}

function fakeTtyOutput() {
  const output = fakeTtyStream() as unknown as NodeJS.WriteStream & { columns?: number };
  output.columns = 80;
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  return {
    output: output as unknown as NodeJS.WriteStream,
    written: () => written,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('startTerminalChat', () => {
  it('returns null when stdin is not a TTY', () => {
    const chat = startTerminalChat({
      input: fakeNonTtyStream(),
      output: fakeTtyStream() as unknown as NodeJS.WriteStream,
      onSubmit: vi.fn(),
      onRequestExit: vi.fn(),
    });
    expect(chat).toBeNull();
  });

  it('submits typed lines and ignores blank ones', async () => {
    const input = fakeTtyStream();
    const { output } = fakeTtyOutput();
    const onSubmit = vi.fn();
    const chat = startTerminalChat({ input, output, onSubmit, onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    input.write('hello from the terminal\n');
    input.write('   \n');
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello from the terminal');

    chat!.stop();
  });

  it('exits on Ctrl+C at an empty prompt', async () => {
    const input = fakeTtyStream();
    const { output } = fakeTtyOutput();
    const onRequestExit = vi.fn();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit });
    expect(chat).not.toBeNull();

    input.write('\x03');
    await flush();

    expect(onRequestExit).toHaveBeenCalledTimes(1);

    chat!.stop();
  });

  it('keeps breakLine from corrupting partial agent output', async () => {
    const input = fakeTtyStream();
    const { output, written } = fakeTtyOutput();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    chat!.writeAgentText('Hello');
    chat!.breakLine();
    chat!.writeAgentText('world\n');
    chat!.breakLine();
    await flush();

    expect(written()).toBe('Hello\nworld\n');

    chat!.stop();
  });

  it('prints remote prompts on their own line', async () => {
    const input = fakeTtyStream();
    const { output, written } = fakeTtyOutput();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    chat!.writeAgentText('partial');
    chat!.showRemotePrompt('from the phone');
    await flush();

    const text = written();
    expect(text).toContain('partial\n');
    expect(text.replace(/\u001b\[\d+m/g, '')).toContain('[phone] from the phone\n');

    chat!.stop();
  });

  it('lets the terminal pick an option with arrow keys and Enter', async () => {
    const input = fakeTtyStream();
    const { output, written } = fakeTtyOutput();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    const selection = chat!.pick({
      title: 'Select model',
      currentKey: 'model-a',
      options: [
        { key: 'model-a', label: 'Model A' },
        { key: 'model-b', label: 'Model B' },
      ],
    });

    input.write('\x1b[B');
    input.write('\r');

    await expect(selection).resolves.toBe('model-b');
    expect(written()).toContain('Selected Model B');

    chat!.stop();
  });

  it('redraws the picker in place without stacking titles', async () => {
    const input = fakeTtyStream();
    const { output, written } = fakeTtyOutput();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    const selection = chat!.pick({
      title: 'Select model',
      currentKey: 'model-a',
      options: [
        { key: 'model-a', label: 'Model A' },
        { key: 'model-b', label: 'Model B' },
        { key: 'model-c', label: 'Model C' },
      ],
    });

    input.write('\x1b[B');
    input.write('\x1b[B');
    input.write('\r');

    await expect(selection).resolves.toBe('model-c');
    const text = written();
    const titleCount = (text.match(/Select model/g) ?? []).length;
    const clearCount = (text.match(/\r\u001b\[2K/g) ?? []).length;
    expect(titleCount).toBe(3);
    expect(clearCount).toBeGreaterThanOrEqual(titleCount * 4);

    chat!.stop();
  });

  it('truncates picker rows to the terminal width', async () => {
    const input = fakeTtyStream();
    const { output, written } = fakeTtyOutput();
    output.columns = 24;
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    const selection = chat!.pick({
      title: 'Select model',
      options: [{ key: 'long', label: 'Gemini-3-Flash-Preview-With-Long-Name' }],
    });

    input.write('\r');

    await expect(selection).resolves.toBe('long');
    expect(written()).toContain('> Gemini-3-Flash-Prev...');

    chat!.stop();
  });

  it('returns null when a picker is cancelled', async () => {
    const input = fakeTtyStream();
    const { output } = fakeTtyOutput();
    const chat = startTerminalChat({ input, output, onSubmit: vi.fn(), onRequestExit: vi.fn() });
    expect(chat).not.toBeNull();

    const selection = chat!.pick({
      title: 'Select model',
      options: [{ key: 'model-a', label: 'Model A' }],
    });

    input.write('\x1b');

    await expect(selection).resolves.toBeNull();

    chat!.stop();
  });
});
