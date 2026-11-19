import { EndpointStyle, ExtensionSettings } from './types';

export const SETTINGS_STORAGE_KEY = 'azureAudioTranscriberSettings';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  endpoint: 'https://[azure_INSTANCE].openai.azure.com',
  endpointStyle: 'auto',
  deployment: 'gpt-transcribe',
  apiVersion: '2025-03-01-preview',
  apiKey: '',
  language: '',
  maxFileSizeMb: 25,
  enablePostProcessing: false,
  chatDeployment: '',
  chatApiVersion: '2024-10-21',
  postProcessPrompt:
    'Clean up punctuation, fix obvious speech-to-text errors, and organize the transcript into readable paragraphs without changing the meaning.',
};

export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  // Strip accidental trailing API paths if pasted directly from Azure Portal / Foundry
  return trimmed
    .replace(/\/openai\/v1\/audio\/transcriptions$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '')
    .replace(/\/+$/, '');
}

function isEndpointStyle(value: unknown): value is EndpointStyle {
  return value === 'auto' || value === 'deployment' || value === 'v1';
}

export function sanitizeSettings(raw: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  const maxFileSizeMb =
    typeof raw?.maxFileSizeMb === 'number' && Number.isFinite(raw.maxFileSizeMb) && raw.maxFileSizeMb > 0
      ? Math.min(200, Math.max(1, raw.maxFileSizeMb))
      : DEFAULT_SETTINGS.maxFileSizeMb;

  return {
    endpoint:
      typeof raw?.endpoint === 'string' && raw.endpoint.trim().length > 0
        ? normalizeEndpoint(raw.endpoint)
        : DEFAULT_SETTINGS.endpoint,
    endpointStyle: isEndpointStyle(raw?.endpointStyle)
      ? raw.endpointStyle
      : DEFAULT_SETTINGS.endpointStyle,
    deployment:
      typeof raw?.deployment === 'string'
        ? raw.deployment.trim()
        : DEFAULT_SETTINGS.deployment,
    apiVersion:
      typeof raw?.apiVersion === 'string'
        ? raw.apiVersion.trim()
        : DEFAULT_SETTINGS.apiVersion,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '',
    language: typeof raw?.language === 'string' ? raw.language.trim() : '',
    maxFileSizeMb,
    enablePostProcessing: Boolean(raw?.enablePostProcessing),
    chatDeployment:
      typeof raw?.chatDeployment === 'string' ? raw.chatDeployment.trim() : '',
    chatApiVersion:
      typeof raw?.chatApiVersion === 'string' && raw.chatApiVersion.trim().length > 0
        ? raw.chatApiVersion.trim()
        : DEFAULT_SETTINGS.chatApiVersion,
    postProcessPrompt:
      typeof raw?.postProcessPrompt === 'string' && raw.postProcessPrompt.trim().length > 0
        ? raw.postProcessPrompt.trim()
        : DEFAULT_SETTINGS.postProcessPrompt,
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const raw = stored[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return sanitizeSettings(raw);
}

export async function saveSettings(
  next: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const merged = sanitizeSettings({ ...current, ...next });
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
  return merged;
}

export function validateSettingsForTranscription(settings: ExtensionSettings): string | null {
  if (!settings.endpoint) {
    return 'Azure OpenAI endpoint URL is missing. Open extension settings to configure it.';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(settings.endpoint);
  } catch {
    return `Azure endpoint "${settings.endpoint}" is not a valid URL.`;
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return 'Azure endpoint must use https:// (or http:// for local proxies).';
  }

  if (!settings.deployment) {
    return 'Transcription model or deployment name is missing (e.g., gpt-4o-transcribe or whisper).';
  }

  if (!settings.apiKey) {
    return 'Azure API key is missing. Open extension settings and add your Azure OpenAI / Foundry API key.';
  }

  if (settings.enablePostProcessing && !settings.chatDeployment) {
    return 'Post-processing is enabled, but the chat/LLM deployment name is empty.';
  }

  return null;
}
