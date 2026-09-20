import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

/** Default command name for the Kimi CLI binary (looked up on PATH). */
export const KIMI_BIN = 'kimi';

/**
 * Find the installed Kimi executable.
 *
 * Kimi's installer commonly places the binary under `~/.local/bin`, which is
 * often missing from daemon environments. Prefer an explicit override, then
 * PATH, then that installer default.
 */
export function findKimiBin(): string | undefined {
  const override = process.env.HAPPY_KIMI_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  try {
    const probe = process.platform === 'win32'
      ? `where ${KIMI_BIN}`
      : `command -v ${KIMI_BIN}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return KIMI_BIN;
  } catch {
    // not on PATH; fall through to the known installer location
  }

  const localBin = join(os.homedir(), '.local', 'bin', KIMI_BIN);
  if (existsSync(localBin)) {
    return localBin;
  }

  return undefined;
}

/**
 * Resolve the Kimi executable to a spawnable command.
 *
 * Falls back to the bare command name so launch errors still report a clear
 * ENOENT when Kimi is not installed.
 */
export function resolveKimiBin(): string {
  return findKimiBin() ?? KIMI_BIN;
}
