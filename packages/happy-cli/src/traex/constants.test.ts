import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findTraexBin, resolveTraexBin } from './constants';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

describe('TraeX binary resolution', () => {
  beforeEach(() => {
    delete process.env.HAPPY_TRAEX_PATH;
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
  });

  it('prefers an explicit HAPPY_TRAEX_PATH override', () => {
    process.env.HAPPY_TRAEX_PATH = '/custom/bin/traex';
    mockedExistsSync.mockImplementation((path) => path === '/custom/bin/traex');

    expect(findTraexBin()).toBe('/custom/bin/traex');
  });

  it('uses the modern traex command when it is on PATH', () => {
    mockedExecSync.mockImplementation((command) => {
      if (String(command).includes('command -v traex')) {
        return Buffer.from('/usr/local/bin/traex\n');
      }
      throw new Error('not installed');
    });

    expect(findTraexBin()).toBe('traex');
  });

  it('falls back to traecli only when its ACP server is available', () => {
    mockedExecSync.mockImplementation((command) => {
      const text = String(command);
      if (text.includes('command -v traecli') || text.includes('traecli acp serve --help')) {
        return Buffer.from('');
      }
      throw new Error('not installed');
    });

    expect(findTraexBin()).toBe('traecli');
  });

  it('returns the bare command for launch errors when no install is found', () => {
    expect(resolveTraexBin()).toBe('traex');
  });
});
