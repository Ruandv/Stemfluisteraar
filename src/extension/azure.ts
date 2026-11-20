import { normalizeEndpoint, validateSettingsForTranscription } from './storage';
import {
  ExtensionErrorCode,
  ExtensionSettings,
  SerializedExtensionError,
  TestConnectionSuccessData,
  TranscriptionSuccessData,
} from './types';

export class AzureClientError extends Error {
  public readonly code: ExtensionErrorCode;
  public readonly httpStatus?: number;
  public readonly details?: string;

  constructor(
    code: ExtensionErrorCode,
    message: string,
    options?: { httpStatus?: number; details?: string }
  ) {
    super(message);
    this.name = 'AzureClientError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
    this.details = options?.details;
  }

  public toSerialized(): SerializedExtensionError {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      details: this.details,
    };
  }
}

interface AzureEndpointResolution {
  url: string;
  mode: 'deployment' | 'v1';
}

/**
 * Supports both Azure OpenAI URL conventions:
 * 1. Deployment-scoped:
 *    {endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={apiVersion}
 * 2. OpenAI-compatible v1:
 *    {endpoint}/openai/v1/audio/transcriptions
 */
export function buildTranscriptionUrl(settings: ExtensionSettings): AzureEndpointResolution {
  const base = normalizeEndpoint(settings.endpoint);
  const deployment = settings.deployment.trim();
  const apiVersion = settings.apiVersion.trim();

  if (settings.endpointStyle === 'v1') {
    return {
      url: `${base}/openai/v1/audio/transcriptions`,
      mode: 'v1',
    };
  }

  if (settings.endpointStyle === 'deployment') {
    const version = apiVersion || '2025-03-01-preview';
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(version)}`,
      mode: 'deployment',
    };
  }

  // 'auto' mode: use v1 when apiVersion is blank or explicitly "v1"; otherwise use deployment-scoped URL
  if (!apiVersion || apiVersion.toLowerCase() === 'v1') {
    return {
      url: `${base}/openai/v1/audio/transcriptions`,
      mode: 'v1',
    };
  }

  return {
    url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`,
    mode: 'deployment',
  };
}

