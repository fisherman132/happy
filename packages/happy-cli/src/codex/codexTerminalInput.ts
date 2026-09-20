import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

import type { MessageQueue2 } from '@/utils/MessageQueue2';

import { enqueueCodexUserText } from './codexClearCommand';
import type { CodexEnhancedMode } from './codexPrompt';

/**
 * Submit a prompt typed in Happy's terminal surface. It enters the exact same
 * queue as phone prompts and is mirrored to the session so the phone sees it.
 * Codex command text is deliberately left untouched; enqueueCodexUserText
 * retains the existing isolated /clear behavior and the app-server receives
 * other native commands such as /model as written.
 */
export function enqueueCodexTerminalInput(opts: {
    text: string;
    mode: CodexEnhancedMode;
    queue: MessageQueue2<CodexEnhancedMode>;
    sendSessionProtocolMessage: (envelope: SessionEnvelope) => void;
}): 'clear' | 'queued' {
    opts.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: opts.text }));
    return enqueueCodexUserText({
        text: opts.text,
        mode: opts.mode,
        queue: opts.queue,
    });
}
