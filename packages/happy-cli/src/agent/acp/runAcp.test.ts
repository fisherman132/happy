import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;
  let mockAgentState: Record<string, any> = {};
  const mockPushSend = vi.fn();

  const mockSession = {
    sessionId: 'session-1',
    api: { push: () => ({ sendSessionNotification: mockPushSend }) },
    getMetadata: vi.fn(() => ({ path: '/tmp/happy', flavor: 'traex' })),
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    onHistoryMessage: vi.fn(),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn(async (handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      mockAgentState = handler(mockAgentState);
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    startSessionError: null as unknown,
    sendPromptError: null as Error | null,
    sendPromptBlocker: null as Promise<void> | null,
    startSessionCalls: 0,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
  };

  type FakeTerminalChat = {
    opts: { prompt?: string; onSubmit: (text: string) => void; onRequestExit: () => void };
    breakLine: ReturnType<typeof vi.fn>;
    writeAgentText: ReturnType<typeof vi.fn>;
    showRemotePrompt: ReturnType<typeof vi.fn>;
    pick: ReturnType<typeof vi.fn>;
    turnSettled: ReturnType<typeof vi.fn>;
    setBusy: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  const terminalChat = {
    enabled: false,
    instance: null as FakeTerminalChat | null,
  };

  return {
    terminalChat,
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockPushSend,
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockDeactivateSession: vi.fn(async () => true),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockStartHappyServer: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy'),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    mockConsoleLog: vi.spyOn(console, 'log').mockImplementation(() => {}),
    sessionHandlers,
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    getAgentState: () => mockAgentState,
    setAgentState: (state: Record<string, any>) => {
      mockAgentState = state;
    },
    mockSession,
    backendState,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: mocks.mockReadSettings,
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: { host: 'host', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy' },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('./terminalChat', () => ({
  startTerminalChat: (opts: {
    prompt?: string;
    onSubmit: (text: string) => void;
    onRequestExit: () => void;
  }) => {
    if (!mocks.terminalChat.enabled) {
      return null;
    }
    mocks.terminalChat.instance = {
      opts,
      breakLine: vi.fn(),
      writeAgentText: vi.fn(),
      showRemotePrompt: vi.fn(),
      pick: vi.fn(),
      turnSettled: vi.fn(),
      setBusy: vi.fn(),
      stop: vi.fn(),
    };
    return mocks.terminalChat.instance;
  },
}));

vi.mock('./AcpBackend', () => ({
  AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
    }

    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      mocks.backendState.startSessionCalls += 1;
      if (mocks.backendState.startSessionError) {
        throw mocks.backendState.startSessionError;
      }
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: mocks.backendState.constructorArgs?.resumeSessionId ?? 'acp-session-1' };
    }

    async sendPrompt(sessionId: string, prompt: string) {
      mocks.backendState.prompts.push({ sessionId, prompt });
      if (mocks.backendState.sendPromptBlocker) {
        await mocks.backendState.sendPromptBlocker;
      }
      if (mocks.backendState.sendPromptError) {
        throw mocks.backendState.sendPromptError;
      }
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'running' });
        listener({ type: 'model-output', textDelta: 'hello' });
        listener({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
        listener({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
        listener({ type: 'status', status: 'idle' });
      }
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      return true;
    }

    async setSessionMode(modeId: string) {
      mocks.backendState.setModeCalls.push(modeId);
      return true;
    }

    async setSessionModel(modelId: string) {
      mocks.backendState.setModelCalls.push(modelId);
      return true;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
        listener({ type: 'status', status: 'idle' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runAcp } from './runAcp';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.setAgentState({});
    mocks.terminalChat.enabled = false;
    mocks.terminalChat.instance = null;
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.startSessionError = null;
    mocks.backendState.sendPromptError = null;
    mocks.backendState.sendPromptBlocker = null;
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;
    mocks.mockPushSend.mockClear();

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
      deactivateSession: mocks.mockDeactivateSession,
      push: () => ({ sendSessionNotification: mocks.mockPushSend }),
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
    mocks.mockStartHappyServer.mockResolvedValue({
      url: 'http://127.0.0.1:9876',
      stop: vi.fn(),
    });
  });

  it('wires backend messages through mapper into session envelopes', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Build a test plan' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('opencode');
    expect(mocks.backendState.constructorArgs.args).toEqual(['--acp']);
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Build a test plan',
    });

    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Happy Session ID: session-1',
      'Incoming prompt: Build a test plan',
      'Status: running',
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
      'Tool: ReadFile completed (callId=tool-1)',
      'Status: idle',
    ]));
  });

  it('registers abort handler that cancels the ACP backend session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    expect(abortHandler).toBeTypeOf('function');

    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('keeps terminal turns off the phone with --no-sync until /sync is enabled', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
      noSync: true,
    });
    const runOutcome = runPromise.then(() => null, (error: unknown) => error);

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });
    const chat = mocks.terminalChat.instance!;
    expect(consoleLines()).toEqual(expect.arrayContaining([
      expect.stringContaining('phone sync is OFF'),
    ]));

    chat.opts.onSubmit('secret question');
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    // The whole local turn — prompt mirror, agent envelopes, ready event —
    // stays off the server while sync is off, and nothing is retained.
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(mocks.mockSession.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' });

    // /sync is a local command: it must not reach the agent and uploads
    // nothing retroactively.
    chat.opts.onSubmit('/sync');
    expect(mocks.backendState.prompts).toHaveLength(1);
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      expect.stringContaining('Phone sync enabled'),
    ]));

    // Turns after /sync sync live again.
    chat.opts.onSubmit('visible now');
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionProtocolMessage).toHaveBeenCalled();
    });
    const sent = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope);
    expect(sent[0]).toMatchObject({ role: 'user', ev: { t: 'text', text: 'visible now' } });
    expect(sent.slice(1).map((envelope) => envelope.ev.t)).toEqual([
      'turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end',
    ]);

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('syncs phone turns live even when started with --no-sync', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
      noSync: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'From the phone' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    // Remote-initiated turns upload immediately regardless of the flag.
    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('surfaces ACP permission requests and resolves with the selected ACP option', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });
    const runOutcome = runPromise.then(() => null, (error: unknown) => error);

    await vi.waitFor(() => {
      expect(mocks.backendState.constructorArgs?.permissionHandler).toBeDefined();
    });

    const pending = mocks.backendState.constructorArgs.permissionHandler.handleToolCall(
      'call-permission-1',
      'Run command',
      { command: 'touch ok' },
      {
        acpTitle: 'Run command',
        acpKind: 'execute',
        acpOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    );

    await vi.waitFor(() => {
      expect(mocks.getAgentState().requests?.['call-permission-1']).toMatchObject({
        tool: 'Run command',
        arguments: { command: 'touch ok' },
        acpOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
    });
    expect(mocks.mockPushSend).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'permission',
      data: expect.objectContaining({
        sessionId: 'session-1',
        requestId: 'call-permission-1',
        provider: 'traex',
      }),
    }));
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'traex is waiting for permission: Run command (id=call-permission-1) options=[Allow once (allow_once), Reject (reject_once)]',
    ]));

    const permissionRpc = mocks.sessionHandlers.get('permission');
    expect(permissionRpc).toBeTypeOf('function');
    await permissionRpc!({
      id: 'call-permission-1',
      approved: true,
      decision: 'approved',
      acpOptionId: 'allow-once',
    });

    await expect(pending).resolves.toEqual({
      decision: 'approved',
      acpOptionId: 'allow-once',
    });
    expect(mocks.getAgentState().requests?.['call-permission-1']).toBeUndefined();
    expect(mocks.getAgentState().completedRequests?.['call-permission-1']).toMatchObject({
      status: 'approved',
      decision: 'approved',
      acpOptionId: 'allow-once',
    });

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('offers a terminal picker for local ACP permission requests', async () => {
    mocks.terminalChat.enabled = true;
    let releasePrompt!: () => void;
    mocks.backendState.sendPromptBlocker = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });
    const runOutcome = runPromise.then(() => null, (error: unknown) => error);

    await vi.waitFor(() => {
      expect(mocks.terminalChat.instance).toBeTruthy();
      expect(mocks.backendState.constructorArgs?.permissionHandler).toBeDefined();
    });

    mocks.terminalChat.instance!.opts.onSubmit('run a local command');
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    mocks.terminalChat.instance!.pick.mockResolvedValueOnce('allow-once');
    const pending = mocks.backendState.constructorArgs.permissionHandler.handleToolCall(
      'call-local-permission-1',
      'execute',
      { command: 'pwd' },
      {
        acpTitle: 'Run pwd',
        acpKind: 'execute',
        acpOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    );

    await vi.waitFor(() => {
      expect(mocks.terminalChat.instance!.pick).toHaveBeenCalledWith({
        title: 'traex permission: Run pwd',
        options: [
          { key: 'allow-once', label: 'Allow once', description: 'allow_once' },
          { key: 'reject-once', label: 'Reject', description: 'reject_once' },
        ],
      });
    });

    await expect(pending).resolves.toEqual({
      decision: 'approved',
      acpOptionId: 'allow-once',
    });
    expect(mocks.getAgentState().completedRequests?.['call-local-permission-1']).toMatchObject({
      status: 'approved',
      acpOptionId: 'allow-once',
    });

    releasePrompt();
    await vi.waitFor(() => {
      expect(consoleLines()).toEqual(expect.arrayContaining([
        expect.stringContaining('✓ Turn completed'),
      ]));
    });

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('keeps the session alive after a user abort accepts the next prompt', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
    const runOutcome = runPromise.then(() => null, (error: unknown) => error);

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Long running task' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    // The abort only interrupted the turn — the session must keep accepting prompts.
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Try something smaller' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(2);
    });
    expect(mocks.backendState.prompts[1]).toMatchObject({ prompt: 'Try something smaller' });

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('runs Kimi through the ACP backend and records kimi session flavor', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('kimi');
    expect(mocks.backendState.constructorArgs.args).toEqual(['acp']);
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ flavor: 'kimi' }),
    }));
    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const appliedMetadata = metadataHandlers.map((handler) => handler({ flavor: 'kimi' }));
    expect(appliedMetadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ kimiSessionId: 'acp-session-1' }),
    ]));
  });

  it('passes a Kimi ACP session ID to the backend for resume', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
      resumeAcpSessionId: 'kimi-session-old',
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.resumeSessionId).toBe('kimi-session-old');
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        flavor: 'kimi',
        kimiSessionId: 'kimi-session-old',
      }),
    }));
  });

  it('runs TraeX through the ACP backend and records traex session flavor', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('traex');
    expect(mocks.backendState.constructorArgs.args).toEqual(['acp', 'serve']);
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ flavor: 'traex' }),
    }));
    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const appliedMetadata = metadataHandlers.map((handler) => handler({ flavor: 'traex' }));
    expect(appliedMetadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ traexSessionId: 'acp-session-1' }),
    ]));
  });

  it('passes a TraeX ACP session ID to the backend for resume', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
      resumeAcpSessionId: 'traex-session-old',
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.resumeSessionId).toBe('traex-session-old');
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        flavor: 'traex',
        traexSessionId: 'traex-session-old',
      }),
    }));
  });

  it('stores a user-specified ACP session name in metadata without passing it to the backend command', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
      sessionName: '  Phone QA  ',
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.args).toEqual(['acp', 'serve']);
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        flavor: 'traex',
        name: 'Phone QA',
      }),
    }));
  });

  it('emits thinking messages in default mode', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    const listener = mocks.backendState.listeners[0];
    const prompts = mocks.backendState.prompts;
    if (!listener) {
      throw new Error('Expected backend listener to be registered');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Think first' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    listener({ type: 'event', name: 'thinking', payload: { text: 'Analyzing request' } });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(prompts).toHaveLength(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Thinking: "Analyzing request"',
    ]));
  });

  it('emits raw backend and envelope logs when verbose is enabled', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run the command' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines.some((line) => line.startsWith('Outgoing raw backend message from opencode: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Incoming raw envelope for opencode: '))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
    ]));
  });

  it('logs slash commands, modes, and models line by line when verbose is enabled', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'available_commands',
        payload: [
          { name: 'init', description: 'create/update AGENTS.md' },
          { name: 'review', description: 'review uncommitted changes' },
        ],
      },
      {
        type: 'event',
        name: 'modes_update',
        payload: {
          availableModes: [
            { id: 'build', name: 'build', description: 'Executes tools' },
            { id: 'plan', name: 'plan', description: 'Disallows edit tools' },
          ],
          currentModeId: 'build',
        },
      },
      {
        type: 'event',
        name: 'models_update',
        payload: {
          currentModelId: 'gemini-2.5-pro',
          availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing slash commands from gemini (2):',
      '  /init - create/update AGENTS.md',
      '  /review - review uncommitted changes',
      'Outgoing modes from gemini (2), current=build:',
      '  mode=build name=build - Executes tools',
      '  mode=plan name=plan - Disallows edit tools',
      'Outgoing models from gemini (2), current=gemini-2.5-pro:',
      '  model=gemini-2.5-pro name=Gemini 2.5 Pro',
      '  model=gemini-2.5-flash name=Gemini 2.5 Flash',
    ]));
  });

  it('exits when backend reports terminal startup status', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'status', status: 'error', detail: 'spawn opencode ENOENT' },
    ];

    await runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    expect(consoleLines()).toContain('Status: error: spawn opencode ENOENT');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'opencode error: spawn opencode ENOENT',
    });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('keeps TraeX resume history visible when the resumed thread is already locked', async () => {
    mocks.terminalChat.enabled = true;
    mocks.backendState.startSessionError = { code: -32603, message: 'thread-store conflict: thread already has an active writer' };
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
      resumeAcpSessionId: 'locked-thread',
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });
    const chat = mocks.terminalChat.instance;
    if (!chat) {
      throw new Error('Expected terminal chat to be started');
    }
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'traex failed to resume session: {"code":-32603,"message":"thread-store conflict: thread already has an active writer"}',
    ]));
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'traex error: {"code":-32603,"message":"thread-store conflict: thread already has an active writer"}',
    });
    await vi.waitFor(() => {
      expect(chat.turnSettled).toHaveBeenCalled();
    });
    expect(mocks.backendState.disposeCalls).toBe(0);
    await mocks.getKillHandler()!();
    await runPromise;
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('reports a prompt error, serializes raw objects, and keeps the session alive', async () => {
    // Raw JSON-RPC error object as rejected by the ACP SDK client.
    mocks.backendState.sendPromptError = { code: -32603, message: 'kimi upstream unavailable' } as unknown as Error;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
    const runOutcome = runPromise.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Use that model' },
    });

    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: 'opencode error: {"code":-32603,"message":"kimi upstream unavailable"}',
      });
    });
    expect(consoleLines()).toEqual(expect.arrayContaining([
      expect.stringContaining('Prompt error from opencode: {"code":-32603,"message":"kimi upstream unavailable"}'),
    ]));
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });

    // The runner stays up: after the failure clears, the next prompt works.
    mocks.backendState.sendPromptError = null;
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Try again' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(2);
    });

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('reports a prompt exception and keeps the session alive', async () => {
    mocks.backendState.sendPromptError = new Error('model switch failed');
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
    const runOutcome = runPromise.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Use that model' },
    });

    await vi.waitFor(() => {
      expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: 'opencode error: model switch failed',
      });
    });

    // No rethrow, no exit: the queue still accepts the next prompt.
    mocks.backendState.sendPromptError = null;
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Retry now' },
    });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(2);
    });

    await mocks.getKillHandler()!();
    expect(await runOutcome).toBeNull();
  });

  it('updates session metadata with ACP config options (models and operating modes)', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'code',
              options: [
                { value: 'ask', name: 'Ask', description: 'Q&A mode' },
                { value: 'code', name: 'Code', description: 'Implementation mode' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
                { value: 'claude-opus', name: 'Claude Opus', description: 'Deep reasoning model' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const baseMetadata = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
    };
    const appliedMetadata = metadataHandlers.map((handler) => handler(baseMetadata));

    expect(appliedMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentModelCode: 'claude-sonnet',
          currentOperatingModeCode: 'code',
          models: [
            { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
            { code: 'claude-opus', value: 'Claude Opus', description: 'Deep reasoning model' },
          ],
          operatingModes: [
            { code: 'ask', value: 'Ask', description: 'Q&A mode' },
            { code: 'code', value: 'Code', description: 'Implementation mode' },
          ],
        }),
      ]),
    );
  });

  it('switches ACP model, permission mode, and thought level when requested values match config options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
            {
              type: 'select',
              id: 'thought-level',
              name: 'Thinking',
              category: 'thought_level',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Apply settings then run' },
      meta: {
        permissionMode: 'Code',
        model: 'claude-opus',
        effort: 'High',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'permission-mode', value: 'code' },
      { configId: 'model', value: 'claude-opus' },
      { configId: 'thought-level', value: 'high' },
    ]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('uses ACP config option id/name heuristics without confusing model with mode', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'sessionModel',
              name: 'Model',
              currentValue: 'kimi-k2',
              options: [
                { value: 'kimi-k2', name: 'Kimi K2' },
                { value: 'kimi-k2,thinking', name: 'Kimi K2 (thinking)' },
              ],
            },
            {
              type: 'select',
              id: 'thinking-effort',
              name: 'Thinking',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Use the thinking variant' },
      meta: {
        permissionMode: 'Kimi K2 (thinking)',
        model: 'Kimi K2 (thinking)',
        effort: 'High',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'sessionModel', value: 'kimi-k2,thinking' },
      { configId: 'thinking-effort', value: 'high' },
    ]);
  });

  it('does not classify unknown explicit ACP config categories by id/name', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'sessionModel',
              name: 'Model Routing',
              category: '_vendor_model',
              currentValue: 'old',
              options: [
                { value: 'old', name: 'Old' },
                { value: 'new', name: 'New' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'kimi',
      command: 'kimi',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without config switching' },
      meta: {
        model: 'new',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
  });

  it('ignores ACP model and permission mode requests when values do not match advertised options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without switching' },
      meta: {
        permissionMode: 'invalid-mode',
        model: 'invalid-model',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('streams terminal chat prompts through the shared session queue', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });
    const chat = mocks.terminalChat.instance;
    if (!chat) {
      throw new Error('Expected terminal chat to be started');
    }
    // Initial prompt appears once the backend session is up.
    expect(chat.turnSettled).toHaveBeenCalledTimes(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Chat enabled in this terminal — the same session is live in the Happy app. Ctrl+C exits.',
    ]));

    chat.opts.onSubmit('Fix the failing tests');

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Fix the failing tests',
    });

    // The local prompt is mirrored into the session transcript so the phone app
    // shows it in the same conversation.
    const userEnvelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.role === 'user');
    expect(userEnvelopes).toHaveLength(1);
    expect(userEnvelopes[0]).toMatchObject({
      role: 'user',
      ev: { t: 'text', text: 'Fix the failing tests' },
    });

    // Assistant output streams into the chat in full and the prompt returns
    // after the turn settles.
    expect(chat.writeAgentText).toHaveBeenCalledWith('hello');
    await vi.waitFor(() => {
      expect(chat.turnSettled).toHaveBeenCalledTimes(2);
    });

    await mocks.getKillHandler()!();
    await runPromise;
    expect(chat.stop).toHaveBeenCalled();
  });

  it('shows phone prompts in the terminal chat instead of the truncated log', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    const chat = mocks.terminalChat.instance;
    if (!chat) {
      throw new Error('Expected terminal chat to be started');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run from the phone' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    expect(chat.showRemotePrompt).toHaveBeenCalledWith('Run from the phone');
    expect(mocks.backendState.prompts[0]).toMatchObject({ prompt: 'Run from the phone' });
    expect(consoleLines()).not.toContain('Incoming prompt: Run from the phone');

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('lets TraeX accept prompts from both the terminal and the phone in one ACP session', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    const chat = mocks.terminalChat.instance;
    if (!chat) {
      throw new Error('Expected terminal chat to be started');
    }

    chat.opts.onSubmit('Run from the terminal');
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run from the phone' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Run from the terminal\nRun from the phone',
    });
    expect(mocks.backendState.prompts.every((prompt) => prompt.sessionId === 'acp-session-1')).toBe(true);
    expect(chat.showRemotePrompt).toHaveBeenCalledWith('Run from the phone');

    const userEnvelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.role === 'user');
    expect(userEnvelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', ev: { t: 'text', text: 'Run from the terminal' } }),
    ]));

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('sends terminal slash commands as isolated ACP turns so backend commands still work', async () => {
    mocks.terminalChat.enabled = true;
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    const chat = mocks.terminalChat.instance;
    if (!chat) {
      throw new Error('Expected terminal chat to be started');
    }

    chat.opts.onSubmit('ordinary setup text');
    chat.opts.onSubmit('/resume old-session');

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: '/resume old-session',
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('opens a terminal model picker for /model and switches through ACP config options', async () => {
    mocks.terminalChat.enabled = true;
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              id: 'sessionModel',
              type: 'select',
              name: 'Model',
              category: 'model',
              currentValue: 'model-a',
              options: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-b', name: 'Model B' },
              ],
            },
          ],
        },
      },
    ];
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });

    await vi.waitFor(() => {
      expect(mocks.terminalChat.instance?.pick).toBeTypeOf('function');
    });
    const chat = mocks.terminalChat.instance!;
    chat.pick.mockResolvedValueOnce('model-b');

    chat.opts.onSubmit('/model');

    await vi.waitFor(() => {
      expect(mocks.backendState.setConfigOptionCalls).toEqual([
        { configId: 'sessionModel', value: 'model-b' },
      ]);
    });

    expect(chat.pick).toHaveBeenCalledWith({
      title: 'Select model',
      currentKey: 'model-a',
      options: [
        { key: 'model-a', label: 'Model A' },
        { key: 'model-b', label: 'Model B' },
      ],
    });
    expect(mocks.backendState.prompts).toEqual([]);
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ ev: expect.objectContaining({ text: '/model' }) }),
    );

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('switches models directly for /model arguments without sending a prompt', async () => {
    mocks.terminalChat.enabled = true;
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              id: 'sessionModel',
              type: 'select',
              name: 'Model',
              category: 'model',
              currentValue: 'model-a',
              options: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-b', name: 'Model B' },
              ],
            },
          ],
        },
      },
    ];
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'traex',
      command: 'traex',
      args: ['acp', 'serve'],
    });

    await vi.waitFor(() => {
      expect(mocks.terminalChat.instance).not.toBeNull();
    });
    const chat = mocks.terminalChat.instance!;

    chat.opts.onSubmit('/model Model B');

    await vi.waitFor(() => {
      expect(mocks.backendState.setConfigOptionCalls).toEqual([
        { configId: 'sessionModel', value: 'model-b' },
      ]);
    });
    expect(chat.pick).not.toHaveBeenCalled();
    expect(mocks.backendState.prompts).toEqual([]);

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('sends session death, deactivates session, and closes on kill session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getKillHandler()).toBeTypeOf('function');
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.mockSession.sendSessionDeath).toHaveBeenCalled();
    expect(mocks.mockDeactivateSession).toHaveBeenCalledWith('session-1');
    expect(mocks.mockSession.close).toHaveBeenCalled();
  });
});
