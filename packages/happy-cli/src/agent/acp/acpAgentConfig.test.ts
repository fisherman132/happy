import { describe, expect, it, vi } from 'vitest';

vi.mock('@/kimi/constants', () => ({
  KIMI_BIN: 'kimi',
  resolveKimiBin: () => '/opt/kimi/bin/kimi',
}));

vi.mock('@/traex/constants', () => ({
  TRAEX_BIN: 'traex',
  resolveTraexBin: () => '/opt/traex/bin/traex',
}));

import { KNOWN_ACP_AGENTS, resolveAcpAgentConfig } from './acpAgentConfig';

describe('KNOWN_ACP_AGENTS', () => {
  it('defines built-in ACP command mappings', () => {
    expect(KNOWN_ACP_AGENTS).toEqual({
      gemini: { command: 'gemini', args: ['--experimental-acp'] },
      kimi: { command: 'kimi', args: ['acp'] },
      traex: { command: 'traex', args: ['acp', 'serve'] },
      opencode: { command: 'opencode', args: ['acp'] },
    });
  });
});

describe('resolveAcpAgentConfig', () => {
  it('resolves known agent names to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['kimi'])).toEqual({
      agentName: 'kimi',
      command: '/opt/kimi/bin/kimi',
      args: ['acp'],
    });
  });

  it('appends extra CLI args for Kimi after the acp subcommand', () => {
    expect(resolveAcpAgentConfig(['kimi', '--debug'])).toEqual({
      agentName: 'kimi',
      command: '/opt/kimi/bin/kimi',
      args: ['acp', '--debug'],
    });
  });

  it('resolves TraeX to its ACP server subcommand', () => {
    expect(resolveAcpAgentConfig(['traex'])).toEqual({
      agentName: 'traex',
      command: '/opt/traex/bin/traex',
      args: ['acp', 'serve'],
    });
  });

  it('appends extra CLI args for TraeX after acp serve', () => {
    expect(resolveAcpAgentConfig(['traex', '--yolo'])).toEqual({
      agentName: 'traex',
      command: '/opt/traex/bin/traex',
      args: ['acp', 'serve', '--yolo'],
    });
  });

  it('appends extra CLI args for known agent aliases', () => {
    expect(resolveAcpAgentConfig(['opencode', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('strips legacy --acp for opencode compatibility', () => {
    expect(resolveAcpAgentConfig(['opencode', '--acp', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('resolves custom command form with -- separator', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--flag'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--flag'],
    });
  });

  it('treats unknown agent names as direct commands', () => {
    expect(resolveAcpAgentConfig(['my-agent', '--x'])).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--x'],
    });
  });

  it('throws with helpful usage when no args are provided', () => {
    expect(() => resolveAcpAgentConfig([])).toThrow('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  });

  it('throws when separator form omits command', () => {
    expect(() => resolveAcpAgentConfig(['--'])).toThrow('Missing command after "--". Usage: happy acp -- <command> [args]');
  });
});
