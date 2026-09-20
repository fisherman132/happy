import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAgyBin } from '@/agy/constants';
import { findKimiBin } from '@/kimi/constants';
import { findTraexBin } from '@/traex/constants';
import { detectCLIAvailability } from './detectCLI';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/person'),
    platform: vi.fn(() => 'darwin'),
  },
}));
vi.mock('@/agy/constants', () => ({ findAgyBin: vi.fn() }));
vi.mock('@/kimi/constants', () => ({ findKimiBin: vi.fn() }));
vi.mock('@/traex/constants', () => ({ findTraexBin: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedFindAgyBin = vi.mocked(findAgyBin);
const mockedFindKimiBin = vi.mocked(findKimiBin);
const mockedFindTraexBin = vi.mocked(findTraexBin);
const mockedPlatform = vi.mocked(os.platform);

describe('CLI availability detection', () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedFindAgyBin.mockReset();
    mockedFindAgyBin.mockReturnValue(undefined);
    mockedFindKimiBin.mockReset();
    mockedFindKimiBin.mockReturnValue(undefined);
    mockedFindTraexBin.mockReset();
    mockedFindTraexBin.mockReturnValue(undefined);
    mockedPlatform.mockReturnValue('darwin');
  });

  it('reports Antigravity only when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().agy).toBe(false);

    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability().agy).toBe(true);
  });

  it('reports Kimi when the kimi executable is on PATH', () => {
    mockedFindKimiBin.mockReturnValue('kimi');

    expect(detectCLIAvailability().kimi).toBe(true);
  });

  it('reports Kimi on Windows when Get-Command finds it', () => {
    mockedPlatform.mockReturnValue('win32');
    mockedFindKimiBin.mockReturnValue('kimi');

    expect(detectCLIAvailability().kimi).toBe(true);
  });

  it('reports TraeX when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().traex).toBe(false);

    mockedFindTraexBin.mockReturnValue('traex');

    expect(detectCLIAvailability().traex).toBe(true);
  });
});
