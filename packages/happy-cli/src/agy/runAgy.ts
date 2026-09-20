/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * agy is a plain-text streaming CLI (no ACP), so this drives an AgyBackend that
 * spawns `agy --print` per turn, and forwards its AgentMessage stream through the
 * same session pipeline used by the other backends.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Session as ApiSession } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { startTerminalChat, type TerminalChat } from '@/agent/acp/terminalChat';
import { showTerminalHistoryMessage } from '@/utils/terminalHistory';
import { SessionSyncGate } from '@/utils/sessionSyncGate';
import type { AgentMessage } from '@/agent/core';
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import { AgyBackend } from './AgyBackend';
import {
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  normalizeAgyEffort,
  resolveAgyModelName,
} from './constants';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  sessionName?: string;
  /** Start with phone sync off; /sync in the terminal chat enables it. */
  noSync?: boolean;
  /** Agy conversation id to resume. */
  resumeConversationId?: string;
}

export async function runAgy(opts: RunAgyOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('agy');
  const syncGate = new SessionSyncGate(!opts.noSync);

  const log = (msg: string) => {
    logger.debug(`[agy] ${msg}`);
    if (verbose) {
      console.log(`[agy] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    name: opts.sessionName,
  });
  if (opts.resumeConversationId) {
    metadata.agyConversationId = opts.resumeConversationId;
  }
  // Reconnect to an existing Happy session when the resume command passed its
  // coordinates through the environment (same transcript on the phone).
  const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
  const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
  const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
  const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
  const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

  let response: ApiSession | null;
  if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
    log(`Reconnecting to existing session ${reconnectSessionId}`);
    response = {
      id: reconnectSessionId,
      seq: parseInt(reconnectSeq || '0', 10),
      encryptionKey: decodeBase64(reconnectKeyBase64),
      encryptionVariant: reconnectVariant,
      metadata,
      metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
      agentState: state,
      agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
    };
  } else {
    response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  }
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  // On reconnect, un-archive the session and skip replaying old messages.
  if (reconnectSessionId) {
    session.suppressNextArchiveSignal();
    session.skipExistingMessages();
    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'running',
      archivedBy: undefined,
    }));
  }

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[agy] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;
  let errorReportedForCurrentTurn = false;

  let selectedModel = DEFAULT_AGY_MODEL;
  let selectedEffort = DEFAULT_AGY_EFFORT;
  let displayedModel = resolveAgyModelName(selectedModel, selectedEffort);

  const backend = new AgyBackend({
    cwd: process.cwd(),
    permissionMode: 'default',
    model: selectedModel,
    effort: selectedEffort,
    resumeConversationId: opts.resumeConversationId,
    log,
  });

  // Record the pinned agy conversation in metadata once it exists so the
  // session can be resumed later (happy resume / happy agy --resume).
  let recordedConversationId = opts.resumeConversationId ?? null;
  const recordConversationId = () => {
    const current = backend.getConversationId();
    if (!current || current === recordedConversationId) {
      return;
    }
    recordedConversationId = current;
    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      agyConversationId: current,
    }));
    log(`recorded agy conversation ${current}`);
  };

  // Interactive terminals get a readline chat (same input mechanism as a normal
  // shell prompt — local echo, full line editing, no full-screen redraws).
  // The daemon runs headless with no chat surface.
  let terminalChat: TerminalChat | null = null;

  const logLine = (text: string) => {
    terminalChat?.breakLine();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    console.log(`[${time}] ${text}`);
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (syncGate.shouldUpload()) {
        session.sendSessionProtocolMessage(envelope);
      }
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'model-output' && msg.textDelta) {
      terminalChat?.writeAgentText(msg.textDelta);
    } else if (msg.type === 'status') {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'error' && msg.detail) {
        logLine(`Error: ${msg.detail}`);
      }
    }

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0 && syncGate.shouldUpload()) {
      session.sendSessionEvent({
        type: 'message',
        message: `Antigravity error: ${msg.detail?.trim() || 'The agent stopped because of an unknown error.'}`,
      });
    }
    if (msg.type === 'status' && msg.status === 'error') {
      errorReportedForCurrentTurn = true;
    }
  };

  backend.onMessage(onBackendMessage);

  session.onUserMessage((message) => {
    if (!message.content.text) return;

    if (message.meta?.permissionMode) {
      const mode = normalizeRemotePermissionMode(message.meta.permissionMode);
      if (mode) {
        backend.setPermissionMode(mode);
      }
    }
    let selectionChanged = false;
    if (message.meta?.hasOwnProperty('model') && message.meta.model) {
      selectedModel = message.meta.model;
      backend.setModel(selectedModel);
      selectionChanged = true;
    }
    if (message.meta?.hasOwnProperty('effort')) {
      selectedEffort = normalizeAgyEffort(message.meta.effort);
      backend.setEffort(selectedEffort);
      selectionChanged = true;
    }
    if (selectionChanged) {
      displayedModel = resolveAgyModelName(selectedModel, selectedEffort);
      logLine(`Model: ${displayedModel}`);
    }

    syncGate.beginTurn('remote');
    terminalChat?.showRemotePrompt(message.content.text);
    messageQueue.push(message.content.text, {});
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel();
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);

  // Interactive terminals join the same session as the phone app: prompts typed
  // here are queued exactly like remote ones and mirrored into the session
  // transcript so both sides see one conversation. Non-TTY runs (daemon) get
  // no chat and stay headless.
  const handleSyncCommand = (text: string): boolean => {
    if (text !== '/sync' && text !== '/sync off') {
      return false;
    }
    if (text === '/sync') {
      syncGate.enable();
      logLine('Phone sync enabled — new terminal turns will appear on your phone.');
    } else {
      syncGate.disable();
      logLine('Phone sync disabled — terminal turns stay off the phone.');
    }
    terminalChat?.turnSettled();
    return true;
  };

  terminalChat = startTerminalChat({
    prompt: 'agy> ',
    onSubmit: (text) => {
      if (messageQueue.isClosed()) {
        return;
      }
      if (handleSyncCommand(text)) {
        return;
      }
      syncGate.beginTurn('local');
      if (syncGate.shouldUpload()) {
        session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
      }
      messageQueue.push(text, {});
    },
    onRequestExit: () => {
      shouldExit = true;
      messageQueue.close();
      void handleAbort();
    },
  });
  session.onHistoryMessage((message) => showTerminalHistoryMessage(terminalChat, message));

  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  });

  try {
    await backend.startSession();
    log('Backend ready');
    if (terminalChat) {
      logLine(syncGate.isEnabled()
        ? `Model: ${displayedModel} — chat enabled in this terminal; the same session is live in the Happy app. Ctrl+C exits.`
        : `Model: ${displayedModel} — chat enabled in this terminal; phone sync is OFF until you run /sync. Ctrl+C exits.`);
      terminalChat.turnSettled();
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      errorReportedForCurrentTurn = false;
      const turnStartedAt = Date.now();
      let turnFailed = false;
      terminalChat?.setBusy(true, 'agy is working…');
      sendEnvelopes(sessionManager.startTurn());
      try {
        await backend.sendPrompt(process.cwd(), batch.message);
        recordConversationId();
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        turnFailed = true;
        const msg = error instanceof Error ? error.message : String(error);
        if (!errorReportedForCurrentTurn && syncGate.shouldUpload()) {
          session.sendSessionEvent({ type: 'message', message: `Antigravity error: ${msg}` });
          errorReportedForCurrentTurn = true;
        }
        logLine(`Prompt error: ${msg} — session kept alive`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      thinking = false;
      session.keepAlive(false, 'remote');
      if (syncGate.shouldUpload()) {
        session.sendSessionEvent({ type: 'ready' });
      }
      syncGate.endTurn();
      if (!turnFailed) {
        logLine(`✓ Turn completed in ${((Date.now() - turnStartedAt) / 1000).toFixed(1)}s`);
      }
      terminalChat?.turnSettled();
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    terminalChat?.stop();

    backend.offMessage(onBackendMessage);
    await backend.dispose();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[agy] Session close failed:', error);
    }
  }
}
