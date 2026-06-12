export type OpenAiRealtimeSessionConfig = {
  transcriptionModel: string;
  language: string;
  prompt?: string;
};

type ServerVadConfig = {
  type: 'server_vad';
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
};

export type OpenAiRealtimeTranscriptionSession = {
  type: 'transcription';
  audio: {
    input: {
      noise_reduction: { type: 'near_field' };
      transcription: {
        model: string;
        language: string;
        prompt?: string;
      };
      turn_detection: ServerVadConfig | null;
    };
  };
};

export type SafeOpenAiRealtimeSessionDiagnostics = {
  sessionType: 'transcription';
  transcriptionModel: string;
  language: string;
  promptConfigured: boolean;
  promptSupported: boolean;
  promptIncluded: boolean;
  promptOmissionReason: 'not configured' | 'unsupported model' | null;
  instructionsIncluded: false;
  turnDetection: 'server_vad' | null;
};

export type SafeOpenAiRealtimeSdpDiagnostics = {
  receivedType: string;
  characterLength: number;
  startsWithV0: boolean;
  firstLine: 'v=0' | '[empty]' | '[unexpected]';
  endsWithLineBreak: boolean;
  hasOriginLine: boolean;
  hasTimingLine: boolean;
  hasAudioMediaLine: boolean;
};

const PROMPT_SUPPORTED_TRANSCRIPTION_MODELS = new Set([
  'whisper-1',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe'
]);

export function isOpenAiRealtimeFlagEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function supportsRealtimeTranscriptionPrompt(model: string) {
  return PROMPT_SUPPORTED_TRANSCRIPTION_MODELS.has(model.trim());
}

export function inspectOpenAiRealtimeSdpOffer(value: unknown): SafeOpenAiRealtimeSdpDiagnostics {
  const receivedType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const sdp = typeof value === 'string' ? value : '';
  const firstLineValue = sdp.split(/\r?\n/, 1)[0] ?? '';

  return {
    receivedType,
    characterLength: sdp.length,
    startsWithV0: sdp.startsWith('v=0'),
    firstLine: firstLineValue === 'v=0' ? 'v=0' : firstLineValue ? '[unexpected]' : '[empty]',
    endsWithLineBreak: /(?:\r\n|\n)$/.test(sdp),
    hasOriginLine: /(?:^|\r?\n)o=/.test(sdp),
    hasTimingLine: /(?:^|\r?\n)t=/.test(sdp),
    hasAudioMediaLine: /(?:^|\r?\n)m=audio\s/i.test(sdp)
  };
}

export function validateOpenAiRealtimeSdpOffer(value: unknown) {
  const diagnostics = inspectOpenAiRealtimeSdpOffer(value);
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new Error('empty SDP offer before OpenAI POST.');
  }
  if (
    !diagnostics.startsWithV0 ||
    !diagnostics.hasOriginLine ||
    !diagnostics.hasTimingLine ||
    !diagnostics.hasAudioMediaLine
  ) {
    throw new Error(
      `malformed SDP offer before OpenAI POST: length=${diagnostics.characterLength}, startsWithV0=${diagnostics.startsWithV0}, origin=${diagnostics.hasOriginLine}, timing=${diagnostics.hasTimingLine}, audio=${diagnostics.hasAudioMediaLine}.`
    );
  }
  return { sdp: value, diagnostics };
}

export function buildOpenAiRealtimeTranscriptionSession(config: OpenAiRealtimeSessionConfig) {
  const transcriptionModel = config.transcriptionModel.trim();
  const language = config.language.trim();
  const prompt = config.prompt?.trim();
  const promptConfigured = Boolean(prompt);
  const promptSupported = supportsRealtimeTranscriptionPrompt(transcriptionModel);
  const promptIncluded = promptConfigured && promptSupported;
  const usesRealtimeWhisper = transcriptionModel === 'gpt-realtime-whisper';

  const transcription: OpenAiRealtimeTranscriptionSession['audio']['input']['transcription'] = {
    model: transcriptionModel,
    language
  };
  if (promptIncluded) {
    transcription.prompt = prompt;
  }

  const session: OpenAiRealtimeTranscriptionSession = {
    type: 'transcription',
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription,
        turn_detection: usesRealtimeWhisper
          ? null
          : {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            }
      }
    }
  };

  const diagnostics: SafeOpenAiRealtimeSessionDiagnostics = {
    sessionType: 'transcription',
    transcriptionModel,
    language,
    promptConfigured,
    promptSupported,
    promptIncluded,
    promptOmissionReason: promptIncluded
      ? null
      : promptConfigured
        ? 'unsupported model'
        : 'not configured',
    instructionsIncluded: false,
    turnDetection: usesRealtimeWhisper ? null : 'server_vad'
  };

  return { session, diagnostics };
}
