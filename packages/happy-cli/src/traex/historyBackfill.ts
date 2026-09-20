import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

type TraexHistoryItem =
  | { type: 'UserMessage'; id?: string; content?: unknown[] }
  | { type: 'AgentMessage'; id?: string; content?: unknown[] }
  | { type?: string; id?: string; content?: unknown[] };

function traeCliHome(): string {
  const explicit = process.env.TRAECLI_HOME;
  if (explicit) return explicit;
  const home = process.env.TRAE_HOME;
  if (home) return join(home, 'cli');
  return join(process.env.HOME ?? '', '.trae', 'cli');
}

function rolloutPathFromStateDb(threadId: string, cliHome = traeCliHome()): string | null {
  const dbPath = join(cliHome, 'state_5.sqlite');
  if (!existsSync(dbPath)) return null;
  try {
    const quotedThreadId = threadId.replaceAll("'", "''");
    const output = execFileSync('sqlite3', [
      dbPath,
      `SELECT rollout_path FROM threads WHERE id = '${quotedThreadId}' LIMIT 1;`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown[] | undefined, textTypes: Set<string>): string {
  return (content ?? [])
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return typeof record.type === 'string'
        && textTypes.has(record.type)
        && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

function envelopeFromItem(item: TraexHistoryItem, time: number): SessionEnvelope[] {
  if (item.type === 'UserMessage') {
    const text = textFromContent(item.content, new Set(['text', 'input_text']));
    return text ? [createEnvelope('user', { t: 'text', text }, { id: item.id, time })] : [];
  }
  if (item.type === 'AgentMessage') {
    const text = textFromContent(item.content, new Set(['Text', 'output_text', 'text']));
    return text ? [createEnvelope('agent', { t: 'text', text }, { id: item.id, time })] : [];
  }
  return [];
}

export function buildTraexHistoryBackfillEnvelopes(threadId: string): SessionEnvelope[] {
  const rolloutPath = rolloutPathFromStateDb(threadId);
  if (!rolloutPath || !existsSync(rolloutPath)) return [];

  const envelopes: SessionEnvelope[] = [];
  for (const line of readFileSync(rolloutPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== 'item_completed' || payload.thread_id !== threadId) continue;
    const item = payload.item as TraexHistoryItem | undefined;
    if (!item) continue;
    const time = typeof payload.completed_at_ms === 'number'
      ? payload.completed_at_ms
      : Date.parse(String(record.timestamp ?? ''));
    envelopes.push(...envelopeFromItem(item, Number.isFinite(time) ? time : Date.now()));
  }
  return envelopes;
}
