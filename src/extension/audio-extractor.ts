import {
  AudioCaptureMethod,
  CapturedAudioResult,
  DiscoveredAudioSource,
  ExtensionErrorCode,
} from './types';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac'] as const;

const EXTENSION_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

const MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

interface CapturableMediaElement extends HTMLMediaElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

export class AudioExtractionError extends Error {
  public readonly code: ExtensionErrorCode;
  public readonly details?: string;

  constructor(code: ExtensionErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'AudioExtractionError';
    this.code = code;
    this.details = details;
  }
}

function resolveAbsoluteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed, window.location.href).href;
  } catch {
    return null;
  }
}

function getExtensionFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    const pathname = parsed.pathname.toLowerCase();
    for (const ext of AUDIO_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        return ext.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function formatSourceLabel(url: string, fallback: string): string {
  if (url.startsWith('blob:')) {
    return `${fallback} (Blob / Stream)`;
  }
  if (url.startsWith('data:')) {
    return `${fallback} (Embedded Data URI)`;
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return fallback;
  }
}

/**
 * Recursively collects elements matching `selector`, descending into any open
 * shadow roots along the way. Many custom player components (e.g. praat.ai's
 * waveform player) render their internal <audio> element inside an open shadow
 * root for style encapsulation, which `document.querySelectorAll()` alone can
 * never reach since it does not pierce shadow boundaries. Shadow-root access
 * via the open-mode `.shadowRoot` property is plain DOM state (not a JS object
 * belonging to the page's own script), so it is fully readable here regardless
 * of content-script world isolation. Closed-mode shadow roots remain opaque to
 * any outside caller, including this scanner, by design.
 */
function collectDeep<T extends Element>(root: ParentNode, selector: string): T[] {
  const found: T[] = Array.from(root.querySelectorAll<T>(selector));
  const allDescendants = Array.from(root.querySelectorAll('*'));
  for (const el of allDescendants) {
    if (el.shadowRoot) {
      found.push(...collectDeep<T>(el.shadowRoot, selector));
    }
  }
  return found;
}

/**
 * Scans the DOM (including open shadow roots) for playable <audio> elements
 * (active/playing first) and direct downloadable links to supported audio
 * formats (.mp3, .wav, .m4a, .ogg, .webm, .flac).
 */
export function discoverAudioSources(root: ParentNode = document): DiscoveredAudioSource[] {
  const results: DiscoveredAudioSource[] = [];
  const seenKeys = new Set<string>();

  const audioElements = collectDeep<HTMLAudioElement>(root, 'audio');
  const sortedAudio = audioElements.sort((a, b) => {
    const aPlaying = !a.paused && !a.ended && a.readyState >= 2 ? 1 : 0;
    const bPlaying = !b.paused && !b.ended && b.readyState >= 2 ? 1 : 0;
    return bPlaying - aPlaying;
  });

  sortedAudio.forEach((audioEl, idx) => {
    const sourceChild = audioEl.querySelector('source');
    const rawUrl =
      audioEl.currentSrc ||
      audioEl.getAttribute('src') ||
      sourceChild?.getAttribute('src') ||
      '';

    const resolved = resolveAbsoluteUrl(rawUrl);
    if (!resolved) {
      return;
    }

    const dedupeKey = `el:${resolved}`;
    if (seenKeys.has(dedupeKey)) {
      return;
    }
    seenKeys.add(dedupeKey);

    const isPlaying = !audioEl.paused && !audioEl.ended;
    const labelPrefix = isPlaying ? 'Playing Audio' : `Audio Player ${idx + 1}`;
    const mimeHint =
      sourceChild?.getAttribute('type') ||
      (getExtensionFromUrl(resolved) ? EXTENSION_TO_MIME[getExtensionFromUrl(resolved)!] : null);

    results.push({
      id: `audio-el-${idx}`,
      kind: 'audio-element',
      url: resolved,
      label: formatSourceLabel(resolved, labelPrefix),
      mimeTypeHint: mimeHint ?? null,
      isPlaying,
      element: audioEl,
    });
  });

  const linkCandidates = collectDeep<HTMLAnchorElement | HTMLSourceElement>(
    root,
    'a[href], source[src]'
  );

  linkCandidates.forEach((node, idx) => {
    const rawHref =
      node instanceof HTMLAnchorElement
        ? node.getAttribute('href')
        : node.getAttribute('src');
    if (!rawHref) {
      return;
    }

    const resolved = resolveAbsoluteUrl(rawHref);
    if (!resolved) {
      return;
    }

    const ext = getExtensionFromUrl(resolved);
    if (!ext) {
      return;
    }

    const dedupeKey = `link:${resolved}`;
    if (seenKeys.has(dedupeKey) || seenKeys.has(`el:${resolved}`)) {
      return;
    }
    seenKeys.add(dedupeKey);

    const anchorText =
      node instanceof HTMLAnchorElement ? node.textContent?.trim() : '';

    results.push({
      id: `audio-link-${idx}`,
      kind: 'direct-link',
      url: resolved,
      label: anchorText || formatSourceLabel(resolved, `Audio Link (.${ext})`),
      mimeTypeHint: EXTENSION_TO_MIME[ext] ?? null,
      isPlaying: false,
    });
  });

  return results;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      return utf8Match[1].trim();
    }
  }
  const simpleMatch = /filename="?([^";]+)"?/i.exec(header);
  return simpleMatch?.[1]?.trim() ?? null;
}

