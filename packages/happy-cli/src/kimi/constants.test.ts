import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findKimiBin, resolveKimiBin } from './constants';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: () => '/home/person',
  },
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

describe('Kimi binary resolution', () => {
  beforeEach(() => {
    delete process.env.HAPPY_KIMI_PATH;
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
  });

  it('prefers an explicit HAPPY_KIMI_PATH override', () => {
    process.env.HAPPY_KIMI_PATH = '/custom/bin/kimi';
    mockedExistsSync.mockImplementation((path) => path === '/custom/bin/kimi');

    expect(findKimiBin()).toBe('/custom/bin/kimi');
  });

  it('uses the bare command when kimi is already on PATH', () => {
    mockedExecSync.mockReturnValue(Buffer.from('/usr/local/bin/kimi\n'));

    expect(findKimiBin()).toBe('kimi');
  });

  it('falls back to the installer default under ~/.local/bin', () => {
    mockedExistsSync.mockImplementation((path) => path === '/home/person/.local/bin/kimi');

    expect(findKimiBin()).toBe('/home/person/.local/bin/kimi');
  });

  it('returns the bare command for launch errors when no install is found', () => {
    expect(resolveKimiBin()).toBe('kimi');
  });
});
