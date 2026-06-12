import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';
import type { LiveAsrConfigStatus, LiveAsrConnectionStatus, OpenAiRealtimeSdpAnswer } from '../domain/types';

type Listener = (delta: TranscriptDelta) => void;
type StatusListener = (status: LiveAsrConnectionStatus) => void;

type RealtimeEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
};

type OpenAiRealtimeBridge = {
  getOpenAiRealtimeConfigStatus(): Promise<LiveAsrConfigStatus>;
  exchangeOpenAiRealtimeSdp(offerSdp: string): Promise<OpenAiRealtimeSdpAnswer>;
};

type OpenAiRealtimeDeps = {
  bridge?: OpenAiRealtimeBridge;
  createPeerConnection?: () => RTCPeerConnection;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  now?: () => number;
};

const DEFAULT_LIVE_STATUS: LiveAsrConnectionStatus = {
  providerId: 'openai-realtime',
  configured: false,
  connected: false,
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null
};
const REALTIME_TRANSCRIPTION_COMMIT_INTERVAL_MS = 2000;

type RealtimeStartupStep =
  | 'configuration check'
  | 'getUserMedia'
  | 'peer connection creation'
  | 'data channel creation'
  | 'createOffer'
  | 'setLocalDescription'
  | 'IPC SDP exchange'
  | 'setRemoteDescription';

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause
      ? `; cause=${error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : String(error.cause)}`
      : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

function startupError(step: RealtimeStartupStep, error: unknown) {
  return new Error(`OpenAI Realtime step '${step}' failed: ${errorDetails(error)}`);
}

function inspectRendererSdp(value: unknown) {
  const sdp = typeof value === 'string' ? value : '';
  const firstLine = sdp.split(/\r?\n/, 1)[0] ?? '';
  return {
    receivedType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    characterLength: sdp.length,
    startsWithV0: sdp.startsWith('v=0'),
    firstLine: firstLine === 'v=0' ? 'v=0' : firstLine ? '[unexpected]' : '[empty]',
    endsWithLineBreak: /(?:\r\n|\n)$/.test(sdp),
    hasAudioMediaLine: /(?:^|\r?\n)m=audio\s/i.test(sdp)
  };
}

function validateRendererSdpOffer(value: unknown) {
  const diagnostics = inspectRendererSdp(value);
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new Error('empty SDP offer before OpenAI POST.');
  }
  if (!diagnostics.startsWithV0 || !diagnostics.hasAudioMediaLine) {
    throw new Error(
      `malformed SDP offer before OpenAI POST: length=${diagnostics.characterLength}, startsWithV0=${diagnostics.startsWithV0}, audio=${diagnostics.hasAudioMediaLine}.`
    );
  }
  return { sdp: value, diagnostics };
}

export class OpenAiRealtimeAsrProvider implements AsrProvider {
  id = 'openai-realtime';
  label = 'Live OpenAI Realtime';
  private status: AsrStatus = 'idle';
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private connectionStatus: LiveAsrConnectionStatus = { ...DEFAULT_LIVE_STATUS };
  private peerConnection: RTCPeerConnection | null = null;
  private mediaStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private transcriptionCommitInterval: number | null = null;

  constructor(private deps: OpenAiRealtimeDeps = {}) {}