/**
 * Identifies the real audio container format from its file-signature ("magic
 * number") bytes. Needed because many sources (e.g. blob: URLs created by
 * custom players) report a generic `application/octet-stream` content-type
 * and have no file extension in their URL, which previously made
 * inferMimeAndFilename fall back to a hardcoded guess (audio/mpeg) regardless
 * of the file's actual encoding — sending mismatched bytes/mimeType to Azure's
 * transcription endpoint reliably fails with "corrupted or unsupported".
 */
function sniffAudioMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 4) {
    return null;
  }
  // WAV: "RIFF"....<size>...."WAVE"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return 'audio/wav';
  }
  // OGG: "OggS"
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'audio/ogg';
  }
  // FLAC: "fLaC"
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return 'audio/flac';
  }
  // MP4/M4A: ISO base media "ftyp" box at byte offset 4
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'audio/mp4';
  }
  // WebM/Matroska: EBML header
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  // MP3: "ID3" tag, or a raw MPEG frame sync (11 set bits: 0xFF followed by 0xE0-0xFF)
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg';
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  return null;
}

export function inferMimeAndFilename(
  url: string,
  contentTypeHeader: string | null,
  contentDisposition: string | null,
  blobType: string,
  mimeHint: string | null,
  headerBytes: Uint8Array | null = null
): { mimeType: string; filename: string } {
  const cleanHeaderMime = contentTypeHeader?.split(';')[0]?.trim().toLowerCase() ?? '';
  const cleanBlobMime = blobType.split(';')[0]?.trim().toLowerCase() ?? '';
  const urlExt = getExtensionFromUrl(url);
  const urlMime = urlExt ? EXTENSION_TO_MIME[urlExt] ?? '' : '';
  const sniffedMime = headerBytes ? sniffAudioMimeFromBytes(headerBytes) : null;

  const mimeType =
    (cleanHeaderMime.startsWith('audio/') || cleanHeaderMime === 'video/webm'
      ? cleanHeaderMime
      : '') ||
    (cleanBlobMime.startsWith('audio/') || cleanBlobMime === 'video/webm'
      ? cleanBlobMime
      : '') ||
    sniffedMime ||
    urlMime ||
    mimeHint ||
    'audio/mpeg';

  const ext = MIME_TO_EXTENSION[mimeType] || urlExt || 'webm';

  let filename = parseContentDispositionFilename(contentDisposition);
  if (!filename && !url.startsWith('blob:') && !url.startsWith('data:')) {
    try {
      const parsed = new URL(url);
      const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
      if (lastSegment) {
        filename = decodeURIComponent(lastSegment);
      }
    } catch {
      // Ignore malformed URL path
    }
  }

  if (!filename) {
    filename = `captured-audio-${Date.now()}.${ext}`;
  } else if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
    filename = `${filename}.${ext}`;
  }

  return { mimeType, filename };
}

function selectRecorderMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

export interface StreamCaptureOptions {
  maxBytes: number;
  maxDurationSeconds?: number;
  stopSignal: AbortSignal;
  onProgress?: (elapsedSeconds: number, collectedBytes: number) => void;
}

