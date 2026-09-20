import { createInterface } from 'node:readline';

const REMOTE_COLOR = '\u001b[32m';
const COLOR_RESET = '\u001b[0m';

const BUSY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const BUSY_INTERVAL_MS = 120;

/**
 * Agent text is written raw to the user's terminal, where stray ANSI
 * sequences or control characters (model output can contain them) would
 * corrupt the display. Keep printable text, tabs, and newlines only.
 */
export function sanitizeTerminalText(value: string): string {
  return value
    // CSI sequences, OSC sequences, and other ESC-initiated sequences
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g, '')
    // remaining C0 controls except tab (\t) and newline (\n)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

/**
 * Interactive chat surface for an ACP runner that owns the terminal.
 *
 * Prompts typed here are delivered through the same message queue as prompts
 * from the phone app, so both sides share one session and one conversation.
 */
export interface TerminalChat {
  /** Terminate a partial agent-output line so the next log line starts clean. */
  breakLine(): void;
  /** Stream a chunk of assistant output. Consecutive chunks concatenate. */
  writeAgentText(text: string): void;
  /** Display a prompt that arrived from the phone app. */
  showRemotePrompt(text: string): void;
  /** Present an in-terminal picker. Resolves to the selected key or null when cancelled. */
  pick(options: TerminalPickOptions): Promise<string | null>;
  /** The agent finished reacting; put a fresh input prompt at the bottom. */
  turnSettled(): void;
  /**
   * Show (or stop) a single-line "working…" spinner. The spinner owns the
   * current line and is dismissed by the first streamed chunk, a log line,
   * or turn settle — a turn must never look like Enter did nothing.
   */
  setBusy(busy: boolean, label?: string): void;
  stop(): void;
}

type ChatInput = NodeJS.ReadStream & { isTTY?: boolean };
type ChatOutput = NodeJS.WriteStream;

export type TerminalPickOption = {
  key: string;
  label: string;
  description?: string | null;
};

export type TerminalPickOptions = {
  title: string;
  options: TerminalPickOption[];
  currentKey?: string | null;
};

