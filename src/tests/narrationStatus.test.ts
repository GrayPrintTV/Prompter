import { describe, expect, it } from 'vitest';
import { deriveNarrationStatus } from '../domain/narrationStatus';

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
    expect(deriveNarrationStatus({ ...BASE, isStarting: true }).label).toBe('Starting');
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