/**
 * Fallback capture using HTMLMediaElement.captureStream() + MediaRecorder.
 * Used when audio is backed by MediaSource (MSE) or when direct fetch() fails due to CORS/auth/streaming.
 */
export async function captureMediaElementStream(
  element: HTMLMediaElement,
  options: StreamCaptureOptions
): Promise<CapturedAudioResult> {
  const capturable = element as CapturableMediaElement;
  const captureFn = capturable.captureStream ?? capturable.mozCaptureStream;

  if (typeof captureFn !== 'function' || typeof MediaRecorder === 'undefined') {
    throw new AudioExtractionError(
      'CAPTURE_NOT_SUPPORTED',
      'This browser does not support HTMLMediaElement.captureStream() + MediaRecorder for stream capture.'
    );
  }

  let stream: MediaStream;
  try {
    stream = captureFn.call(capturable);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      throw new AudioExtractionError(
        'TAINTED_MEDIA',
        'Cannot capture cross-origin audio stream because the media element lacks CORS permission (crossorigin="anonymous").',
        error.message
      );
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new AudioExtractionError(
      'CAPTURE_NOT_SUPPORTED',
      `Failed to attach stream capture to audio element: ${msg}`
    );
  }

  if (element.paused) {
    try {
      await element.play();
    } catch (playErr: unknown) {
      const msg = playErr instanceof Error ? playErr.message : String(playErr);
      throw new AudioExtractionError(
        'CAPTURE_NOT_SUPPORTED',
        `Press play on the audio player first (autoplay blocked: ${msg}).`
      );
    }
  }

  // Extract only audio tracks so MediaRecorder writes an audio-only container
  const audioTracks = stream.getAudioTracks();
  const recordingStream = audioTracks.length > 0 ? new MediaStream(audioTracks) : stream;

  const preferredMime = selectRecorderMimeType();
  const recorder = preferredMime
    ? new MediaRecorder(recordingStream, { mimeType: preferredMime })
    : new MediaRecorder(recordingStream);

  const chunks: Blob[] = [];
  let totalBytes = 0;
  const startedAt = Date.now();
  const maxDurationMs = (options.maxDurationSeconds ?? 600) * 1000;

  return new Promise<CapturedAudioResult>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearInterval(progressTimer);
      clearTimeout(maxDurationTimer);
      element.removeEventListener('ended', handleEnded);
      options.stopSignal.removeEventListener('abort', handleStopSignal);
    };

    const stopRecorderSafely = (): void => {
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors if stream already closed
        }
      }
    };

    const handleEnded = (): void => {
      stopRecorderSafely();
    };

    const handleStopSignal = (): void => {
      stopRecorderSafely();
    };

    const progressTimer = window.setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      options.onProgress?.(elapsedSeconds, totalBytes);
    }, 500);

    const maxDurationTimer = window.setTimeout(() => {
      stopRecorderSafely();
    }, maxDurationMs);

    element.addEventListener('ended', handleEnded);
    options.stopSignal.addEventListener('abort', handleStopSignal);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
        totalBytes += event.data.size;
        if (totalBytes > options.maxBytes) {
          stopRecorderSafely();
        }
      }
    };

    recorder.onerror = (event: Event) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const errorEvent = event as Event & { error?: DOMException };
      reject(
        new AudioExtractionError(
          'CAPTURE_NOT_SUPPORTED',
          `MediaRecorder error while capturing stream: ${errorEvent.error?.message ?? 'Unknown recorder failure'}`
        )
      );
    };

    recorder.onstop = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      const rawMime = (recorder.mimeType || preferredMime || 'audio/webm').split(';')[0] ?? 'audio/webm';
      const blob = new Blob(chunks, { type: rawMime });
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

      if (blob.size === 0) {
        reject(
          new AudioExtractionError(
            'NO_AUDIO_FOUND',
            'Captured 0 bytes from the media stream. Ensure audio is actively playing with volume unmuted.'
          )
        );
        return;
      }

      if (blob.size > options.maxBytes) {
        const mb = (blob.size / (1024 * 1024)).toFixed(2);
        const limitMb = (options.maxBytes / (1024 * 1024)).toFixed(0);
        reject(
          new AudioExtractionError(
            'FILE_TOO_LARGE',
            `Captured stream (${mb} MB) exceeds the ${limitMb} MB upload limit.`
          )
        );
        return;
      }

      const ext = MIME_TO_EXTENSION[rawMime] ?? 'webm';
      resolve({
        blob,
        filename: `stream-capture-${Date.now()}.${ext}`,
        mimeType: rawMime,
        byteLength: blob.size,
        captureMethod: 'capture-stream',
        durationSeconds,
      });
    };

    recorder.start(500);
  });
}

