import type { AsrProviderId, LiveAsrConfigStatus } from '../domain/types';

export type AsrProviderOption = {
  id: AsrProviderId;
  label: string;
  enabled: boolean;
  reason?: string;
};

export function getAsrProviderOptions(liveConfig: LiveAsrConfigStatus): AsrProviderOption[] {
  return [
    { id: 'manual', label: 'Manual', enabled: true },
    { id: 'mock', label: 'Mock', enabled: true },
    {
      id: 'openai-realtime',
      label: 'Live OpenAI Realtime',
      enabled: liveConfig.configured,
      reason: liveConfig.configured ? undefined : 'Set OPENAI_API_KEY in .env.local or the environment'
    }
  ];
}

export function coerceSelectedProvider(
  requestedProviderId: AsrProviderId | undefined,
  liveConfig: LiveAsrConfigStatus
): AsrProviderId {
  const options = getAsrProviderOptions(liveConfig);
  const requested = options.find((option) => option.id === requestedProviderId);
  return requested?.enabled ? requested.id : 'manual';
}
