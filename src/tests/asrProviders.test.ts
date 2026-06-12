import { describe, expect, it, vi } from 'vitest';
import {
  audioHeaderSignature,
  DEFAULT_LOCAL_WHISPER_STATUS,
  encodePcmWav,
  LocalWhisperAsrProvider,
  type LocalWhisperPcmChunk
} from '../asr/LocalWhisperAsrProvider';
import { OpenAiRealtimeAsrProvider } from '../asr/OpenAiRealtimeAsrProvider';
import { coerceSelectedProvider, getAsrProviderOptions, isLocalWhisperConfigured } from '../asr/providerRegistry';
import localWhisperPcmWorkletSource from '../asr/localWhisperPcmWorklet.js?raw';
import { getActiveAsrTranscriptHistory } from '../components/ControlPanel';
import type {
  ElectronBridgeDiagnostics,
  LiveAsrConfigStatus,
  LocalWhisperSettings,
  TranscriptDelta
} from '../domain/types';

const UNCONFIGURED_LIVE: LiveAsrConfigStatus = {
  enabled: false,
  configured: false,
  providerId: 'openai-realtime',
  model: 'gpt-4o-transcribe',
  language: 'en',
  promptConfigured: false
};

const CONFIGURED_LIVE: LiveAsrConfigStatus = {
  ...UNCONFIGURED_LIVE,
  enabled: true,
  configured: true
};

const LOCAL_WHISPER_SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'turbo',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 4
};

const BRIDGE_OK: ElectronBridgeDiagnostics = {
  electronBridgeAvailable: true,
  localWhisperBridgeAvailable: true,
  ipcHandlersRegistered: true,
  errorMessage: null,
  prompterApiType: 'object',
  pingType: 'function',
  pingResult: 'pong',
  appPath: 'C:\\dev\\Prompter',
  cwd: 'C:\\dev\\Prompter',
  mainDirname: 'C:\\dev\\Prompter\\dist-electron',
  preloadPath: 'C:\\dev\\Prompter\\dist-electron\\preload.cjs',
  preloadExists: true,
  isDev: true,
  viteDevServerUrl: 'http://127.0.0.1:5173',
  preloadErrorMessage: null,
  preloadErrorStack: null,
  preloadDiagnosticStarted: true,
  preloadDiagnosticExposed: true,
  preloadDiagnosticErrorMessage: null,
  preloadDiagnosticErrorStack: null
};

