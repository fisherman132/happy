import { describe, expect, it } from 'vitest';
import { SessionSyncGate } from './sessionSyncGate';

describe('SessionSyncGate', () => {
  it('uploads everything while enabled', () => {
    const gate = new SessionSyncGate(true);
    gate.beginTurn('local');
    expect(gate.shouldUpload()).toBe(true);
    gate.beginTurn('remote');
    expect(gate.shouldUpload()).toBe(true);
  });

  it('holds back local turns while disabled but uploads remote turns live', () => {
    const gate = new SessionSyncGate(false);
    gate.beginTurn('local');
    expect(gate.shouldUpload()).toBe(false);
    gate.beginTurn('remote');
    expect(gate.shouldUpload()).toBe(true);
    gate.endTurn();
  });

  it('enable() and disable() flip sync for subsequent turns', () => {
    const gate = new SessionSyncGate(false);
    gate.beginTurn('local');
    expect(gate.shouldUpload()).toBe(false);

    gate.enable();
    expect(gate.isEnabled()).toBe(true);
    expect(gate.shouldUpload()).toBe(true);

    gate.disable();
    expect(gate.shouldUpload()).toBe(false);
  });
});