export interface ReadAudioOptions {
  maxFileSizeMb: number;
  fetchTimeoutMs?: number;
  streamStopSignal: AbortSignal;
  onStreamCaptureStarted?: () => void;
  onStreamProgress?: (elapsedSeconds: number, collectedBytes: number) => void;
}

/**
 * Attempts direct fetch (for HTTP/HTTPS URLs and standard Blob URLs), falling back to
 * HTMLMediaElement.captureStream() + MediaRecorder for MSE streams or CORS/auth-blocked audio.
 */
export async function readAudioSource(
  source: DiscoveredAudioSource,
  options: ReadAudioOptions
): Promise<CapturedAudioResult> {
  const maxBytes = options.maxFileSizeMb * 1024 * 1024;
  const isBlobUrl = source.url.startsWith('blob:');
  const captureMethodOnFetch: AudioCaptureMethod = isBlobUrl ? 'blob-fetch' : 'direct-fetch';

  const controller = new AbortController();
  const timeoutMs = options.fetchTimeoutMs ?? 30_000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let fetchFailureReason: string | null = null;

  try {
    const response = await fetch(source.url, {
      credentials: 'include',
      signal: controller.signal,
    });

    if (!response.ok) {
      fetchFailureReason = `HTTP ${response.status} ${response.statusText}`.trim();
    } else {
      const contentType = response.headers.get('content-type');
      const contentDisposition = response.headers.get('content-disposition');
      const contentLengthHeader = response.headers.get('content-length');

      if (contentLengthHeader) {
        const declaredSize = Number(contentLengthHeader);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
          throw new AudioExtractionError(
            'FILE_TOO_LARGE',
            `Audio file is ${(declaredSize / (1024 * 1024)).toFixed(2)} MB, exceeding the ${options.maxFileSizeMb} MB limit.`
          );
        }
      }

      if (contentType && contentType.toLowerCase().includes('text/html')) {
        fetchFailureReason = 'Target URL returned HTML instead of an audio stream.';
      } else {
        const blob = await response.blob();
        if (blob.size === 0) {
          fetchFailureReason = 'Fetched audio file was empty (0 bytes).';
        } else if (blob.size > maxBytes) {
          throw new AudioExtractionError(
            'FILE_TOO_LARGE',
            `Audio file is ${(blob.size / (1024 * 1024)).toFixed(2)} MB, exceeding the ${options.maxFileSizeMb} MB limit.`
          );
        } else {
          const headerBytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
          const { mimeType, filename } = inferMimeAndFilename(
            source.url,
            contentType,
            contentDisposition,
            blob.type,
            source.mimeTypeHint,
            headerBytes
          );

          const normalizedBlob =
            blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });

          return {
            blob: normalizedBlob,
            filename,
            mimeType,
            byteLength: normalizedBlob.size,
            captureMethod: captureMethodOnFetch,
          };
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof AudioExtractionError) {
      throw error;
    }
    fetchFailureReason =
      error instanceof DOMException && error.name === 'AbortError'
        ? `Timed out reading audio after ${Math.round(timeoutMs / 1000)}s.`
        : error instanceof Error
          ? error.message
          : String(error);
  } finally {
    clearTimeout(timer);
  }

  // Fallback: if audio comes from an <audio> element (MSE blob: URL or CORS-protected stream),
  // capture playback via HTMLMediaElement.captureStream() + MediaRecorder.
  if (source.element) {
    options.onStreamCaptureStarted?.();
    return captureMediaElementStream(source.element, {
      maxBytes,
      stopSignal: options.streamStopSignal,
      onProgress: options.onStreamProgress,
    });
  }

  throw new AudioExtractionError(
    'CORS_OR_NETWORK',
    `Unable to read audio from ${source.label}: ${fetchFailureReason ?? 'Direct fetch failed and no <audio> element is available for stream capture.'}`
  );
}
