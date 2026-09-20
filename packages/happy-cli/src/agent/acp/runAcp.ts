import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Session as ApiSession } from '@/api/types';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, CANCELLED_BY_USER_DETAIL, type AcpPermissionHandler } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { startTerminalChat, type TerminalChat, type TerminalPickOption } from './terminalChat';
import { showTerminalHistoryMessage } from '@/utils/terminalHistory';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { SessionSyncGate } from '@/utils/sessionSyncGate';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import {
  BasePermissionHandler,
  type PendingRequestStateDetails,
  type PermissionResponse,
  type PermissionResult,
} from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';
import { buildTraexHistoryBackfillEnvelopes } from '@/traex/historyBackfill';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ACP_EVENT_PREVIEW_CHARS = 240;
const ACP_RAW_PREVIEW_CHARS = 2000;
const ACP_COLOR_RESET = '\u001b[0m';
const ACP_LOG_COLORS = {
  muted: '\u001b[90m',
  error: '\u001b[31m',
  incoming: '\u001b[32m',
  outgoing: '\u001b[34m',
  tool: '\u001b[38;5;208m',
} as const;

type AcpLogKind = keyof typeof ACP_LOG_COLORS;
type AcpFormattedLog = {
  kind: AcpLogKind;
  text: string;
};

function shouldUseColoredAcpLogs(): boolean {
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

function formatAcpTime(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function colorizeAcpLine(kind: AcpLogKind, line: string): string {
  if (!shouldUseColoredAcpLogs()) {
    return line;
  }
  return `${ACP_LOG_COLORS[kind]}${line}${ACP_COLOR_RESET}`;
}

// Set while an interactive terminal chat owns the console so streamed agent
// text without a trailing newline cannot bleed into the next log line.
let activeTerminalChat: TerminalChat | null = null;

function logAcp(kind: AcpLogKind, message: string): void {
  activeTerminalChat?.breakLine();
  const line = `[${formatAcpTime()}] ${message}`;
  console.log(colorizeAcpLine(kind, line));
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForConsole(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatUnknownForConsole(value: unknown, limit: number): string {
  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  return truncateForConsole(toSingleLine(serialized), limit);
}

function formatTextForConsole(text: string): string {
  return JSON.stringify(truncateForConsole(toSingleLine(text), ACP_EVENT_PREVIEW_CHARS));
}

function formatOptionalDetail(text: string | null | undefined, limit = ACP_EVENT_PREVIEW_CHARS): string {
  if (!text) {
    return '';
  }
  return ` - ${truncateForConsole(toSingleLine(text), limit)}`;
}

function formatPermissionOptionList(details: PendingRequestStateDetails): string {
  const options = details.acpOptions ?? [];
  if (options.length === 0) {
    return '';
  }
  return options
    .map((option) => `${option.name}${option.kind ? ` (${option.kind})` : ''}`)
    .join(', ');
}

function extractThinkingText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return '';
}

function formatAcpMessageForFrontend(agentName: string, msg: AgentMessage, detailed: boolean): AcpFormattedLog | null {
  switch (msg.type) {
    case 'status':
      return null;
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      return {
        kind: 'outgoing',
        text: `Outgoing message: ${formatTextForConsole(text)}`,
      };
    }
    case 'tool-call':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} started (callId=${msg.callId})`,
      };
    case 'tool-result':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} completed (callId=${msg.callId})`,
      };
    case 'permission-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission request from ${agentName}: id=${msg.id} reason=${msg.reason}`,
      };
    case 'permission-response':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission response from ${agentName}: id=${msg.id} approved=${msg.approved}`,
      };
    case 'fs-edit':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing fs edit from ${agentName}: description=${formatTextForConsole(msg.description)}`,
      };
    case 'terminal-output':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing terminal output from ${agentName}: text=${formatTextForConsole(msg.data)}`,
      };
    case 'event': {
      if (msg.name === 'thinking') {
        const thinkingText = extractThinkingText(msg.payload);
        return {
          kind: 'muted',
          text: `Thinking: ${formatTextForConsole(thinkingText)}`,
        };
      }
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing event from ${agentName}: name=${msg.name} payload=${formatUnknownForConsole(msg.payload, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    }
    case 'token-count':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing token count from ${agentName}: data=${formatUnknownForConsole(msg, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    case 'exec-approval-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing exec approval request from ${agentName}: callId=${msg.call_id}`,
      };
    case 'patch-apply-begin':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply begin from ${agentName}: callId=${msg.call_id} autoApproved=${msg.auto_approved === true}`,
      };
    case 'patch-apply-end':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply end from ${agentName}: callId=${msg.call_id} success=${msg.success}`,
      };
    default:
      return null;
  }
}

