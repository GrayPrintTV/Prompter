import { describe, expect, it } from 'vitest';
import { deriveNarrationStatus, isBenignStartDiagnosticMessage } from '../domain/narrationStatus';

const BASE = {
  isRunning: false,
  isStarting: false,
  followState: 'manual' as const,
  confidence: 0,
  expectsMic: false,
  micActive: false,
  inputLevel: 0,
  isLagging: false,
  errorMessage: null,
  warningMessage: null
};

describe('deriveNarrationStatus', () => {
  it('reports idle when no session is running', () => {
    expect(deriveNarrationStatus(BASE).label).toBe('Idle');
  });

  it('reports starting before listening settles', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      isStarting: true,
      expectsMic: true,
      warningMessage: 'Microphone is not active yet'
    });

    expect(status).toEqual({ label: 'Starting', tone: 'idle', warning: null });
  });

  it('reports following only when confidence is high enough', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      followState: 'following',
      confidence: 0.8
    });

    expect(status.label).toBe('Following');
    expect(status.tone).toBe('good');
  });

  it('reports holding for conservative follow states', () => {
    expect(deriveNarrationStatus({ ...BASE, isRunning: true, followState: 'holding' }).label).toBe('Holding');
    expect(deriveNarrationStatus({ ...BASE, isRunning: true, followState: 'lost' }).label).toBe('Holding');
  });

  it('surfaces mic failures while narration is running', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      followState: 'following',
      confidence: 0.9,
      expectsMic: true,
      micActive: false
    });

    expect(status.label).toBe('Error');
    expect(status.warning).toContain('Microphone');
  });

  it('suppresses inferred mic inactivity during the startup grace period', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      followState: 'following',
      confidence: 0.9,
      expectsMic: true,
      micActive: false,
      micStartupGraceActive: true
    });

    expect(status.label).toBe('Following');
    expect(status.tone).toBe('good');
    expect(status.warning).toBeNull();
  });

  it('still surfaces concrete provider failures during the startup grace period', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      isStarting: true,
      expectsMic: true,
      micStartupGraceActive: true,
      errorMessage: 'Microphone permission denied'
    });

    expect(status.label).toBe('Error');
    expect(status.warning).toBe('Microphone permission denied');
  });

  it('reports lagging without hiding the warning text', () => {
    const status = deriveNarrationStatus({
      ...BASE,
      isRunning: true,
      followState: 'following',
      confidence: 0.9,
      isLagging: true,
      warningMessage: 'Queue backing up'
    });

    expect(status.label).toBe('Lagging');
    expect(status.warning).toBe('Queue backing up');
  });
});

describe('start diagnostics', () => {
  it('filters ScriptProcessorNode deprecation chatter from user-facing startup errors', () => {
    expect(isBenignStartDiagnosticMessage('The ScriptProcessorNode is deprecated.')).toBe(true);
    expect(isBenignStartDiagnosticMessage('createScriptProcessor() is deprecated')).toBe(true);
    expect(isBenignStartDiagnosticMessage('Microphone permission denied')).toBe(false);
  });
});