  async refreshConfiguration() {
    const config = await this.getBridge().getOpenAiRealtimeConfigStatus();
    this.setConnectionStatus({
      configured: config.configured,
      errorMessage: config.configured ? null : this.connectionStatus.errorMessage
    });
    return config;
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;

    this.setProviderStatus('starting', null);

    try {
      let bridge: OpenAiRealtimeBridge;
      try {
        bridge = this.getBridge();
      } catch (error) {
        throw startupError('configuration check', error);
      }
      let config: LiveAsrConfigStatus;
      try {
        config = await bridge.getOpenAiRealtimeConfigStatus();
      } catch (error) {
        throw startupError('configuration check', error);
      }
      this.setConnectionStatus({ configured: config.configured });
      if (!config.enabled) {
        throw new Error(
          'Live OpenAI Realtime is experimental and disabled. Set OPENAI_REALTIME_ENABLED=true to enable it.'
        );
      }
      if (!config.configured) {
        throw new Error('Live OpenAI Realtime is not configured. Set OPENAI_API_KEY outside the renderer.');
      }

      let stream: MediaStream;
      try {
        stream = await this.getUserMedia({ audio: true });
      } catch (error) {
        throw startupError('getUserMedia', error);
      }

      let peerConnection: RTCPeerConnection;
      try {
        peerConnection = this.createPeerConnection();
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        throw startupError('peer connection creation', error);
      }

      let dataChannel: RTCDataChannel;
      try {
        dataChannel = peerConnection.createDataChannel('oai-events');
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        peerConnection.close();
        throw startupError('data channel creation', error);
      }

      this.peerConnection = peerConnection;
      this.mediaStream = stream;
      this.dataChannel = dataChannel;

      dataChannel.addEventListener('message', (event) => {
        try {
          this.acceptRealtimeEvent(JSON.parse(String(event.data)));
        } catch (error) {
          this.setProviderStatus(
            'error',
            `OpenAI Realtime step 'transcript event handling' failed: ${errorDetails(error)}`
          );
        }
      });
      dataChannel.addEventListener('open', () => {
        this.setConnectionStatus({ connected: true });
        this.startTranscriptionCommits();
      });
      dataChannel.addEventListener('close', () => {
        this.stopTranscriptionCommits();
        this.setConnectionStatus({ connected: false });
      });
      dataChannel.addEventListener('error', () => {
        this.setProviderStatus('error', "OpenAI Realtime step 'data channel' failed.");
      });

      peerConnection.addEventListener('connectionstatechange', () => {
        const connected = peerConnection.connectionState === 'connected';
        const failed = peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed';
        this.setConnectionStatus({
          connected,
          errorMessage: failed
            ? `OpenAI Realtime step 'peer connection' failed: state=${peerConnection.connectionState}.`
            : this.connectionStatus.errorMessage
        });
      });

      for (const track of stream.getAudioTracks()) {
        peerConnection.addTrack(track, stream);
      }

      let offer: RTCSessionDescriptionInit;
      try {
        offer = await peerConnection.createOffer();
      } catch (error) {
        throw startupError('createOffer', error);
      }

      try {
        await peerConnection.setLocalDescription(offer);
      } catch (error) {
        throw startupError('setLocalDescription', error);
      }

      const localDescription = peerConnection.localDescription;
      const rawOfferSdp = localDescription?.sdp ?? offer.sdp;
      let validatedOffer: ReturnType<typeof validateRendererSdpOffer>;
      try {
        validatedOffer = validateRendererSdpOffer(rawOfferSdp);
      } catch (error) {
        throw startupError('setLocalDescription', error);
      }
      console.info('[OpenAI Realtime] SDP offer ready for IPC', {
        offerType: localDescription?.type ?? offer.type ?? 'unknown',
        source: localDescription?.sdp ? 'peerConnection.localDescription.sdp' : 'createOffer().sdp',
        ...validatedOffer.diagnostics
      });

      let exchange: OpenAiRealtimeSdpAnswer;
      try {
        exchange = await bridge.exchangeOpenAiRealtimeSdp(validatedOffer.sdp);
      } catch (error) {
        throw startupError('IPC SDP exchange', error);
      }

      try {
        await peerConnection.setRemoteDescription({
          type: 'answer',
          sdp: exchange.answerSdp
        });
      } catch (error) {
        throw startupError(
          'setRemoteDescription',
          new Error(`${errorDetails(error)}; endpoint=${exchange.endpointLabel}; model=${exchange.model}`)
        );
      }

      this.setProviderStatus('listening', null);
    } catch (error) {
      await this.stop();
      this.setProviderStatus('error', error instanceof Error ? error.message : 'OpenAI Realtime failed to start.');
      throw error;
    }
  }

  async stop() {
    this.stopTranscriptionCommits();
    this.dataChannel?.close();
    this.dataChannel = null;

    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    this.setProviderStatus('stopped', null);
    this.setConnectionStatus({ connected: false });
  }

  onDelta(callback: Listener) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onConnectionStatus(callback: StatusListener) {
    this.statusListeners.add(callback);
    callback(this.connectionStatus);
    return () => this.statusListeners.delete(callback);
  }

  getStatus() {
    return this.status;
  }

  getConnectionStatus() {
    return this.connectionStatus;
  }

  acceptRealtimeEvent(event: RealtimeEvent) {
    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.delta) {
      this.emit(event.delta, false);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
      this.emit(event.transcript, true);
    } else if (event.type === 'error') {
      this.setProviderStatus('error', event.error?.message ?? 'OpenAI Realtime returned an error.');
    }
  }

  private emit(text: string, isFinal: boolean) {
    const delta: TranscriptDelta = {
      text,
      isFinal,
      timestampMs: this.now(),
      source: 'openai-realtime'
    };

    this.setConnectionStatus({ lastTranscriptDelta: text });
    for (const listener of this.listeners) {
      listener(delta);
    }
  }

  private setProviderStatus(status: AsrStatus, errorMessage: string | null) {
    this.status = status;
    this.setConnectionStatus({
      status,
      listening: status === 'listening' || status === 'starting',
      errorMessage
    });
  }

  private setConnectionStatus(patch: Partial<LiveAsrConnectionStatus>) {
    this.connectionStatus = {
      ...this.connectionStatus,
      ...patch,
      providerId: 'openai-realtime'
    };
    for (const listener of this.statusListeners) {
      listener(this.connectionStatus);
    }
  }

  private startTranscriptionCommits() {
    this.stopTranscriptionCommits();
    this.transcriptionCommitInterval = window.setInterval(() => {
      if (this.dataChannel?.readyState !== 'open') return;
      try {
        this.dataChannel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } catch (error) {
        this.setProviderStatus(
          'error',
          `OpenAI Realtime step 'data channel commit' failed: ${errorDetails(error)}`
        );
      }
    }, REALTIME_TRANSCRIPTION_COMMIT_INTERVAL_MS);
  }

  private stopTranscriptionCommits() {
    if (this.transcriptionCommitInterval !== null) {
      window.clearInterval(this.transcriptionCommitInterval);
      this.transcriptionCommitInterval = null;
    }
  }

  private getBridge() {
    const bridge = this.deps.bridge ?? window.prompterApi;
    if (!bridge?.getOpenAiRealtimeConfigStatus || !bridge.exchangeOpenAiRealtimeSdp) {
      throw new Error('OpenAI Realtime bridge is unavailable.');
    }
    return bridge;
  }

  private getUserMedia(constraints: MediaStreamConstraints) {
    const getUserMedia = this.deps.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      throw new Error('Microphone access is unavailable in this renderer.');
    }
    return getUserMedia(constraints);
  }

  private createPeerConnection() {
    return this.deps.createPeerConnection ? this.deps.createPeerConnection() : new RTCPeerConnection();
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
