import { describe, expect, it } from 'vitest';
import { OpenAiRealtimeAsrProvider } from '../asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions } from '../asr/providerRegistry';
import type { LiveAsrConfigStatus, TranscriptDelta } from '../domain/types';

const UNCONFIGURED_LIVE: LiveAsrConfigStatus = {
  configured: false,
  providerId: 'openai-realtime',
  model: 'gpt-4o-transcribe',
  language: 'en',
  promptConfigured: false
};

const CONFIGURED_LIVE: LiveAsrConfigStatus = {
  ...UNCONFIGURED_LIVE,
  configured: true
};

describe('ASR provider selection', () => {
  it('keeps manual and mock available while disabling live Realtime until configured', () => {
    const options = getAsrProviderOptions(UNCONFIGURED_LIVE);
    expect(options.find((option) => option.id === 'manual')?.enabled).toBe(true);
    expect(options.find((option) => option.id === 'mock')?.enabled).toBe(true);
    expect(options.find((option) => option.id === 'openai-realtime')?.enabled).toBe(false);
    expect(coerceSelectedProvider('openai-realtime', UNCONFIGURED_LIVE)).toBe('manual');
  });

  it('allows selecting live Realtime when configured', () => {
    const options = getAsrProviderOptions(CONFIGURED_LIVE);
    expect(options.find((option) => option.id === 'openai-realtime')?.enabled).toBe(true);
    expect(coerceSelectedProvider('openai-realtime', CONFIGURED_LIVE)).toBe('openai-realtime');
  });
});

describe('OpenAI Realtime ASR provider', () => {
  it('hands transcription events off as normal TranscriptDelta objects', () => {
    const provider = new OpenAiRealtimeAsrProvider({ now: () => 1234 });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    provider.acceptRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'The room'
    });
    provider.acceptRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'The room did not answer.'
    });

    expect(deltas).toEqual([
      {
        text: 'The room',
        isFinal: false,
        timestampMs: 1234,
        source: 'openai-realtime'
      },
      {
        text: 'The room did not answer.',
        isFinal: true,
        timestampMs: 1234,
        source: 'openai-realtime'
      }
    ]);
    expect(provider.getConnectionStatus().lastTranscriptDelta).toBe('The room did not answer.');
  });

  it('records sanitized live-provider errors without throwing away manual or mock providers', () => {
    const provider = new OpenAiRealtimeAsrProvider();
    provider.acceptRealtimeEvent({
      type: 'error',
      error: {
        message: 'Realtime connection failed'
      }
    });

    expect(provider.getStatus()).toBe('error');
    expect(provider.getConnectionStatus().errorMessage).toBe('Realtime connection failed');
  });
});
