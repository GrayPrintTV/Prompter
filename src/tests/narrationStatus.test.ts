import { describe, expect, it } from 'vitest';
import {
  deriveNarrationStatus,
  deriveTranscriptPipelineState,
  isBenignStartDiagnosticMessage
} from '../domain/narrationStatus';

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

  it('reports stalled only for an active non-silent request beyond the soft timeout', () => {
    const activity = {
      activeRequestStartedAtMs: 10_000,
      activeRequestCapturedAtMs: 9_000,
      lastNonSilentCapturedAtMs: 9_000,
      unusableSpeechStartedAtMs: 9_000,
      lastUsableTranscriptCapturedAtMs: 0,
      lastRequestCompletedCaptureAtMs: 0,
      lastRequestWasDelayed: false
    };
    const pipelineState = deriveTranscriptPipelineState(activity, 'following', 25_001);
    const status = deriveNarrationStatus({ ...BASE, isRunning: true, pipelineState });

    expect(pipelineState).toBe('stalled');
    expect(status.label).toBe('Stalled');
  });

  it('does not call ordinary silence stalled', () => {
    const pipelineState = deriveTranscriptPipelineState({
      activeRequestStartedAtMs: 0,
      activeRequestCapturedAtMs: 0,
      lastNonSilentCapturedAtMs: 9_000,
      unusableSpeechStartedAtMs: 5_000,
      lastUsableTranscriptCapturedAtMs: 9_000,
      lastRequestCompletedCaptureAtMs: 9_000,
      lastRequestWasDelayed: false
    }, 'following', 100_000);

    expect(pipelineState).toBe('normal');
  });

  it('reports recovering when delayed usable speech returned but was not yet accepted', () => {
    const activity = {
      activeRequestStartedAtMs: 0,
      activeRequestCapturedAtMs: 0,
      lastNonSilentCapturedAtMs: 12_000,
      unusableSpeechStartedAtMs: 0,
      lastUsableTranscriptCapturedAtMs: 12_000,
      lastRequestCompletedCaptureAtMs: 12_000,
      lastRequestWasDelayed: true
    };

    expect(deriveTranscriptPipelineState(activity, 'holding', 30_000)).toBe('recovering');
    expect(deriveTranscriptPipelineState(activity, 'following', 30_000)).toBe('normal');
  });

  it('reports stalled for continuing non-silent chunks that yield no usable text', () => {
    const pipelineState = deriveTranscriptPipelineState({
      activeRequestStartedAtMs: 0,
      activeRequestCapturedAtMs: 0,
      lastNonSilentCapturedAtMs: 24_000,
      unusableSpeechStartedAtMs: 5_000,
      lastUsableTranscriptCapturedAtMs: 0,
      lastRequestCompletedCaptureAtMs: 24_000,
      lastRequestWasDelayed: false
    }, 'following', 25_000);

    expect(pipelineState).toBe('stalled');
  });
});

describe('start diagnostics', () => {
  it('filters ScriptProcessorNode deprecation chatter from user-facing startup errors', () => {
    expect(isBenignStartDiagnosticMessage('The ScriptProcessorNode is deprecated.')).toBe(true);
    expect(isBenignStartDiagnosticMessage('createScriptProcessor() is deprecated')).toBe(true);
    expect(isBenignStartDiagnosticMessage('Microphone permission denied')).toBe(false);
  });
});