export function buildChatCompletionsUrl(settings: ExtensionSettings): AzureEndpointResolution {
  const base = normalizeEndpoint(settings.endpoint);
  const deployment = settings.chatDeployment.trim();
  const apiVersion = settings.chatApiVersion.trim();

  if (settings.endpointStyle === 'v1') {
    return {
      url: `${base}/openai/v1/chat/completions`,
      mode: 'v1',
    };
  }

  if (settings.endpointStyle === 'deployment') {
    const version = apiVersion || '2024-10-21';
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`,
      mode: 'deployment',
    };
  }

  if (!apiVersion || apiVersion.toLowerCase() === 'v1') {
    return {
      url: `${base}/openai/v1/chat/completions`,
      mode: 'v1',
    };
  }

  return {
    url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
    mode: 'deployment',
  };
}

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

async function parseErrorBody(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status} ${response.statusText}`.trim();
  }

  if (!text) {
    return `HTTP ${response.status} ${response.statusText}`.trim();
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const nestedError = record.error;
      if (typeof nestedError === 'object' && nestedError !== null) {
        const errObj = nestedError as Record<string, unknown>;
        const msg = typeof errObj.message === 'string' ? errObj.message : '';
        const code = typeof errObj.code === 'string' ? errObj.code : '';
        if (msg || code) {
          return [code, msg].filter(Boolean).join(': ');
        }
      }
      if (typeof record.message === 'string') {
        return record.message;
      }
    }
  } catch {
    // Non-JSON response body; fall back to truncated raw text
  }

  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AzureClientError(
        'TIMEOUT',
        `Azure request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AzureClientError(
      'CORS_OR_NETWORK',
      `Network error contacting Azure endpoint: ${message}`,
      { details: `Target URL: ${url}` }
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function estimateTokens(text: string): number {
  // Rough approximation: ~1 token per 4 characters for English/Afrikaans
  return Math.ceil(text.length / 4);
}

function extractTranscriptText(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.text === 'string') {
        return record.text.trim();
      }
      if (typeof record.transcript === 'string') {
        return record.transcript.trim();
      }
    }
  } catch {
    // Some Azure configurations with response_format=text return plain text directly
  }

  return trimmed;
}

function extractTranscriptMetadata(rawBody: string): { text: string; confidence?: number } {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { text: '' };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const text = typeof record.text === 'string' 
        ? record.text.trim()
        : typeof record.transcript === 'string'
        ? record.transcript.trim()
        : '';
      
      // Log the parsed response to debug what fields are available
      if (typeof window !== 'undefined') {
        console.log('Azure response parsed:', record);
      }
      
      // Check for confidence in various possible locations
      let confidence: number | undefined;
      if (typeof record.confidence === 'number') {
        confidence = record.confidence;
      } else if (typeof record.result === 'object' && record.result !== null) {
        const result = record.result as Record<string, unknown>;
        if (typeof result.confidence === 'number') {
          confidence = result.confidence;
        }
      }
      
      return { text, confidence };
    }
  } catch {
    // Some Azure configurations with response_format=text return plain text directly
  }

  return { text: trimmed };
}

function extractChatCompletionText(rawBody: string): string {
  const parsed: unknown = JSON.parse(rawBody);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Chat completion response was not a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Chat completion response contained no choices.');
  }

  const firstChoice = choices[0] as Record<string, unknown>;
  const message = firstChoice.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (typeof part === 'object' && part !== null) {
          const item = part as Record<string, unknown>;
          return typeof item.text === 'string' ? item.text : '';
        }
        return '';
      })
      .filter(Boolean);
    return textParts.join('\n').trim();
  }

  throw new Error('Chat completion choice did not contain text content.');
}

async function postProcessTranscript(
  rawTranscript: string,
  settings: ExtensionSettings,
  timeoutMs = 45_000
): Promise<{ text: string; url: string }> {
  const { url } = buildChatCompletionsUrl(settings);

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': settings.apiKey,
      },
      body: JSON.stringify({
        model: settings.chatDeployment,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: settings.postProcessPrompt,
          },
          {
            role: 'user',
            content: rawTranscript,
          },
        ],
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new AzureClientError(
      'AZURE_HTTP_ERROR',
      `Azure post-processing failed (HTTP ${response.status}): ${detail}`,
      { httpStatus: response.status, details: `URL: ${url}` }
    );
  }

  const bodyText = await response.text();
  try {
    return {
      text: extractChatCompletionText(bodyText),
      url,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new AzureClientError(
      'AZURE_HTTP_ERROR',
      `Unexpected Azure chat completion response: ${msg}`,
      { details: bodyText.slice(0, 400) }
    );
  }
}

export async function transcribeWithAzure(
  audio: { bytes: Uint8Array<ArrayBuffer>; mimeType: string; filename: string },
  settings: ExtensionSettings,
  timeoutMs = 120_000
): Promise<TranscriptionSuccessData> {
  const configError = validateSettingsForTranscription(settings);
  if (configError) {
    throw new AzureClientError('MISSING_CONFIG', configError);
  }

  const maxBytes = settings.maxFileSizeMb * 1024 * 1024;
  if (audio.bytes.byteLength > maxBytes) {
    const actualMb = (audio.bytes.byteLength / (1024 * 1024)).toFixed(2);
    throw new AzureClientError(
      'FILE_TOO_LARGE',
      `Audio payload is ${actualMb} MB, exceeding the configured ${settings.maxFileSizeMb} MB limit.`
    );
  }

  const startedAt = Date.now();
  const { url: transcriptionUrl } = buildTranscriptionUrl(settings);

  const formData = new FormData();
  const audioBlob = new Blob([audio.bytes], { type: audio.mimeType || 'audio/webm' });
  formData.append('file', audioBlob, audio.filename || 'audio.webm');
  formData.append('model', settings.deployment);

  if (settings.language.trim().length > 0) {
    formData.append('language', settings.language.trim());
  }

  const response = await fetchWithTimeout(
    transcriptionUrl,
    {
      method: 'POST',
      headers: {
        'api-key': settings.apiKey,
      },
      body: formData,
    },
    timeoutMs
  );

  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new AzureClientError(
      'AZURE_HTTP_ERROR',
      `Azure transcription failed (HTTP ${response.status}): ${detail}`,
      { httpStatus: response.status, details: `URL: ${transcriptionUrl}` }
    );
  }

  const bodyText = await response.text();
  const { text: rawTranscript, confidence } = extractTranscriptMetadata(bodyText);

  if (!rawTranscript && settings.enablePostProcessing) {
    return {
      transcript: '',
      rawTranscript: '',
      postProcessed: false,
      transcriptionUrl,
      deployment: settings.deployment,
      latencyMs: Date.now() - startedAt,
      estimatedTokens: 0,
      confidence,
    };
  }

  if (settings.enablePostProcessing && settings.chatDeployment.trim().length > 0) {
    const postProcessed = await postProcessTranscript(rawTranscript, settings);
    const tokenCount = estimateTokens(postProcessed.text) + estimateTokens(rawTranscript);
    return {
      transcript: postProcessed.text,
      rawTranscript,
      postProcessed: true,
      transcriptionUrl,
      chatUrl: postProcessed.url,
      deployment: settings.deployment,
      chatDeployment: settings.chatDeployment,
      latencyMs: Date.now() - startedAt,
      estimatedTokens: tokenCount,
      confidence,
    };
  }

  return {
    transcript: rawTranscript,
    rawTranscript,
    postProcessed: false,
    transcriptionUrl,
    deployment: settings.deployment,
    latencyMs: Date.now() - startedAt,
    estimatedTokens: estimateTokens(rawTranscript),
    confidence,
  };
}

/**
 * Generates a valid minimal 16 kHz mono 16-bit PCM WAV buffer of silence
 * for live connection verification against Azure transcription deployments.
 */
export function createSilentWavBytes(durationSeconds = 0.5): Uint8Array<ArrayBuffer> {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(1600, Math.round(sampleRate * durationSeconds));
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

export async function testAzureConnection(
  settings: ExtensionSettings
): Promise<TestConnectionSuccessData> {
  const configError = validateSettingsForTranscription(settings);
  if (configError) {
    throw new AzureClientError('MISSING_CONFIG', configError);
  }

  const silentWav = createSilentWavBytes(0.5);
  const transcriptionStart = Date.now();
  const { url: transcriptionUrl } = buildTranscriptionUrl(settings);

  const formData = new FormData();
  formData.append('file', new Blob([silentWav], { type: 'audio/wav' }), 'connection-test.wav');
  formData.append('model', settings.deployment);

  const txResponse = await fetchWithTimeout(
    transcriptionUrl,
    {
      method: 'POST',
      headers: {
        'api-key': settings.apiKey,
      },
      body: formData,
    },
    25_000
  );

  if (!txResponse.ok) {
    const detail = await parseErrorBody(txResponse);
    throw new AzureClientError(
      'AZURE_HTTP_ERROR',
      `Transcription endpoint check failed (HTTP ${txResponse.status}): ${detail}`,
      { httpStatus: txResponse.status, details: `URL: ${transcriptionUrl}` }
    );
  }

  const txBody = await txResponse.text();
  const txText = extractTranscriptText(txBody);
  const transcriptionLatencyMs = Date.now() - transcriptionStart;

  const result: TestConnectionSuccessData = {
    transcriptionUrl,
    transcriptionLatencyMs,
    transcriptionResponsePreview: txText || '(empty transcript on silent 0.5s WAV — endpoint OK)',
  };

  if (settings.enablePostProcessing && settings.chatDeployment.trim().length > 0) {
    const chatStart = Date.now();
    const { url: chatUrl } = buildChatCompletionsUrl(settings);
    const chatResponse = await fetchWithTimeout(
      chatUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': settings.apiKey,
        },
        body: JSON.stringify({
          model: settings.chatDeployment,
          max_tokens: 16,
          messages: [
            { role: 'user', content: 'Reply with OK.' },
          ],
        }),
      },
      20_000
    );

    if (!chatResponse.ok) {
      const detail = await parseErrorBody(chatResponse);
      throw new AzureClientError(
        'AZURE_HTTP_ERROR',
        `Transcription succeeded, but chat deployment check failed (HTTP ${chatResponse.status}): ${detail}`,
        { httpStatus: chatResponse.status, details: `URL: ${chatUrl}` }
      );
    }

    const chatBody = await chatResponse.text();
    result.chatUrl = chatUrl;
    result.chatLatencyMs = Date.now() - chatStart;
    result.chatResponsePreview = extractChatCompletionText(chatBody) || 'OK';
  }

  return result;
}
