import type { TerminalChat } from '@/agent/acp/terminalChat';

function readSessionEnvelope(value: unknown): { role?: unknown; ev?: unknown } | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.role !== 'session' || !record.content || typeof record.content !== 'object') {
        return null;
    }
    const content = record.content as Record<string, unknown>;
    if (content.type === 'session' && content.data && typeof content.data === 'object') {
        return content.data as { role?: unknown; ev?: unknown };
    }
    if (typeof content.role === 'string' && content.ev && typeof content.ev === 'object') {
        return content as { role?: unknown; ev?: unknown };
    }
    return null;
}

export function showTerminalHistoryMessage(chat: TerminalChat | null, value: unknown): void {
    if (!chat) {
        return;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const content = record.content;
        if (
            record.role === 'user'
            && content
            && typeof content === 'object'
            && (content as Record<string, unknown>).type === 'text'
            && typeof (content as Record<string, unknown>).text === 'string'
        ) {
            chat.showRemotePrompt((content as { text: string }).text);
            return;
        }
    }
    const envelope = readSessionEnvelope(value);
    if (!envelope || typeof envelope.ev !== 'object' || envelope.ev === null) {
        return;
    }
    const event = envelope.ev as Record<string, unknown>;
    if (event.t !== 'text' || typeof event.text !== 'string' || event.text.trim().length === 0) {
        return;
    }
    if (envelope.role === 'user') {
        chat.showRemotePrompt(event.text);
        return;
    }
    if (envelope.role === 'agent') {
        chat.writeAgentText(`${event.text}\n`);
    }
}
