import type { AsrProvider, AsrStatus, TranscriptDelta } from './AsrProvider';
import type { LiveAsrConfigStatus, LiveAsrConnectionStatus, OpenAiRealtimeClientSession } from '../domain/types';

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
  createOpenAiRealtimeClientSession(): Promise<OpenAiRealtimeClientSession>;
};

type OpenAiRealtimeDeps = {
  bridge?: OpenAiRealtimeBridge;
  fetch?: typeof fetch;
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
      const bridge = this.getBridge();
      const config = await bridge.getOpenAiRealtimeConfigStatus();
      this.setConnectionStatus({ configured: config.configured });
      if (!config.configured) {
        throw new Error('Live OpenAI Realtime is not configured. Set OPENAI_API_KEY outside the renderer.');
      }

      const session = await bridge.createOpenAiRealtimeClientSession();
      const stream = await this.getUserMedia({ audio: true });
      const peerConnection = this.createPeerConnection();
      const dataChannel = peerConnection.createDataChannel('oai-events');

      this.peerConnection = peerConnection;
      this.mediaStream = stream;
      this.dataChannel = dataChannel;

      dataChannel.addEventListener('message', (event) => {
        this.acceptRealtimeEvent(JSON.parse(String(event.data)));
      });
      dataChannel.addEventListener('open', () => {
        this.setConnectionStatus({ connected: true });
      });
      dataChannel.addEventListener('close', () => {
        this.setConnectionStatus({ connected: false });
      });

      peerConnection.addEventListener('connectionstatechange', () => {
        const connected = peerConnection.connectionState === 'connected';
        const failed = peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed';
        this.setConnectionStatus({
          connected,
          errorMessage: failed ? 'OpenAI Realtime WebRTC connection closed or failed.' : this.connectionStatus.errorMessage
        });
      });

      for (const track of stream.getAudioTracks()) {
        peerConnection.addTrack(track, stream);
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await this.fetch(session.webRtcUrl, {
        method: 'POST',
        body: offer.sdp ?? '',
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp'
        }
      });

      if (!sdpResponse.ok) {
        throw new Error(`OpenAI Realtime WebRTC handshake failed with status ${sdpResponse.status}.`);
      }

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: await sdpResponse.text()
      });

      this.setProviderStatus('listening', null);
      this.setConnectionStatus({ connected: true });
    } catch (error) {
      await this.stop();
      this.setProviderStatus('error', error instanceof Error ? error.message : 'OpenAI Realtime failed to start.');
      throw error;
    }
  }

  async stop() {
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

  private getBridge() {
    const bridge = this.deps.bridge ?? window.prompterApi;
    if (!bridge?.getOpenAiRealtimeConfigStatus || !bridge.createOpenAiRealtimeClientSession) {
      throw new Error('OpenAI Realtime bridge is unavailable.');
    }
    return bridge;
  }

  private get fetch() {
    return this.deps.fetch ?? window.fetch.bind(window);
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
