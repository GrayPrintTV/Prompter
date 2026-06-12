import { describe, expect, it } from 'vitest';
import {
  buildOpenAiRealtimeTranscriptionSession,
  inspectOpenAiRealtimeSdpOffer,
  isOpenAiRealtimeFlagEnabled,
  supportsRealtimeTranscriptionPrompt,
  validateOpenAiRealtimeSdpOffer
} from '../../electron/openAiRealtimeSession';

describe('OpenAI Realtime experimental flag', () => {
  it('enables Realtime only for an explicit true value', () => {
    expect(isOpenAiRealtimeFlagEnabled('true')).toBe(true);
    expect(isOpenAiRealtimeFlagEnabled(' TRUE ')).toBe(true);
    expect(isOpenAiRealtimeFlagEnabled(undefined)).toBe(false);
    expect(isOpenAiRealtimeFlagEnabled('')).toBe(false);
    expect(isOpenAiRealtimeFlagEnabled('1')).toBe(false);
    expect(isOpenAiRealtimeFlagEnabled('false')).toBe(false);
  });
});

describe('OpenAI Realtime transcription session config', () => {
  it('omits an empty prompt entirely', () => {
    const { session, diagnostics } = buildOpenAiRealtimeTranscriptionSession({
      transcriptionModel: 'gpt-realtime-whisper',
      language: 'en',
      prompt: '   '
    });

    expect(session.audio.input.transcription).toEqual({
      model: 'gpt-realtime-whisper',
      language: 'en'
    });
    expect(session.audio.input.transcription).not.toHaveProperty('prompt');
    expect(session.audio.input.turn_detection).toBeNull();
    expect(diagnostics).toMatchObject({
      promptConfigured: false,
      promptIncluded: false,
      promptOmissionReason: 'not configured',
      instructionsIncluded: false,
      turnDetection: null
    });
  });

  it('omits a configured prompt when the selected model does not support it', () => {
    const { session, diagnostics } = buildOpenAiRealtimeTranscriptionSession({
      transcriptionModel: 'gpt-realtime-whisper',
      language: 'en',
      prompt: 'Narration vocabulary'
    });

    expect(session.audio.input.transcription).not.toHaveProperty('prompt');
    expect(diagnostics).toMatchObject({
      promptConfigured: true,
      promptSupported: false,
      promptIncluded: false,
      promptOmissionReason: 'unsupported model'
    });
    expect(JSON.stringify(diagnostics)).not.toContain('Narration vocabulary');
  });

  it('includes a non-empty prompt for a documented prompt-capable model', () => {
    const { session, diagnostics } = buildOpenAiRealtimeTranscriptionSession({
      transcriptionModel: 'gpt-4o-transcribe',
      language: 'en',
      prompt: '  Atticus, audiobook narration  '
    });

    expect(session.audio.input.transcription.prompt).toBe('Atticus, audiobook narration');
    expect(session.audio.input.turn_detection).toMatchObject({ type: 'server_vad' });
    expect(diagnostics).toMatchObject({
      promptConfigured: true,
      promptSupported: true,
      promptIncluded: true,
      promptOmissionReason: null,
      turnDetection: 'server_vad'
    });
    expect(JSON.stringify(diagnostics)).not.toContain('Atticus');
  });

  it('uses a conservative exact-model allowlist for transcription prompts', () => {
    expect(supportsRealtimeTranscriptionPrompt('whisper-1')).toBe(true);
    expect(supportsRealtimeTranscriptionPrompt('gpt-4o-mini-transcribe')).toBe(true);
    expect(supportsRealtimeTranscriptionPrompt('gpt-4o-mini-transcribe-2025-12-15')).toBe(true);
    expect(supportsRealtimeTranscriptionPrompt('gpt-4o-transcribe')).toBe(true);
    expect(supportsRealtimeTranscriptionPrompt('gpt-4o-transcribe-diarize')).toBe(false);
    expect(supportsRealtimeTranscriptionPrompt('gpt-realtime-whisper')).toBe(false);
    expect(supportsRealtimeTranscriptionPrompt('future-transcription-model')).toBe(false);
  });
});

describe('OpenAI Realtime SDP validation', () => {
  const validSdp = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    ''
  ].join('\r\n');

  it('preserves the exact raw SDP string including its terminal CRLF', () => {
    const result = validateOpenAiRealtimeSdpOffer(validSdp);

    expect(result.sdp).toBe(validSdp);
    expect(result.sdp.endsWith('\r\n')).toBe(true);
    expect(result.diagnostics).toMatchObject({
      receivedType: 'string',
      startsWithV0: true,
      firstLine: 'v=0',
      endsWithLineBreak: true,
      hasOriginLine: true,
      hasTimingLine: true,
      hasAudioMediaLine: true
    });
  });

  it('rejects empty and object-shaped SDP before an OpenAI POST', () => {
    expect(() => validateOpenAiRealtimeSdpOffer('')).toThrow('empty SDP offer before OpenAI POST');
    expect(() => validateOpenAiRealtimeSdpOffer({ sdp: validSdp })).toThrow(
      'empty SDP offer before OpenAI POST'
    );
    expect(inspectOpenAiRealtimeSdpOffer({ sdp: validSdp }).receivedType).toBe('object');
  });

  it('rejects non-SDP text even when it is non-empty', () => {
    expect(() => validateOpenAiRealtimeSdpOffer('[object Object]')).toThrow(
      'malformed SDP offer before OpenAI POST'
    );
  });
});