function formatEnvelopeForServerLog(agentName: string, envelope: SessionEnvelope): AcpFormattedLog {
  if (envelope.ev.t === 'text') {
    const thinkingPrefix = envelope.ev.thinking ? 'thinking' : 'text';
    return {
      kind: 'incoming',
      text: `Incoming ${thinkingPrefix} prompt for ${agentName}: ${formatUnknownForConsole(envelope.ev.text, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-start') {
    return {
      kind: 'tool',
      text: `Tool start sent to server from ${agentName}: tool=${envelope.ev.name} callId=${envelope.ev.call} args=${formatUnknownForConsole(envelope.ev.args, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-end') {
    return {
      kind: 'tool',
      text: `Tool end sent to server from ${agentName}: callId=${envelope.ev.call}`,
    };
  }
  if (envelope.ev.t === 'turn-start') {
    return {
      kind: 'incoming',
      text: `Incoming turn start for ${agentName}`,
    };
  }
  if (envelope.ev.t === 'turn-end') {
    return {
      kind: 'incoming',
      text: `Incoming turn end for ${agentName}: status=${envelope.ev.status}`,
    };
  }
  return {
    kind: 'incoming',
    text: `Incoming ${envelope.ev.t} for ${agentName}: ${formatUnknownForConsole(envelope.ev, ACP_EVENT_PREVIEW_CHARS)}`,
  };
}

type AcpSwitchMode = {
  permissionMode?: string;
  model?: string | null;
  effort?: string | null;
};

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

type AcpConfigCategory = 'mode' | 'model' | 'thought_level';

const ACP_CONFIG_CATEGORY_HINTS: Record<AcpConfigCategory, readonly string[]> = {
  mode: ['mode', 'permission', 'permissions'],
  model: ['model', 'models'],
  thought_level: ['thought', 'thinking', 'effort', 'reasoning'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSelectValue(value: unknown): value is { value: string; name: string } {
  return isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';
}

function isSelectGroup(value: unknown): value is { options: unknown[] } {
  return isRecord(value) && Array.isArray(value.options);
}

function flattenSelectOptions(options: unknown): AcpSelectableOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: AcpSelectableOption[] = [];

  for (const entry of options) {
    if (isSelectValue(entry)) {
      flattened.push({ code: entry.value, value: entry.name });
      continue;
    }
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isSelectValue(grouped)) {
          continue;
        }
        flattened.push({ code: grouped.value, value: grouped.name });
      }
    }
  }

  return flattened;
}

function extractConfigSelector(
  configOptions: SessionConfigOption[],
  category: AcpConfigCategory,
): AcpConfigSelector | null {
  const resolveOptionCategory = (option: SessionConfigOption): AcpConfigCategory | null => {
    if (typeof option.category === 'string') {
      return option.category === 'mode' || option.category === 'model' || option.category === 'thought_level'
        ? option.category
        : null;
    }
    // Some ACP providers omit category; fallback to id/name heuristics.
    const tokens = [
      ...tokensForCategoryHeuristic(option.id),
      ...tokensForCategoryHeuristic(option.name),
    ];
    for (const candidate of ['thought_level', 'model', 'mode'] as const) {
      if (tokens.some((token) => ACP_CONFIG_CATEGORY_HINTS[candidate].includes(token))) {
        return candidate;
      }
    }
    return null;
  };

  for (const option of configOptions) {
    if (option.type !== 'select' || resolveOptionCategory(option) !== category) {
      continue;
    }
    return {
      configId: option.id,
      currentCode: option.currentValue,
      options: flattenSelectOptions(option.options),
    };
  }
  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function tokensForCategoryHeuristic(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function resolveRequestedCode(options: AcpSelectableOption[], requested: string): string | null {
  for (const option of options) {
    if (option.code === requested || option.value === requested) {
      return option.code;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const option of options) {
    if (normalizeComparable(option.code) === normalizedRequested || normalizeComparable(option.value) === normalizedRequested) {
      return option.code;
    }
  }

  return null;
}

function resolveRequestedLegacyModeCode(modes: SessionModeState, requested: string): string | null {
  for (const mode of modes.availableModes) {
    if (mode.id === requested || mode.name === requested) {
      return mode.id;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const mode of modes.availableModes) {
    if (normalizeComparable(mode.id) === normalizedRequested || normalizeComparable(mode.name) === normalizedRequested) {
      return mode.id;
    }
  }

  return null;
}

function resolveRequestedLegacyModelCode(models: SessionModelState, requested: string): string | null {
  for (const model of models.availableModels) {
    if (model.modelId === requested || model.name === requested) {
      return model.modelId;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const model of models.availableModels) {
    if (normalizeComparable(model.modelId) === normalizedRequested || normalizeComparable(model.name) === normalizedRequested) {
      return model.modelId;
    }
  }

  return null;
}

class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;
  private readonly notifyPermissionRequest?: (request: {
    id: string;
    toolName: string;
    input: unknown;
    details: PendingRequestStateDetails;
  }) => void;

  constructor(
    session: ApiSessionClient,
    agentName: string,
    notifyPermissionRequest?: (request: {
      id: string;
      toolName: string;
      input: unknown;
      details: PendingRequestStateDetails;
    }) => void,
  ) {
    super(session);
    this.logPrefix = `[${agentName}]`;
    this.notifyPermissionRequest = notifyPermissionRequest;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    details: PendingRequestStateDetails = {}
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      void this.addPendingRequestToState(toolCallId, toolName, input, details).then(() => {
        this.notifyPermissionRequest?.({ id: toolCallId, toolName, input, details });
      });
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }

  async answerFromTerminal(requestId: string, optionId: string, details: PendingRequestStateDetails): Promise<boolean> {
    const option = details.acpOptions?.find((item) => item.optionId === optionId);
    const response: PermissionResponse = {
      id: requestId,
      approved: option?.kind === 'allow_once' || option?.kind === 'allow_always',
      decision: option?.kind === 'allow_always'
        ? 'approved_for_session'
        : option?.kind === 'allow_once'
          ? 'approved'
          : option?.kind === 'reject_once' || option?.kind === 'reject_always'
            ? 'denied'
            : 'abort',
      acpOptionId: optionId,
    };
    return this.resolvePermissionResponse(response);
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'kimi' | 'traex' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  if (agentName === 'kimi') {
    return 'kimi';
  }
  if (agentName === 'traex') {
    return 'traex';
  }
  return 'acp';
}

type AcpSessionIdMetadataKey = 'kimiSessionId' | 'traexSessionId';

function resolveAcpSessionIdMetadataKey(agentName: string): AcpSessionIdMetadataKey | null {
  if (agentName === 'kimi') {
    return 'kimiSessionId';
  }
  if (agentName === 'traex') {
    return 'traexSessionId';
  }
  return null;
}

export async function runAcp(opts: {
  credentials: Credentials;
  agentName: string;
  command: string;
  args: string[];
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  resumeAcpSessionId?: string;
  sessionName?: string;
  /** Start with phone sync off; /sync in the terminal chat enables it. */
  noSync?: boolean;
}): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend(opts.agentName);
  const syncGate = new SessionSyncGate(!opts.noSync);

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
    flavor: resolveSessionFlavor(opts.agentName),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
    name: opts.sessionName,
  });
  const acpSessionIdMetadataKey = resolveAcpSessionIdMetadataKey(opts.agentName);
  if (acpSessionIdMetadataKey && opts.resumeAcpSessionId) {
    metadata[acpSessionIdMetadataKey] = opts.resumeAcpSessionId;
  }
  // Check for session reconnection env vars (set by daemon for resume-in-place)
  const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
  const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
  const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
  const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
  const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

  let response: ApiSession | null;
  if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
    logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
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
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  let terminalChat: TerminalChat | null = null;
  let currentTurnOrigin: 'local' | 'remote' | null = null;
  const handleAcpPermissionRequest = (request: {
    id: string;
    toolName: string;
    input: unknown;
    details: PendingRequestStateDetails;
  }) => {
    const permissionTitle = request.details.acpTitle || request.toolName;
    const optionSummary = formatPermissionOptionList(request.details);
    logAcp(
      'tool',
      `${opts.agentName} is waiting for permission: ${permissionTitle} (id=${request.id})${optionSummary ? ` options=[${optionSummary}]` : ''}`,
    );

    try {
      api.push().sendSessionNotification({
        kind: 'permission',
        metadata: session.getMetadata(),
        data: {
          sessionId: session.sessionId,
          requestId: request.id,
          tool: request.toolName,
          type: 'permission_request',
          provider: opts.agentName,
        },
      });
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to send permission push`, error);
    }

    if (!terminalChat) {
      return;
    }

    if (currentTurnOrigin !== 'local') {
      logAcp('muted', `${opts.agentName} permission is pending on the phone/app. Approve or reject it there to continue.`);
      return;
    }

    if (!request.details.acpOptions?.length) {
      logAcp('muted', `${opts.agentName} permission is pending, but this request did not include selectable ACP options. Use the phone/app permission card.`);
      return;
    }

    void (async () => {
      const selected = await terminalChat?.pick({
        title: `${opts.agentName} permission: ${permissionTitle}`,
        options: request.details.acpOptions!.map((option) => ({
          key: option.optionId,
          label: option.name,
          description: option.kind,
        })),
      });
      if (!selected) {
        const reject = request.details.acpOptions!.find((option) => option.kind === 'reject_once')
          ?? request.details.acpOptions!.find((option) => option.kind === 'reject_always')
          ?? request.details.acpOptions![request.details.acpOptions!.length - 1];
        await permissionHandler.answerFromTerminal(request.id, reject.optionId, request.details);
        return;
      }
      await permissionHandler.answerFromTerminal(request.id, selected, request.details);
    })().catch((error) => {
      logger.debug(`[${opts.agentName}] Terminal permission picker failed:`, error);
    });
  };
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
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
      logger.debug('[acp] Failed to report session to daemon:', error);
    }
  }

  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName, handleAcpPermissionRequest);
  // Drop any permission requests left in agent state from a previous CLI
  // process that died while a tool prompt was open — see the matching
  // call in claudeRemoteLauncher for the full rationale.
  permissionHandler.reset('Previous CLI process exited before responding');
  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined;
  let currentModel: string | null | undefined;
  let currentEffort: string | null | undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let thoughtLevelSelector: AcpConfigSelector | null = null;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;

  const happyServer = await startHappyServer(session);
  const mcpServers = {
    happy: {
      command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
      args: ['--url', happyServer.url],
    },
  };

  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    resumeSessionId: opts.resumeAcpSessionId,
    mcpServers,
    permissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    verbose,
  });

  let thinking = false;
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;
  let errorReportedForCurrentTurn = false;
  let keepSessionOpenOnStartupError = false;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    current.resolve();
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTurn = null;
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error(reason));
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (verbose) {
        const formatted = formatEnvelopeForServerLog(opts.agentName, envelope);
        logAcp('muted', formatted.text);
      }
      if (syncGate.shouldUpload()) {
        session.sendSessionProtocolMessage(envelope);
      }
      if (verbose) {
        logAcp('muted', `Incoming raw envelope for ${opts.agentName}: ${formatUnknownForConsole(envelope, ACP_RAW_PREVIEW_CHARS)}`);
      }
    }
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (!requestedMode) {
      return;
    }

    if (modeSelector) {
      const resolved = resolveRequestedCode(modeSelector.options, requestedMode);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP permission mode request: ${requestedMode}`);
        return;
      }
      if (resolved === modeSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modeSelector.configId, resolved);
      if (switched) {
        modeSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModes) {
      return;
    }

    const resolvedLegacyMode = resolveRequestedLegacyModeCode(legacyModes, requestedMode);
    if (!resolvedLegacyMode) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy mode request: ${requestedMode}`);
      return;
    }
    if (resolvedLegacyMode === legacyModes.currentModeId) {
      return;
    }

    const switched = await backend.setSessionMode(resolvedLegacyMode);
    if (switched) {
      legacyModes = {
        ...legacyModes,
        currentModeId: resolvedLegacyMode,
      };
    }
  };

  const switchModelIfRequested = async (requestedModel: string): Promise<void> => {
    if (!requestedModel) {
      return;
    }

    if (modelSelector) {
      const resolved = resolveRequestedCode(modelSelector.options, requestedModel);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP model request: ${requestedModel}`);
        return;
      }
      if (resolved === modelSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modelSelector.configId, resolved);
      if (switched) {
        modelSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModels) {
      return;
    }

    const resolvedLegacyModel = resolveRequestedLegacyModelCode(legacyModels, requestedModel);
    if (!resolvedLegacyModel) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy model request: ${requestedModel}`);
      return;
    }
    if (resolvedLegacyModel === legacyModels.currentModelId) {
      return;
    }

    const switched = await backend.setSessionModel(resolvedLegacyModel);
    if (switched) {
      legacyModels = {
        ...legacyModels,
        currentModelId: resolvedLegacyModel,
      };
      session.updateMetadata((currentMetadata) =>
        mergeAcpSessionConfigIntoMetadata(currentMetadata, {
          models: legacyModels,
        }),
      );
    }
  };

  const switchThoughtLevelIfRequested = async (requestedThoughtLevel: string): Promise<void> => {
    if (!requestedThoughtLevel || !thoughtLevelSelector) {
      return;
    }

    const resolved = resolveRequestedCode(thoughtLevelSelector.options, requestedThoughtLevel);
    if (!resolved) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP thought level request: ${requestedThoughtLevel}`);
      return;
    }
    if (resolved === thoughtLevelSelector.currentCode) {
      return;
    }
    const switched = await backend.setSessionConfigOption(thoughtLevelSelector.configId, resolved);
    if (switched) {
      thoughtLevelSelector.currentCode = resolved;
    }
  };

  const getTerminalModelOptions = (): { options: TerminalPickOption[]; currentKey: string | null } => {
    if (modelSelector) {
      return {
        currentKey: modelSelector.currentCode,
        options: modelSelector.options.map((option) => ({
          key: option.code,
          label: option.value,
        })),
      };
    }
    if (legacyModels) {
      return {
        currentKey: legacyModels.currentModelId,
        options: legacyModels.availableModels.map((model) => ({
          key: model.modelId,
          label: model.name,
        })),
      };
    }
    return { options: [], currentKey: null };
  };

  const handleTerminalModelCommand = async (rawArgument: string): Promise<void> => {
    const requestedModel = rawArgument.trim();
    if (requestedModel.length > 0) {
      await switchModelIfRequested(requestedModel);
      terminalChat?.turnSettled();
      return;
    }

    const { options, currentKey } = getTerminalModelOptions();
    const selected = await terminalChat?.pick({
      title: 'Select model',
      options,
      currentKey,
    });
    if (selected) {
      await switchModelIfRequested(selected);
    }
    terminalChat?.turnSettled();
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      if (verbose) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName} (${commands.length}):`);
        for (const command of commands) {
          logAcp('muted', `  /${command.name}${formatOptionalDetail(command.description, 160)}`);
        }
      }
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        slashCommands: commandNames,
      }));
    }

    if (msg.type === 'event' && msg.name === 'config_options_update') {
      const configOptions = extractConfigOptionsFromPayload(msg.payload);
      if (configOptions) {
        if (verbose) {
          logAcp('muted', `Outgoing config options from ${opts.agentName} (${configOptions.length}):`);
          for (const option of configOptions) {
            if (option.type === 'select') {
              const optionValues = flattenSelectOptions(option.options);
              logAcp('muted', `  config=${option.id} category=${option.category ?? 'unknown'} current=${option.currentValue} options=${optionValues.length}`);
            } else {
              logAcp('muted', `  config=${option.id} type=${option.type} category=${option.category ?? 'unknown'}`);
            }
          }
        }

        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        thoughtLevelSelector = extractConfigSelector(configOptions, 'thought_level');
        sawModes = sawModes || modeSelector !== null;
        sawModels = sawModels || modelSelector !== null;
        if (verbose) {
          if (modeSelector) {
            logAcp('muted', `Outgoing mode options from ${opts.agentName} (${modeSelector.options.length}), current=${modeSelector.currentCode}:`);
            for (const option of modeSelector.options) {
              logAcp('muted', `  mode=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing mode options from ${opts.agentName}: not reported in config options`);
          }
          if (modelSelector) {
            logAcp('muted', `Outgoing model options from ${opts.agentName} (${modelSelector.options.length}), current=${modelSelector.currentCode}:`);
            for (const option of modelSelector.options) {
              logAcp('muted', `  model=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing model options from ${opts.agentName}: not reported in config options`);
          }
          if (thoughtLevelSelector) {
            logAcp('muted', `Outgoing thought levels from ${opts.agentName} (${thoughtLevelSelector.options.length}), current=${thoughtLevelSelector.currentCode}:`);
            for (const option of thoughtLevelSelector.options) {
              logAcp('muted', `  thought=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing thought levels from ${opts.agentName}: not reported in config options`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { configOptions }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'modes_update') {
      const modes = extractModeStateFromPayload(msg.payload);
      if (modes) {
        legacyModes = modes;
        sawModes = true;
        if (verbose) {
          logAcp('muted', `Outgoing modes from ${opts.agentName} (${modes.availableModes.length}), current=${modes.currentModeId}:`);
          for (const mode of modes.availableModes) {
            logAcp('muted', `  mode=${mode.id} name=${mode.name}${formatOptionalDetail(mode.description, 160)}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { modes }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'current_mode_update') {
      const currentModeId = extractCurrentModeIdFromPayload(msg.payload);
      if (currentModeId) {
        if (modeSelector) {
          modeSelector = {
            ...modeSelector,
            currentCode: currentModeId,
          };
        }
        if (legacyModes) {
          legacyModes = {
            ...legacyModes,
            currentModeId,
          };
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId }),
        );
      }
    }

    if (msg.type === 'status') {
      const suffix = msg.detail ? `: ${msg.detail}` : '';
      const statusLine = `Status: ${msg.status}${suffix}`;
      logAcp('muted', statusLine);
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
      // A user-driven cancel only interrupts the running turn; the session
      // stays alive and accepts the next prompt.
      const isUserCancel = msg.status === 'stopped' && msg.detail === CANCELLED_BY_USER_DETAIL;
      const isRecoverableStartupError = keepSessionOpenOnStartupError && msg.status === 'error';
      if (!isRecoverableStartupError && (msg.status === 'error' || (msg.status === 'stopped' && !isUserCancel))) {
        stopRunnerFromBackendStatus(msg.status, msg.detail);
      }
    }

    if (terminalChat && msg.type === 'model-output') {
      const text = msg.textDelta ?? msg.fullText ?? '';
      if (text) {
        terminalChat.writeAgentText(text);
      }
    } else {
      const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
      if (frontendMessage) {
        logAcp(frontendMessage.kind, frontendMessage.text);
      }
    }

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0) {
      session.sendSessionEvent({
        type: 'message',
        message: `${opts.agentName} error: ${msg.detail?.trim() || 'The agent stopped because of an unknown error.'}`,
      });
    }
    if (msg.type === 'status' && msg.status === 'error') {
      errorReportedForCurrentTurn = true;
    }
  };

  backend.onMessage(onBackendMessage);

  session.onUserMessage((message) => {
    if (!message.content.text) {
      return;
    }

    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      currentModel = message.meta.model ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'effort')) {
      currentEffort = message.meta.effort ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP thought level: ${currentEffort ?? 'null'}`);
    }

    currentTurnOrigin = 'remote';
    syncGate.beginTurn('remote');
    terminalChat?.showRemotePrompt(message.content.text);
    messageQueue.push(message.content.text, {
      permissionMode: currentPermissionMode,
      model: currentModel,
      effort: currentEffort,
    });
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    try {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      permissionHandler.reset();
      abortController.abort();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Abort failed:`, error);
    } finally {
      abortController = new AbortController();
    }
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);

  let isCleaningUp = false;
  const cleanup = async (cleanupOpts: { archive?: boolean } = { archive: false }) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    shouldExit = true;
    messageQueue.close();
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('ACP runner shutting down'));
    activeTerminalChat = null;
    terminalChat?.stop();

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to reset permission handler:`, error);
    }

    backend.offMessage?.(onBackendMessage);
    try {
      await backend.dispose();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to dispose backend:`, error);
    }

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to stop Happy MCP server:`, error);
    }

    try {
      if (cleanupOpts.archive) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'Session ended',
        }));
      }
      session.sendSessionDeath();
      try {
        await api.deactivateSession(session.sessionId);
      } catch (err) {
        logger.debug(`[${opts.agentName}] deactivateSession during cleanup failed:`, err);
      }
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  };

  const onSigInt = () => {
    void cleanup({ archive: false }).then(() => process.exit(0));
  };
  const onSigTerm = () => {
    void cleanup({ archive: false }).then(() => process.exit(0));
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  // Interactive terminals join the same session as the phone app: prompts typed
  // here are queued exactly like remote ones and mirrored into the session
  // transcript so both sides see one conversation. Non-TTY runs (daemon) get
  // no chat and keep the log-only behavior.
  const handleSyncCommand = (text: string): boolean => {
    if (text !== '/sync' && text !== '/sync off') {
      return false;
    }
    if (text === '/sync') {
      syncGate.enable();
      logAcp('muted', 'Phone sync enabled — new terminal turns will appear on your phone.');
    } else {
      syncGate.disable();
      logAcp('muted', 'Phone sync disabled — terminal turns stay off the phone.');
    }
    terminalChat?.turnSettled();
    return true;
  };

  terminalChat = startTerminalChat({
    prompt: `${opts.agentName}> `,
    onSubmit: (text) => {
      if (messageQueue.isClosed()) {
        return;
      }
      if (handleSyncCommand(text)) {
        return;
      }
      if (text === '/model' || text.startsWith('/model ')) {
        void handleTerminalModelCommand(text.slice('/model'.length));
        return;
      }
      currentTurnOrigin = 'local';
      syncGate.beginTurn('local');
      if (syncGate.shouldUpload()) {
        session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
      }
      if (text.startsWith('/')) {
        messageQueue.pushIsolateAndClear(text, {});
      } else {
        messageQueue.push(text, {});
      }
    },
    onRequestExit: () => {
      void cleanup({ archive: false }).then(() => process.exit(0));
    },
  });
  activeTerminalChat = terminalChat;
  session.onHistoryMessage((message) => showTerminalHistoryMessage(terminalChat, message));

  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
    await cleanup({ archive: true });
  });

  try {
    if (opts.agentName === 'traex' && opts.resumeAcpSessionId && !reconnectSessionId) {
      for (const envelope of buildTraexHistoryBackfillEnvelopes(opts.resumeAcpSessionId)) {
        session.sendSessionProtocolMessage(envelope);
        showTerminalHistoryMessage(terminalChat, {
          role: 'session',
          content: { type: 'session', data: envelope },
        });
      }
    }
    try {
      keepSessionOpenOnStartupError = opts.agentName === 'traex' && !!opts.resumeAcpSessionId && !reconnectSessionId;
      const started = await backend.startSession();
      keepSessionOpenOnStartupError = false;
      acpSessionId = started.sessionId;
    } catch (error) {
      keepSessionOpenOnStartupError = false;
      const detail = error instanceof Error ? error.message : formatUnknownForConsole(error, ACP_RAW_PREVIEW_CHARS);
      logAcp('error', `${opts.agentName} failed to resume session: ${detail}`);
      if (!errorReportedForCurrentTurn && syncGate.shouldUpload()) {
        session.sendSessionEvent({
          type: 'message',
          message: `${opts.agentName} error: ${detail}`,
        });
        errorReportedForCurrentTurn = true;
      }
      if (syncGate.shouldUpload()) {
        session.sendSessionEvent({ type: 'ready' });
      }
      terminalChat?.turnSettled();
      while (!shouldExit) {
        const batch = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
        if (!batch) break;
        logAcp('error', `${opts.agentName} is not connected. ${detail}`);
        terminalChat?.turnSettled();
      }
      return;
    }
    if (acpSessionIdMetadataKey) {
      const nextMetadata = {
        ...metadata,
        [acpSessionIdMetadataKey]: acpSessionId ?? undefined,
      };
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        [acpSessionIdMetadataKey]: acpSessionId ?? undefined,
      }));
      if (response) {
        try {
          await notifyDaemonSessionStarted(response.id, nextMetadata, {
            encryptionKey: encodeBase64(response.encryptionKey),
            encryptionVariant: response.encryptionVariant,
            seq: response.seq,
            metadataVersion: response.metadataVersion,
            agentStateVersion: response.agentStateVersion,
          });
        } catch (error) {
          logger.debug(`[acp] Failed to report ${opts.agentName} ACP session ID to daemon:`, error);
        }
      }
    }
    if (verbose) {
      if (!sawSlashCommands) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName}: not reported yet`);
      }
      if (!sawModes) {
        logAcp('muted', `Outgoing modes from ${opts.agentName}: not reported yet`);
      }
      if (!sawModels) {
        logAcp('muted', `Outgoing models from ${opts.agentName}: not reported yet`);
      }
    }
    if (terminalChat) {
      logAcp('muted', syncGate.isEnabled()
        ? 'Chat enabled in this terminal — the same session is live in the Happy app. Ctrl+C exits.'
        : 'Chat enabled in this terminal — phone sync is OFF, terminal turns stay local until you run /sync. Ctrl+C exits.');
      terminalChat.turnSettled();
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!acpSessionId) {
        throw new Error('ACP session is not started');
      }

      if (!terminalChat || verbose) {
        logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      }
      errorReportedForCurrentTurn = false;
      const turnStartedAt = Date.now();
      terminalChat?.setBusy(true, `${opts.agentName} is working…`);
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
          await switchModelIfRequested(batch.mode.model);
        }
        if (typeof batch.mode.effort === 'string' && batch.mode.effort.length > 0) {
          await switchThoughtLevelIfRequested(batch.mode.effort);
        }
        await backend.sendPrompt(acpSessionId, batch.message);
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn('completed'));
        if (syncGate.shouldUpload()) {
          session.sendSessionEvent({ type: 'ready' });
        }
        syncGate.endTurn();
        currentTurnOrigin = null;
        if (terminalChat && !verbose) {
          logAcp('muted', `✓ Turn completed in ${((Date.now() - turnStartedAt) / 1000).toFixed(1)}s`);
        }
        terminalChat?.turnSettled();
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : formatUnknownForConsole(error, ACP_RAW_PREVIEW_CHARS);
        if (!errorReportedForCurrentTurn && syncGate.shouldUpload()) {
          session.sendSessionEvent({
            type: 'message',
            message: `${opts.agentName} error: ${detail}`,
          });
          errorReportedForCurrentTurn = true;
        }
        sendEnvelopes(sessionManager.endTurn('failed'));
        if (syncGate.shouldUpload()) {
          session.sendSessionEvent({ type: 'ready' });
        }
        syncGate.endTurn();
        currentTurnOrigin = null;
        terminalChat?.turnSettled();
        logAcp('error', `Prompt error from ${opts.agentName}: ${detail} — session kept alive, send another message to retry`);
        clearPendingTurn(error instanceof Error ? error : new Error(detail));
        await turnEnded.catch(() => {});
        // A failed prompt (model error, rate limit, timeout) keeps the session
        // alive; genuinely fatal backend failures flip shouldExit above and end
        // the loop on the next iteration.
        continue;
      }
    }
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    await cleanup({ archive: true });
  }
}
