import type { AsrProviderId, LiveAsrConfigStatus, LocalWhisperSettings } from '../domain/types';

export type AsrProviderOption = {
  id: AsrProviderId;
  label: string;
  enabled: boolean;
  reason?: string;
};

export function isLocalWhisperConfigured(settings: LocalWhisperSettings) {
  return Boolean(settings.pythonExecutablePath.trim() && settings.modelName.trim());
}

export function getAsrProviderOptions(
  liveConfig: LiveAsrConfigStatus,
  localWhisperSettings?: LocalWhisperSettings
): AsrProviderOption[] {
  const localConfigured = localWhisperSettings ? isLocalWhisperConfigured(localWhisperSettings) : true;
  const options: AsrProviderOption[] = [
    { id: 'manual', label: 'Manual', enabled: true },
    { id: 'mock', label: 'Mock', enabled: true },
    {
      id: 'local-whisper',
      label: 'Local Whisper',
      enabled: localConfigured,
      reason: localConfigured ? undefined : 'Set Python executable and Whisper model'
    }
  ];

  if (liveConfig.enabled) {
    options.push({
      id: 'openai-realtime',
      label: 'Live OpenAI Realtime (Experimental)',
      enabled: liveConfig.configured,
      reason: liveConfig.configured ? undefined : 'Set OPENAI_API_KEY in .env.local or the environment'
    });
  }

  return options;
}

export function coerceSelectedProvider(
  requestedProviderId: AsrProviderId | undefined,
  liveConfig: LiveAsrConfigStatus,
  localWhisperSettings?: LocalWhisperSettings
): AsrProviderId {
  const options = getAsrProviderOptions(liveConfig, localWhisperSettings);
  const fallback = options.find((option) => option.id === 'local-whisper' && option.enabled)?.id ?? 'manual';
  if (!requestedProviderId) {
    return fallback;
  }

  const requested = options.find((option) => option.id === requestedProviderId);
  return requested?.enabled ? requested.id : fallback;
}
