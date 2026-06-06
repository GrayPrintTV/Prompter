import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_WHISPER_STATUS, LocalWhisperAsrProvider } from '../asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from '../asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions, isLocalWhisperConfigured } from '../asr/providerRegistry';
import { getActiveAsrTranscriptHistory } from '../components/ControlPanel';
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
  function localWhisperBridge(overrides: Partial<typeof window.prompterApi> = {}) {
    return {
      getBridgeDiagnostics: vi.fn(async () => ({
        electronBridgeAvailable: true,
        localWhisperBridgeAvailable: true,
        ipcHandlersRegistered: true,
        errorMessage: null
      })),
      getLocalWhisperStatus: vi.fn(async () => DEFAULT_LOCAL_WHISPER_STATUS),
      startLocalWhisper: vi.fn(async () => ({
        ...DEFAULT_LOCAL_WHISPER_STATUS,
        sidecarRunning: true,
        modelPhase: 'ready' as const,
        status: 'listening' as const,
        listening: true
      })),
      stopLocalWhisper: vi.fn(async () => ({
        ...DEFAULT_LOCAL_WHISPER_STATUS,
        status: 'stopped' as const
      })),
      transcribeLocalWhisperChunk: vi.fn(async () => ({ text: 'The room did not answer.' })),
      onLocalWhisperStatus: vi.fn(() => () => undefined),
      ...overrides
    };
  }

  function fakeMediaStream(label = 'Studio microphone') {
    const track = {
      label,
      stop: vi.fn(),
      addEventListener: vi.fn()
    };
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
  }

  class FakeMediaRecorder extends EventTarget {
    state: RecordingState = 'inactive';

    start() {
      this.state = 'recording';
      this.dispatchEvent(new Event('start'));
    }

    stop() {
      this.state = 'inactive';
      this.dispatchEvent(new Event('stop'));
    }
  }

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

  it('reports setup failure before requesting microphone access', async () => {
    const bridge = localWhisperBridge({
      startLocalWhisper: vi.fn(async () => {
        throw new Error('Python executable not found.');
      })
    });
    const getUserMedia = vi.fn(async () => fakeMediaStream());
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia
    });

    await expect(provider.start()).rejects.toThrow('Python executable not found.');

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(provider.getConnectionStatus().mic.captureState).toBe('not-requested');
    expect(provider.getConnectionStatus().mic.errorMessage).toContain('Setup failed before microphone request');
    expect(provider.getConnectionStatus().mic.log.join('\n')).toContain('before getUserMedia');
  });

  it('keeps Start Following unavailable when the Electron bridge is absent', async () => {
    const getUserMedia = vi.fn(async () => fakeMediaStream());
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      getUserMedia
    });

    await expect(provider.refreshStatus()).resolves.toMatchObject({
      bridge: {
        electronBridgeAvailable: false,
        localWhisperBridgeAvailable: false
      }
    });
    await expect(provider.start()).rejects.toThrow('Local Whisper bridge unavailable. Are you running inside Electron?');

    const status = provider.getConnectionStatus();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(provider.getStatus()).toBe('idle');
    expect(status.listening).toBe(false);
    expect(status.sidecarRunning).toBe(false);
    expect(status.errorMessage).toBe('Local Whisper bridge unavailable. Are you running inside Electron?');
    expect(status.chunk.chunksRecorded).toBe(0);
    expect(status.chunk.chunksSentToMain).toBe(0);
  });

  it('still allows Mic Monitor when the sidecar bridge is absent', async () => {
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone'))
    });

    await provider.startMicMonitoring();

    const status = provider.getConnectionStatus();
    expect(status.mic.monitorActive).toBe(true);
    expect(status.mic.captureState).toBe('stream-active');
    expect(status.mic.deviceLabel).toBe('Studio microphone');
    expect(status.bridge.localWhisperBridgeAvailable).toBe(false);
    expect(status.chunk.chunksRecorded).toBe(0);
  });

  it('reports permission denial after Local Whisper setup succeeds', async () => {
    const bridge = localWhisperBridge();
    const getUserMedia = vi.fn(async () => {
      const error = new Error('Permission denied');
      error.name = 'NotAllowedError';
      throw error;
    });
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia
    });

    await expect(provider.start()).rejects.toThrow('Permission denied');

    expect(bridge.startLocalWhisper).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(provider.getConnectionStatus().mic.captureState).toBe('permission-denied');
    expect(provider.getConnectionStatus().mic.errorMessage).toBe('Permission denied');
    expect(provider.getConnectionStatus().mic.log.join('\n')).toContain('getUserMedia failure');
  });

  it('tests microphone capture without starting sidecar transcription', async () => {
    const bridge = localWhisperBridge();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone'))
    });

    await provider.testMicrophone();

    expect(bridge.startLocalWhisper).not.toHaveBeenCalled();
    expect(provider.getConnectionStatus().mic.captureState).toBe('stream-active');
    expect(provider.getConnectionStatus().mic.deviceLabel).toBe('Studio microphone');
    expect(provider.getConnectionStatus().mic.monitorActive).toBe(true);
    expect(provider.getConnectionStatus().mic.log.join('\n')).toContain('getUserMedia success');

    await provider.stopMicTest();
    expect(provider.getConnectionStatus().mic.monitorActive).toBe(false);
  });

  it('records chunk send and sidecar response diagnostics', async () => {
    const bridge = localWhisperBridge();
    const recorder = new FakeMediaRecorder();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone')),
      createMediaRecorder: () => recorder as unknown as MediaRecorder,
      now: () => 123
    });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    await provider.start();
    expect(provider.getStatus()).toBe('listening');
    const blob = {
      size: 3,
      type: 'audio/webm',
      arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
    } as unknown as Blob;
    expect(blob.size).toBe(3);
    await provider.acceptRecordedAudioChunk(blob);

    const mic = provider.getConnectionStatus().mic;
    expect(provider.getConnectionStatus().chunk.lastChunkBytes).toBe(3);
    expect(mic.log.join('\n')).not.toContain('Chunk skipped');
    expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalled();
    expect(mic.captureState).toBe('chunk-returned');
    expect(mic.log.join('\n')).toContain('MediaRecorder chunk emitted: 3 bytes.');
    expect(mic.log.join('\n')).toContain('IPC send to main: 3 bytes.');
    expect(mic.log.join('\n')).toContain('Sidecar response received.');
    expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalledWith({
      audioData: expect.any(ArrayBuffer),
      mimeType: 'audio/webm',
      settings: LOCAL_WHISPER_SETTINGS
    });
    expect(deltas.at(-1)?.source).toBe('local-whisper');

    await provider.stop();
  });

  it('records empty Whisper transcripts without emitting an aligner delta', async () => {
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, { now: () => 999 });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    await provider.acceptTranscriptResult({ text: '   ' });

    const status = provider.getConnectionStatus();
    expect(deltas).toEqual([]);
    expect(status.modelPhase).toBe('returned-empty-transcript');
    expect(status.lastTranscriptDelta).toBe('[empty transcript]');
    expect(status.chunk.lastTranscriptText).toBe('[empty transcript]');
    expect(status.transcriptHistory.at(-1)?.displayText).toBe('[empty transcript]');
    expect(status.transcriptHistory.at(-1)?.isEmpty).toBe(true);
  });

  it('warns when a sidecar response does not return before the timeout', async () => {
    vi.useFakeTimers();
    let resolveTranscript!: (result: { text: string }) => void;
    const bridge = localWhisperBridge({
      transcribeLocalWhisperChunk: vi.fn(
        (): Promise<{ text: string }> => new Promise((resolve) => {
          resolveTranscript = resolve;
        })
      )
    });
    const recorder = new FakeMediaRecorder();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone')),
      createMediaRecorder: () => recorder as unknown as MediaRecorder,
      chunkResponseTimeoutMs: 50
    });

    await provider.start();
    const pending = provider.acceptRecordedAudioChunk({
      size: 3,
      type: 'audio/webm',
      arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
    } as unknown as Blob);

    await vi.advanceTimersByTimeAsync(55);
    expect(provider.getConnectionStatus().chunk.warningMessage).toContain('no sidecar response');

    resolveTranscript({ text: 'The room did not answer.' });
    await pending;
    await provider.stop();
    vi.useRealTimers();
  });
});

describe('ASR transcript display helpers', () => {
  it('prefers Local Whisper transcript history so empty returns are visible', () => {
    const localStatus = {
      ...DEFAULT_LOCAL_WHISPER_STATUS,
      transcriptHistory: [
        {
          text: '',
          displayText: '[empty transcript]',
          isEmpty: true,
          isFinal: true,
          timestampMs: 100,
          source: 'local-whisper' as const
        }
      ]
    };

    const history = getActiveAsrTranscriptHistory('local-whisper', [], localStatus);

    expect(history).toHaveLength(1);
    expect(history[0].displayText).toBe('[empty transcript]');
    expect(history[0].isEmpty).toBe(true);
  });
});
