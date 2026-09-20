import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Preferred command name for the TraeX CLI binary. */
export const TRAEX_BIN = 'traex';

function commandExists(command: string): boolean {
  try {
    const probe = process.platform === 'win32'
      ? `where ${command}`
      : `command -v ${command}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function commandSupportsAcpServe(command: string): boolean {
  try {
    execSync(`${command} acp serve --help`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an installed TraeX executable.
 *
 * Prefer the modern `traex` command. Some installations still expose the same
 * TraeX CLI as `traecli`, so use that only when its ACP server is available.
 */
export function findTraexBin(): string | undefined {
  const override = process.env.HAPPY_TRAEX_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  if (commandExists(TRAEX_BIN)) {
    return TRAEX_BIN;
  }

  if (commandExists('traecli') && commandSupportsAcpServe('traecli')) {
    return 'traecli';
  }

  return undefined;
}

/**
 * Resolve the TraeX executable to a spawnable command.
 *
 * Falls back to `traex` so launch errors still clearly point at the missing
 * command when neither `traex` nor a compatible `traecli` is installed.
 */
export function resolveTraexBin(): string {
  return findTraexBin() ?? TRAEX_BIN;
}