describe('ASR provider selection', () => {
  it('shows Manual, Mock, and Local Whisper while Realtime is disabled by default', () => {
    const options = getAsrProviderOptions(UNCONFIGURED_LIVE);
    expect(options.map((option) => option.id)).toEqual(['manual', 'mock', 'local-whisper']);
    expect(coerceSelectedProvider('openai-realtime', UNCONFIGURED_LIVE)).toBe('manual');
  });

  it('shows experimental Realtime only when explicitly enabled', () => {
    const options = getAsrProviderOptions(CONFIGURED_LIVE);
    expect(options.find((option) => option.id === 'openai-realtime')?.enabled).toBe(true);
    expect(options.find((option) => option.id === 'openai-realtime')?.label).toContain('Experimental');
    expect(coerceSelectedProvider('openai-realtime', CONFIGURED_LIVE)).toBe('openai-realtime');
  });

  it('shows enabled-but-unconfigured Realtime as unavailable without hiding normal providers', () => {
    const options = getAsrProviderOptions({
      ...UNCONFIGURED_LIVE,
      enabled: true
    });

    expect(options.map((option) => option.id)).toEqual([
      'manual',
      'mock',
      'local-whisper',
      'openai-realtime'
    ]);
    expect(options.find((option) => option.id === 'openai-realtime')?.enabled).toBe(false);
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
  function realtimeStartupHarness(exchangeError?: Error) {
    const createOfferSdp = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      ''
    ].join('\r\n');
    const localDescriptionSdp = [
      'v=0',
      'o=- 3 4 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=sendrecv',
      ''
    ].join('\r\n');
    const track = { stop: vi.fn() };
    const stream = {
      getAudioTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track])
    } as unknown as MediaStream;
    const dataChannelListeners = new Map<string, EventListener>();
    const dataChannel = {
      readyState: 'open',
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        dataChannelListeners.set(type, listener);
      }),
      send: vi.fn(),
      close: vi.fn()
    } as unknown as RTCDataChannel;
    const peerConnection = {
      connectionState: 'new',
      localDescription: null as RTCSessionDescription | null,
      createDataChannel: vi.fn(() => dataChannel),
      addEventListener: vi.fn(),
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => ({ type: 'offer' as const, sdp: createOfferSdp })),
      setLocalDescription: vi.fn(async () => {
        Object.defineProperty(peerConnection, 'localDescription', {
          value: {
            type: 'offer',
            sdp: localDescriptionSdp,
            toJSON: () => ({ type: 'offer', sdp: localDescriptionSdp })
          },
          configurable: true
        });
      }),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn()
    } as unknown as RTCPeerConnection;
    const bridge = {
      getOpenAiRealtimeConfigStatus: vi.fn(async () => CONFIGURED_LIVE),
      exchangeOpenAiRealtimeSdp: vi.fn(async (_offerSdp: string) => {
        if (exchangeError) throw exchangeError;
        return {
          answerSdp: 'v=0\r\no=openai-answer',
          endpointLabel: 'OpenAI /v1/realtime/calls',
          model: 'gpt-realtime-whisper'
        };
      })
    };
    const provider = new OpenAiRealtimeAsrProvider({
      bridge,
      getUserMedia: vi.fn(async () => stream),
      createPeerConnection: () => peerConnection
    });

    return {
      provider,
      bridge,
      peerConnection,
      dataChannel,
      dataChannelListeners,
      createOfferSdp,
      localDescriptionSdp
    };
  }

  it('does not request microphone access or SDP exchange while the experimental flag is disabled', async () => {
    const getUserMedia = vi.fn();
    const exchangeOpenAiRealtimeSdp = vi.fn();
    const provider = new OpenAiRealtimeAsrProvider({
      bridge: {
        getOpenAiRealtimeConfigStatus: vi.fn(async () => UNCONFIGURED_LIVE),
        exchangeOpenAiRealtimeSdp
      },
      getUserMedia
    });

    await expect(provider.start()).rejects.toThrow('experimental and disabled');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(exchangeOpenAiRealtimeSdp).not.toHaveBeenCalled();
  });

  it('exchanges the browser SDP offer through Electron IPC instead of renderer fetch', async () => {
    const { provider, bridge, peerConnection, createOfferSdp, localDescriptionSdp } = realtimeStartupHarness();

    await provider.start();

    expect(localDescriptionSdp).not.toBe(createOfferSdp);
    expect(localDescriptionSdp.endsWith('\r\n')).toBe(true);
    expect(bridge.exchangeOpenAiRealtimeSdp).toHaveBeenCalledWith(localDescriptionSdp);
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\no=openai-answer'
    });
    expect(provider.getStatus()).toBe('listening');
  });

  it('rejects malformed SDP before calling the Electron OpenAI exchange', async () => {
    const { provider, bridge, peerConnection } = realtimeStartupHarness();
    peerConnection.setLocalDescription = vi.fn(async () => {
      Object.defineProperty(peerConnection, 'localDescription', {
        value: { type: 'offer', sdp: '' },
        configurable: true
      });
    });

    await expect(provider.start()).rejects.toThrow('empty SDP offer before OpenAI POST');
    expect(bridge.exchangeOpenAiRealtimeSdp).not.toHaveBeenCalled();
  });

  it('commits WebRTC audio periodically for gpt-realtime-whisper transcription', async () => {
    vi.useFakeTimers();
    try {
      const { provider, dataChannel, dataChannelListeners } = realtimeStartupHarness();
      await provider.start();

      dataChannelListeners.get('open')?.(new Event('open'));
      await vi.advanceTimersByTimeAsync(2000);

      expect(dataChannel.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'input_audio_buffer.commit' })
      );
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the IPC SDP exchange stage and sanitized main-process HTTP error', async () => {
    const { provider } = realtimeStartupHarness(
      new Error('OpenAI Realtime calls POST failed: 401 Unauthorized. OpenAI authentication failed.')
    );

    await expect(provider.start()).rejects.toThrow(
      "OpenAI Realtime step 'IPC SDP exchange' failed"
    );
    expect(provider.getConnectionStatus().errorMessage).toContain('401 Unauthorized');
    expect(provider.getConnectionStatus().errorMessage).not.toBe('Failed to fetch');
  });

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
  it('accumulates mono worklet input into exact target-sized transferable chunks', () => {
    const postMessage = vi.fn();
    class FakeAudioWorkletProcessor {
      port = { postMessage };
    }
    let Processor!: new (options: { processorOptions: { targetSamples: number } }) => {
      process(inputs: Float32Array[][]): boolean;
    };
    const registerProcessor = vi.fn((_name: string, processorClass: typeof Processor) => {
      Processor = processorClass;
    });
    const loadModule = new Function(
      'AudioWorkletProcessor',
      'sampleRate',
      'registerProcessor',
      localWhisperPcmWorkletSource
    );
    loadModule(FakeAudioWorkletProcessor, 48000, registerProcessor);

    const processor = new Processor({ processorOptions: { targetSamples: 5 } });
    expect(processor.process([[new Float32Array([0.1, 0.2, 0.3])]])).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(processor.process([[new Float32Array([0.4, 0.5, 0.6, 0.7])]])).toBe(true);

    expect(registerProcessor).toHaveBeenCalledWith(
      'local-whisper-pcm-processor',
      expect.any(Function)
    );
    const [message, transfer] = postMessage.mock.calls[0];
    expect(message.type).toBe('chunk');
    expect(Array.from(message.samples)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
      expect.closeTo(0.4),
      expect.closeTo(0.5)
    ]);
    expect(transfer).toEqual([message.samples.buffer]);
  });

  function localWhisperBridge(overrides: Partial<typeof window.prompterApi> = {}) {
    return {
      ping: vi.fn(() => 'pong'),
      getBridgeDiagnostics: vi.fn(async () => BRIDGE_OK),
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

  function wavChunk(sequence = 1): LocalWhisperPcmChunk {
    const samples = new Float32Array(16000);
    const audioData = encodePcmWav(samples, 16000);
    return {
      audioData,
      sampleRate: 16000,
      durationSeconds: 1,
      sequence
    };
  }

  function fakePcmRecorder() {
    let emitChunk!: (chunk: LocalWhisperPcmChunk) => void;
    const recorder = {
      start: vi.fn(),
      stop: vi.fn()
    };
    return {
      recorder,
      create: vi.fn((_stream: MediaStream, options: { onChunk(chunk: LocalWhisperPcmChunk): void; onLog(message: string): void }) => {
        emitChunk = options.onChunk;
        options.onLog('PCM WAV capture armed at 16000 Hz.');
        return recorder;
      }),
      emit: (chunk = wavChunk()) => emitChunk(chunk)
    };
  }

  function fakeAudioWorkletCapture(sampleRate = 1000) {
    const meterSource = {
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const analyser = {
      fftSize: 1024,
      getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(128))
    };
    const meterContext = {
      sampleRate,
      createAnalyser: vi.fn(() => analyser),
      createMediaStreamSource: vi.fn(() => meterSource),
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    } as unknown as AudioContext;

    const captureSource = {
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const muteNode = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const captureContext = {
      sampleRate,
      audioWorklet: {},
      destination: {},
      createMediaStreamSource: vi.fn(() => captureSource),
      createGain: vi.fn(() => muteNode),
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    } as unknown as AudioContext;

    const port = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as (() => void) | null,
      close: vi.fn()
    };
    const workletNode = {
      port,
      onprocessorerror: null as (() => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn()
    } as unknown as AudioWorkletNode;
    const createAudioContext = vi
      .fn<() => AudioContext | null>()
      .mockReturnValueOnce(meterContext)
      .mockReturnValueOnce(captureContext);
    const loadAudioWorkletModule = vi.fn(async () => undefined);
    const createAudioWorkletNode = vi.fn(() => workletNode);

    return {
      meterContext,
      captureContext,
      port,
      workletNode,
      createAudioContext,
      loadAudioWorkletModule,
      createAudioWorkletNode
    };
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

  it('encodes PCM chunks as RIFF/WAVE audio for the sidecar', () => {
    const audioData = encodePcmWav(new Float32Array([0, 0.5, -0.5]), 16000);
    expect(audioHeaderSignature(audioData)).toBe('RIFF/WAVE');
    expect(new DataView(audioData).getUint32(24, true)).toBe(16000);
  });

  it('captures mono PCM through AudioWorklet and preserves WAV diagnostics', async () => {
    const bridge = localWhisperBridge();
    const audio = fakeAudioWorkletCapture();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream()),
      createAudioContext: audio.createAudioContext,
      loadAudioWorkletModule: audio.loadAudioWorkletModule,
      createAudioWorkletNode: audio.createAudioWorkletNode,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn()
    });

    await provider.start();

    expect(audio.loadAudioWorkletModule).toHaveBeenCalledWith(audio.captureContext);
    expect(audio.createAudioWorkletNode).toHaveBeenCalledWith(
      audio.captureContext,
      'local-whisper-pcm-processor',
      { processorOptions: { targetSamples: 4000 } }
    );

    audio.port.onmessage?.({
      data: {
        type: 'chunk',
        samples: new Float32Array(4000).fill(0.2)
      }
    } as MessageEvent<unknown>);

    await vi.waitFor(() => {
      expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalled();
    });
    expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        audioData: expect.any(ArrayBuffer),
        mimeType: 'audio/wav',
        format: 'wav',
        extension: 'wav',
        sampleRate: 1000,
        durationSeconds: 4,
        headerSignature: 'RIFF/WAVE'
      })
    );
    expect(provider.getConnectionStatus().mic.log.join('\n')).toContain(
      'AudioWorklet PCM WAV capture armed'
    );

    await provider.stop();
    expect(audio.port.close).toHaveBeenCalled();
  });

  it('fails clearly when AudioWorklet setup is unavailable', async () => {
    const bridge = localWhisperBridge();
    const audio = fakeAudioWorkletCapture();
    audio.loadAudioWorkletModule.mockRejectedValueOnce(new Error('module load failed'));
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream()),
      createAudioContext: audio.createAudioContext,
      loadAudioWorkletModule: audio.loadAudioWorkletModule,
      createAudioWorkletNode: audio.createAudioWorkletNode,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn()
    });

    await expect(provider.start()).rejects.toThrow(
      'AudioWorklet PCM capture setup failed: module load failed'
    );
    expect(audio.createAudioWorkletNode).not.toHaveBeenCalled();
    expect(provider.getConnectionStatus().errorMessage).toContain('AudioWorklet PCM capture setup failed');
  });

  it('does not treat provider status text as ASR transcript text', async () => {
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, { now: () => 5678 });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    await provider.acceptTranscriptResult({ text: 'Sidecar is running.' });

    expect(deltas).toEqual([]);
    expect(provider.getConnectionStatus().lastTranscriptDelta).toBe('');
    expect(provider.getConnectionStatus().transcriptHistory).toEqual([]);
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

  it('clears stale provider, microphone, and queue errors in the first starting status', async () => {
    const startLocalWhisper = vi
      .fn()
      .mockRejectedValueOnce(new Error('Previous startup failed.'))
      .mockResolvedValue({
        ...DEFAULT_LOCAL_WHISPER_STATUS,
        sidecarRunning: true,
        modelPhase: 'ready' as const,
        status: 'listening' as const,
        listening: true
      });
    const bridge = localWhisperBridge({ startLocalWhisper });
    const pcm = fakePcmRecorder();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream()),
      createPcmChunkRecorder: pcm.create
    });

    await expect(provider.start()).rejects.toThrow('Previous startup failed.');
    const statuses: Array<{
      status: string;
      errorMessage: string | null;
      micError: string | null;
      warningMessage: string | null;
    }> = [];
    const off = provider.onConnectionStatus((status) => {
      statuses.push({
        status: status.status,
        errorMessage: status.errorMessage,
        micError: status.mic.errorMessage,
        warningMessage: status.chunk.warningMessage
      });
    });
    statuses.length = 0;

    await provider.start();

    expect(statuses[0]).toEqual({
      status: 'starting',
      errorMessage: null,
      micError: null,
      warningMessage: null
    });
    off();
    await provider.stop();
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

  it('reports renderer ping and main-process runtime diagnostics when the bridge is healthy', async () => {
    const bridge = localWhisperBridge();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, { bridge });

    const status = await provider.refreshStatus();

    expect(bridge.ping).toHaveBeenCalled();
    expect(status.bridge).toMatchObject({
      electronBridgeAvailable: true,
      localWhisperBridgeAvailable: true,
      ipcHandlersRegistered: true,
      prompterApiType: 'object',
      pingType: 'function',
      pingResult: 'pong',
      appPath: 'C:\\dev\\Prompter',
      preloadExists: true,
      isDev: true,
      viteDevServerUrl: 'http://127.0.0.1:5173'
    });
  });

  it('treats an old preload without ping as an unavailable Local Whisper bridge', async () => {
    const bridge = localWhisperBridge({
      ping: undefined as unknown as () => string
    });
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, { bridge });

    const status = await provider.refreshStatus();

    expect(status.bridge.electronBridgeAvailable).toBe(true);
    expect(status.bridge.prompterApiType).toBe('object');
    expect(status.bridge.pingType).toBe('undefined');
    expect(status.bridge.localWhisperBridgeAvailable).toBe(false);
    await expect(provider.start()).rejects.toThrow('Local Whisper bridge unavailable. Are you running inside Electron?');
  });

  it('surfaces preload exposure diagnostics when prompterApi is missing', async () => {
    const previousApi = window.prompterApi;
    const previousPreloadDiagnostics = window.prompterPreloadDiagnostics;
    Object.defineProperty(window, 'prompterApi', {
      value: undefined,
      configurable: true
    });
    Object.defineProperty(window, 'prompterPreloadDiagnostics', {
      value: {
        getDiagnostics: () => ({
          started: true,
          exposed: false,
          errorMessage: 'contextBridge expose failed',
          errorStack: 'stack trace'
        })
      },
      configurable: true
    });

    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS);
    const status = await provider.refreshStatus();

    expect(status.bridge.electronBridgeAvailable).toBe(false);
    expect(status.bridge.preloadDiagnosticStarted).toBe(true);
    expect(status.bridge.preloadDiagnosticExposed).toBe(false);
    expect(status.bridge.preloadDiagnosticErrorMessage).toBe('contextBridge expose failed');
    expect(status.errorMessage).toBe('contextBridge expose failed');

    Object.defineProperty(window, 'prompterApi', {
      value: previousApi,
      configurable: true
    });
    Object.defineProperty(window, 'prompterPreloadDiagnostics', {
      value: previousPreloadDiagnostics,
      configurable: true
    });
  });

  it('surfaces main-process preload errors when Electron publishes them into the renderer', async () => {
    const previousMainPreloadError = window.__prompterMainPreloadError;
    Object.defineProperty(window, '__prompterMainPreloadError', {
      value: {
        preloadPath: 'C:\\dev\\Prompter\\dist-electron\\preload.cjs',
        message: 'Unable to load preload script',
        stack: 'preload stack'
      },
      configurable: true
    });

    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS);
    const status = await provider.refreshStatus();

    expect(status.bridge.preloadPath).toBe('C:\\dev\\Prompter\\dist-electron\\preload.cjs');
    expect(status.bridge.preloadErrorMessage).toBe('Unable to load preload script');
    expect(status.errorMessage).toBe('Unable to load preload script');

    Object.defineProperty(window, '__prompterMainPreloadError', {
      value: previousMainPreloadError,
      configurable: true
    });
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
    const pcm = fakePcmRecorder();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone')),
      createPcmChunkRecorder: pcm.create,
      now: () => 123
    });
    const deltas: TranscriptDelta[] = [];
    provider.onDelta((delta) => deltas.push(delta));

    await provider.start();
    expect(provider.getStatus()).toBe('listening');
    await provider.acceptPcmAudioChunk(wavChunk());

    const mic = provider.getConnectionStatus().mic;
    expect(provider.getConnectionStatus().chunk.lastChunkBytes).toBeGreaterThan(44);
    expect(provider.getConnectionStatus().chunk.lastChunkFormat).toBe('wav');
    expect(provider.getConnectionStatus().chunk.lastMimeType).toBe('audio/wav');
    expect(provider.getConnectionStatus().chunk.lastFileExtension).toBe('wav');
    expect(provider.getConnectionStatus().chunk.lastHeaderSignature).toBe('RIFF/WAVE');
    expect(provider.getConnectionStatus().chunk.lastSampleRate).toBe(16000);
    expect(provider.getConnectionStatus().chunk.lastChunkDurationSeconds).toBe(1);
    expect(mic.log.join('\n')).not.toContain('Chunk skipped');
    expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalled();
    expect(mic.captureState).toBe('chunk-returned');
    expect(mic.log.join('\n')).toContain('PCM WAV chunk emitted');
    expect(mic.log.join('\n')).toContain('IPC send to main');
    expect(mic.log.join('\n')).toContain('Sidecar response received.');
    expect(bridge.transcribeLocalWhisperChunk).toHaveBeenCalledWith({
      audioData: expect.any(ArrayBuffer),
      mimeType: 'audio/wav',
      format: 'wav',
      extension: 'wav',
      sampleRate: 16000,
      durationSeconds: 1,
      headerSignature: 'RIFF/WAVE',
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
    const pcm = fakePcmRecorder();
    const provider = new LocalWhisperAsrProvider(LOCAL_WHISPER_SETTINGS, {
      bridge,
      getUserMedia: vi.fn(async () => fakeMediaStream('Studio microphone')),
      createPcmChunkRecorder: pcm.create,
      chunkResponseTimeoutMs: 50
    });

    await provider.start();
    const pending = provider.acceptPcmAudioChunk(wavChunk());

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
