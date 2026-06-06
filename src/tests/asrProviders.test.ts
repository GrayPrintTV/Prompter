import { describe, expect, it } from 'vitest';
import { LocalWhisperAsrProvider } from '../asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from '../asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions, isLocalWhisperConfigured } from '../asr/providerRegistry';
import type { LiveAsrConfigStatus, LocalWhisperSettings, TranscriptDelta } from '../domain/types';

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

const LOCAL_WHISPER_SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'turbo',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 4
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

  it('registers Local Whisper when Python and model settings are present', () => {
    const options = getAsrProviderOptions(UNCONFIGURED_LIVE, LOCAL_WHISPER_SETTINGS);
    expect(isLocalWhisperConfigured(LOCAL_WHISPER_SETTINGS)).toBe(true);
    expect(options.find((option) => option.id === 'local-whisper')?.enabled).toBe(true);
    expect(coerceSelectedProvider('local-whisper', UNCONFIGURED_LIVE, LOCAL_WHISPER_SETTINGS)).toBe('local-whisper');
  });

  it('falls back to manual when Local Whisper settings are incomplete', () => {
    const settings = { ...LOCAL_WHISPER_SETTINGS, pythonExecutablePath: '' };
    expect(isLocalWhisperConfigured(settings)).toBe(false);
    expect(getAsrProviderOptions(UNCONFIGURED_LIVE, settings).find((option) => option.id === 'local-whisper')?.enabled)
      .toBe(false);
    expect(coerceSelectedProvider('local-whisper', UNCONFIGURED_LIVE, settings)).toBe('manual');
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

describe('Local Whisper ASR provider', () => {
  it('hands sidecar transcript results off as normal TranscriptDelta objects', async () => {
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, { now: () => 5678 });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    await provider.acceptTranscriptResult({ text: 'The room did not answer.' });

    expect(deltas).toEqual([
      {
        text: 'The room did not answer.',
        isFinal: true,
        timestampMs: 5678,
        source: 'local-whisper'
      }
    ]);
    expect(provider.getConnectionStatus().lastTranscriptDelta).toBe('The room did not answer.');
  });
});
