export type EndpointStyle = 'auto' | 'deployment' | 'v1';

export interface ExtensionSettings {
  endpoint: string;
  endpointStyle: EndpointStyle;
  deployment: string;
  apiVersion: string;
  apiKey: string;
  language: string;
  maxFileSizeMb: number;
  enablePostProcessing: boolean;
  chatDeployment: string;
  chatApiVersion: string;
  postProcessPrompt: string;
  automateProcess: boolean;
}

export type PipelineStage =
  | 'idle'
  | 'locating'
  | 'reading'
  | 'recording'
  | 'transcribing'
  | 'post-processing'
  | 'done'
  | 'error';

export type AudioCaptureMethod = 'direct-fetch' | 'blob-fetch' | 'capture-stream';

export interface DiscoveredAudioSource {
  id: string;
  kind: 'audio-element' | 'direct-link';
  url: string;
  label: string;
  mimeTypeHint: string | null;
  isPlaying: boolean;
  element?: HTMLMediaElement;
}

export interface CapturedAudioResult {
  blob: Blob;
  filename: string;
  mimeType: string;
  byteLength: number;
  captureMethod: AudioCaptureMethod;
  durationSeconds?: number;
}

export interface TranscribeAudioPayload {
  base64Data: string;
  mimeType: string;
  filename: string;
  byteLength: number;
  captureMethod: AudioCaptureMethod;
  pageUrl: string;
}

export interface TranscriptionSuccessData {
  transcript: string;
  rawTranscript: string;
  postProcessed: boolean;
  transcriptionUrl: string;
  chatUrl?: string;
  deployment: string;
  chatDeployment?: string;
  latencyMs: number;
  estimatedTokens?: number;
  confidence?: number;
}

export type ExtensionErrorCode =
  | 'MISSING_CONFIG'
  | 'INVALID_ENDPOINT'
  | 'FILE_TOO_LARGE'
  | 'NO_AUDIO_FOUND'
  | 'CORS_OR_NETWORK'
  | 'CAPTURE_NOT_SUPPORTED'
  | 'TAINTED_MEDIA'
  | 'TIMEOUT'
  | 'AZURE_HTTP_ERROR'
  | 'UNKNOWN';

export interface SerializedExtensionError {
  code: ExtensionErrorCode;
  message: string;
  httpStatus?: number;
  details?: string;
}

export type ExtensionMessage =
  | {
      type: 'TRANSCRIBE_AUDIO';
      payload: TranscribeAudioPayload;
    }
  | {
      type: 'TEST_AZURE_CONNECTION';
      payload: ExtensionSettings;
    }
  | {
      type: 'OPEN_OPTIONS_PAGE';
    };

export type TranscribeAudioResponse =
  | {
      ok: true;
      data: TranscriptionSuccessData;
    }
  | {
      ok: false;
      error: SerializedExtensionError;
    };

export interface TestConnectionSuccessData {
  transcriptionUrl: string;
  transcriptionLatencyMs: number;
  transcriptionResponsePreview: string;
  chatUrl?: string;
  chatLatencyMs?: number;
  chatResponsePreview?: string;
}

export type TestConnectionResponse =
  | {
      ok: true;
      data: TestConnectionSuccessData;
    }
  | {
      ok: false;
      error: SerializedExtensionError;
    };

export type SimpleActionResponse =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: SerializedExtensionError;
    };
