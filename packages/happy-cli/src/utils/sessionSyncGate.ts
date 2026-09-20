/**
 * Opt-in gate for mirroring terminal-chat turns into the session transcript.
 *
 * With sync disabled (happy <agent> --no-sync), locally-initiated turns — the
 * prompt mirror, agent envelopes, ready/error events — are simply not uploaded,
 * so the phone sees nothing and no trace is kept. Enabling sync via the /sync
 * terminal command only affects subsequent turns. Remote (phone-initiated)
 * turns always upload live regardless of the flag.
 */
export class SessionSyncGate {
  private enabled: boolean;
  private localTurnActive = false;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Tag the next turn by where its prompt came from. */
  beginTurn(origin: 'local' | 'remote'): void {
    this.localTurnActive = origin === 'local';
  }

  endTurn(): void {
    this.localTurnActive = false;
  }

  /** Whether output for the current turn should reach the server. */
  shouldUpload(): boolean {
    return this.enabled || !this.localTurnActive;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }
}