export function startTerminalChat(opts: {
  input?: ChatInput;
  output?: ChatOutput;
  prompt?: string;
  onSubmit(text: string): void;
  /** Ctrl+C on an empty prompt or Ctrl+D — the user asked to leave. */
  onRequestExit(): void;
}): TerminalChat | null {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) {
    return null;
  }

  const rl = createInterface({
    input,
    output,
    prompt: opts.prompt ?? '> ',
  });

  let atLineStart = true;
  let stopped = false;
  let busyTimer: NodeJS.Timeout | null = null;
  let busyFrame = 0;
  let busyLabel = '';
  let pickerActive = false;

  const write = (text: string) => {
    output.write(text);
  };

  const stopBusy = () => {
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
  };

  /** Dismiss the spinner line so other output can take over the row. */
  const dismissBusy = () => {
    if (!busyTimer) {
      return false;
    }
    stopBusy();
    write('\r\u001b[2K');
    atLineStart = true;
    return true;
  };

  const setBusy = (busy: boolean, label = 'working…') => {
    if (!busy) {
      dismissBusy();
      return;
    }
    if (busyTimer) {
      busyLabel = label;
      return;
    }
    busyLabel = label;
    busyFrame = 0;
    write('\r\u001b[2K');
    busyTimer = setInterval(() => {
      write(`\r\u001b[2K${BUSY_FRAMES[busyFrame % BUSY_FRAMES.length]} ${busyLabel}`);
      busyFrame += 1;
    }, BUSY_INTERVAL_MS);
  };

  const breakLine = () => {
    if (busyTimer) {
      dismissBusy();
      return;
    }
    if (!atLineStart) {
      write('\n');
      atLineStart = true;
    }
  };

  const writeAgentText = (text: string) => {
    if (!text) {
      return;
    }
    const sanitized = sanitizeTerminalText(text);
    if (!sanitized) {
      return;
    }
    dismissBusy();
    write(sanitized);
    atLineStart = sanitized.endsWith('\n');
  };

  const showRemotePrompt = (text: string) => {
    breakLine();
    write(`${REMOTE_COLOR}[phone] ${text.trim()}${COLOR_RESET}\n`);
    atLineStart = true;
  };

  const redrawPrompt = () => {
    rl.prompt(true);
    // The prompt leaves the cursor mid-line; track it so the next output breaks first.
    atLineStart = false;
  };

  const turnSettled = () => {
    if (pickerActive) {
      return;
    }
    breakLine();
    redrawPrompt();
  };

  const clearLines = (count: number) => {
    for (let i = 0; i < count; i++) {
      write('\r\u001b[2K');
      if (i < count - 1) {
        write('\u001b[1A');
      }
    }
  };

  const terminalColumns = () => {
    const columns = Number((output as ChatOutput & { columns?: number }).columns);
    return Number.isFinite(columns) && columns > 0 ? Math.max(20, columns) : 80;
  };

  const fitLine = (line: string) => {
    const sanitized = sanitizeTerminalText(line).replace(/\n/g, ' ');
    const width = terminalColumns();
    if (sanitized.length <= width) {
      return sanitized;
    }
    return `${sanitized.slice(0, Math.max(0, width - 3))}...`;
  };

  const pick = ({ title, options, currentKey }: TerminalPickOptions): Promise<string | null> => {
    if (options.length === 0) {
      breakLine();
      write(`${title}: no options available\n`);
      redrawPrompt();
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      breakLine();
      pickerActive = true;
      rl.pause();

      const inputAny = input as ChatInput & { setRawMode?: (mode: boolean) => void };
      const wasRaw = Boolean((input as unknown as { isRaw?: boolean }).isRaw);
      inputAny.setRawMode?.(true);
      input.resume();

      let selected = Math.max(0, options.findIndex((option) => option.key === currentKey));
      let renderedLines = 0;
      let done = false;

      const renderPicker = () => {
        if (renderedLines > 0) {
          clearLines(renderedLines);
        }
        const lines = [
          `${title} (↑/↓, Enter to select, Esc to cancel)`,
          ...options.map((option, index) => {
            const marker = index === selected ? '>' : ' ';
            const current = option.key === currentKey ? ' *' : '';
            const description = option.description ? ` - ${option.description}` : '';
            return `${marker} ${option.label}${current}${description}`;
          }),
        ].map(fitLine);
        write(lines.join('\n'));
        renderedLines = lines.length;
        atLineStart = false;
      };

      const finish = (value: string | null) => {
        if (done) {
          return;
        }
        done = true;
        input.off('data', onData);
        inputAny.setRawMode?.(wasRaw);
        pickerActive = false;
        clearLines(renderedLines);
        if (value) {
          const selectedOption = options.find((option) => option.key === value);
          write(`Selected ${selectedOption?.label ?? value}\n`);
        }
        redrawPrompt();
        resolve(value);
      };

      const onData = (chunk: Buffer | string) => {
        const text = chunk.toString('utf8');
        if (text === '\u001b[A' || text === '\u001bOA') {
          selected = (selected - 1 + options.length) % options.length;
          renderPicker();
          return;
        }
        if (text === '\u001b[B' || text === '\u001bOB') {
          selected = (selected + 1) % options.length;
          renderPicker();
          return;
        }
        if (text === '\r' || text === '\n') {
          finish(options[selected].key);
          return;
        }
        if (text === '\u001b' || text === '\u0003') {
          finish(null);
        }
      };

      input.on('data', onData);
      renderPicker();
    });
  };

  rl.on('line', (line) => {
    if (pickerActive) {
      return;
    }
    const text = line.trim();
    if (!text) {
      redrawPrompt();
      return;
    }
    // readline has already echoed the submitted line plus its newline.
    dismissBusy();
    atLineStart = true;
    try {
      opts.onSubmit(text);
    } catch (error) {
      write(`failed to submit prompt: ${error instanceof Error ? error.message : String(error)}\n`);
      atLineStart = true;
    }
  });

  rl.on('SIGINT', () => {
    if (pickerActive) {
      return;
    }
    if (rl.line.length > 0) {
      // First Ctrl+C with a draft clears the draft instead of killing the session.
      // line/cursor are typed read-only but are the supported state prompt() renders from.
      const editable = rl as unknown as { line: string; cursor: number };
      write('\r\u001b[2K');
      editable.line = '';
      editable.cursor = 0;
      redrawPrompt();
      return;
    }
    opts.onRequestExit();
  });

  rl.on('close', () => {
    if (!stopped) {
      opts.onRequestExit();
    }
  });

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopBusy();
    try {
      rl.close();
    } catch {
      // best-effort
    }
  };

  return { breakLine, writeAgentText, showRemotePrompt, pick, turnSettled, setBusy, stop };
}
