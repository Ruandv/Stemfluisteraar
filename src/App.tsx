import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Play,
  RefreshCw,
  Settings,
  Terminal,
  Volume2,
} from 'lucide-react';
import {
  AzureClientError,
  base64ToUint8Array,
  buildChatCompletionsUrl,
  buildTranscriptionUrl,
  testAzureConnection,
  transcribeWithAzure,
} from './extension/azure';
import { mountTranscriberOverlay, MountedTranscriberController } from './extension/content';
import {
  DEFAULT_SETTINGS,
  normalizeEndpoint,
  sanitizeSettings,
  validateSettingsForTranscription,
} from './extension/storage';
import {
  EndpointStyle,
  ExtensionSettings,
  TestConnectionSuccessData,
  TranscribeAudioPayload,
  TranscribeAudioResponse,
} from './extension/types';

type ActiveTab = 'simulator' | 'settings' | 'install';

const PREVIEW_STORAGE_KEY = 'azureAudioTranscriberPreviewSettings';

const PROMPT_PRESETS: Record<string, string> = {
  cleanup:
    'Clean up punctuation, fix obvious speech-to-text errors, and organize the transcript into readable paragraphs without changing the meaning.',
  summary:
    'Summarize this audio transcript with a concise 2-sentence overview followed by key bullet points.',
  actions:
    'Extract clear action items, owners (if mentioned), and decisions from this transcript in structured bullet points.',
  translate:
    'Translate this transcript into natural, accurate English while preserving tone and technical terms.',
};

interface ExtensionFileSpec {
  path: string;
  output: string;
  role: string;
}

const EXTENSION_FILES: ExtensionFileSpec[] = [
  {
    path: 'manifest.json',
    output: 'dist/manifest.json',
    role: 'Manifest V3 definition, storage permission, Azure host_permissions, and target site matches',
  },
  {
    path: 'src/extension/content.ts',
    output: 'dist/content.js',
    role: 'Shadow DOM floating button, collapsible panel, pipeline status, Copy & .txt export',
  },
  {
    path: 'src/extension/audio-extractor.ts',
    output: 'dist/content.js',
    role: 'DOM <audio> and link discovery, Blob/URL fetch, captureStream() + MediaRecorder fallback',
  },
  {
    path: 'src/extension/background.ts',
    output: 'dist/background.js',
    role: 'MV3 service worker bypassing host-page CORS via host_permissions with async return true',
  },
  {
    path: 'src/extension/azure.ts',
    output: 'bundled',
    role: 'Dual-pattern Azure OpenAI URL builder, multipart upload, Step 2 LLM post-processing, connection probe',
  },
  {
    path: 'src/extension/storage.ts',
    output: 'bundled',
    role: 'Typed chrome.storage.local persistence and configuration validation',
  },
  {
    path: 'src/extension/options.html',
    output: 'dist/options.html',
    role: 'CSP-compliant Chrome extension settings page',
  },
  {
    path: 'src/extension/options.ts',
    output: 'dist/options.js',
    role: 'Settings form controller, URL preview, and service worker test trigger',
  },
  {
    path: 'scripts/build-extension.mjs',
    output: 'dist/icons/*.png',
    role: 'esbuild bundler (ESM worker, IIFE content/options) and PNG icon generator',
  },
];

/**
 * Generates a real playable WAV Blob in-browser (gentle harmonic chord progression)
 * so the Live Page Simulator has genuine <audio> elements and downloadable .wav links.
 */
function createSynthesizedWavBlob(frequencies: number[], durationSeconds: number): Blob {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.08) * Math.min(1, (durationSeconds - t) / 0.15);
    const segmentIndex = Math.min(
      frequencies.length - 1,
      Math.floor((t / durationSeconds) * frequencies.length)
    );
    const freq = frequencies[segmentIndex] ?? 440;
    const sample =
      (Math.sin(2 * Math.PI * freq * t) * 0.45 +
        Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.2) *
      envelope;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function loadPreviewSettings(): ExtensionSettings {
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    return sanitizeSettings(JSON.parse(raw) as Partial<ExtensionSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('simulator');
  const [settings, setSettings] = useState<ExtensionSettings>(() => loadPreviewSettings());
  const [showApiKey, setShowApiKey] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    | { status: 'idle' }
    | { status: 'testing' }
    | { status: 'success'; data: TestConnectionSuccessData }
    | { status: 'error'; message: string; details?: string }
  >({ status: 'idle' });

  const [widgetMounted, setWidgetMounted] = useState(true);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [lastPayloadInspection, setLastPayloadInspection] = useState<{
    filename: string;
    mimeType: string;
    byteLength: number;
    captureMethod: string;
    capturedAt: string;
  } | null>(null);

  const overlayRef = useRef<MountedTranscriberController | null>(null);
  const settingsRef = useRef<ExtensionSettings>(settings);
  settingsRef.current = settings;

  const sampleAudioUrls = useMemo(() => {
    const primaryBlob = createSynthesizedWavBlob([330, 440, 554.37, 659.25], 2.8);
    const linkBlob = createSynthesizedWavBlob([293.66, 369.99, 440], 2.0);
    return {
      primaryUrl: URL.createObjectURL(primaryBlob),
      linkUrl: URL.createObjectURL(linkBlob),
    };
  }, []);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(sampleAudioUrls.primaryUrl);
      URL.revokeObjectURL(sampleAudioUrls.linkUrl);
    };
  }, [sampleAudioUrls]);

  // Mount the real Shadow DOM widget from content.ts inside the workbench preview
  useEffect(() => {
    if (!widgetMounted) {
      overlayRef.current?.unmount();
      overlayRef.current = null;
      return;
    }

    const controller = mountTranscriberOverlay({
      async getMaxFileSizeMb() {
        return settingsRef.current.maxFileSizeMb;
      },
      async transcribeAudio(payload: TranscribeAudioPayload): Promise<TranscribeAudioResponse> {
        setLastPayloadInspection({
          filename: payload.filename,
          mimeType: payload.mimeType,
          byteLength: payload.byteLength,
          captureMethod: payload.captureMethod,
          capturedAt: new Date().toLocaleTimeString(),
        });

        const currentSettings = settingsRef.current;
        const validationErr = validateSettingsForTranscription(currentSettings);
        if (validationErr) {
          return {
            ok: false,
            error: {
              code: 'MISSING_CONFIG',
              message: validationErr,
              details:
                'Click Open Settings to enter your Azure API key, or load dist/ in Chrome where background.ts handles requests.',
            },
          };
        }

        try {
          const bytes = base64ToUint8Array(payload.base64Data);
          const data = await transcribeWithAzure(
            {
              bytes,
              mimeType: payload.mimeType,
              filename: payload.filename,
            },
            currentSettings
          );
          return { ok: true, data };
        } catch (error: unknown) {
          if (error instanceof AzureClientError) {
            return { ok: false, error: error.toSerialized() };
          }
          return {
            ok: false,
            error: {
              code: 'UNKNOWN',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
      async openOptionsPage() {
        setActiveTab('settings');
      },
    });

    overlayRef.current = controller;
    return () => {
      controller.unmount();
      overlayRef.current = null;
    };
  }, [widgetMounted]);

  // Rescan sources when returning to simulator tab
  useEffect(() => {
    if (activeTab === 'simulator') {
      overlayRef.current?.refreshSources();
    }
  }, [activeTab]);

  const resolvedTxUrl = useMemo(() => {
    if (!settings.endpoint || !settings.deployment) {
      return 'Enter endpoint and deployment name';
    }
    return buildTranscriptionUrl(settings).url;
  }, [settings]);

  const resolvedChatUrl = useMemo(() => {
    if (!settings.enablePostProcessing || !settings.endpoint || !settings.chatDeployment) {
      return null;
    }
    return buildChatCompletionsUrl(settings).url;
  }, [settings]);

  const handleSaveSettings = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const cleaned = sanitizeSettings({
      ...settings,
      endpoint: normalizeEndpoint(settings.endpoint),
    });
    setSettings(cleaned);
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(cleaned));
    setSaveNotice('Settings saved to browser preview storage.');
    window.setTimeout(() => setSaveNotice(null), 3500);
  };

  const handleTestConnection = async (): Promise<void> => {
    const validationErr = validateSettingsForTranscription(settings);
    if (validationErr) {
      setTestState({ status: 'error', message: validationErr });
      return;
    }
    setTestState({ status: 'testing' });
    try {
      const data = await testAzureConnection(settings);
      setTestState({ status: 'success', data });
    } catch (error: unknown) {
      if (error instanceof AzureClientError) {
        setTestState({
          status: 'error',
          message: error.message,
          details:
            error.code === 'CORS_OR_NETWORK'
              ? `${error.details ?? ''} — Note: Browser tabs are subject to CORS; inside the loaded Chrome extension, background.ts bypasses CORS via host_permissions.`.trim()
              : error.details,
        });
      } else {
        setTestState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const handleCopyBuildCommand = (): void => {
    void navigator.clipboard.writeText('npm run build').then(() => {
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar: 3-zone contract */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-8">
          <a
            href="#simulator"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('simulator');
            }}
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Stemfluisteraar
          </a>

          <nav className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('simulator')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors cursor-pointer ${
                activeTab === 'simulator'
                  ? 'text-slate-900 border-b-2 border-[#0078D4]'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Live Simulator
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors cursor-pointer ${
                activeTab === 'settings'
                  ? 'text-slate-900 border-b-2 border-[#0078D4]'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Extension Settings
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('install')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors cursor-pointer ${
                activeTab === 'install'
                  ? 'text-slate-900 border-b-2 border-[#0078D4]'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Install &amp; Architecture
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setWidgetMounted((prev) => !prev)}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#0078D4] hover:bg-[#006CBE] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {widgetMounted ? 'Hide Floating Button' : 'Mount Floating Button'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        {activeTab === 'simulator' && (
          <div className="space-y-8">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 pb-6">
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">
                  Target Page Simulation · https://praat.ai/job/7f9c2a40-8b3d-4e1a-9d12-3f6a0b8c1e24
                </p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 text-balance">
                  In-Page Audio Discovery &amp; Shadow DOM Widget Sandbox
                </h1>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => overlayRef.current?.refreshSources()}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Rescan Page Audio
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Settings className="w-3.5 h-3.5" />
                  Configure Azure
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
              <div className="lg:col-span-2 space-y-6">
                {/* Simulated Audio Player 1 */}
                <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">
                        01. Embedded HTML5 Audio Element (Blob Source)
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Discovered via <code className="text-slate-700">&lt;audio&gt;</code> currentSrc · Read directly or captured via <code className="text-slate-700">captureStream()</code>
                      </p>
                    </div>
                    <Volume2 className="w-4 h-4 text-slate-400 shrink-0" />
                  </div>

                  <audio
                    controls
                    src={sampleAudioUrls.primaryUrl}
                    className="w-full"
                    aria-label="Weekly Sync Audio Recording"
                  />

                  <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                    <span>Format: audio/wav · 22.05 kHz Mono PCM</span>
                    <span className="font-mono tabular-nums">2.8s sample</span>
                  </div>
                </section>

                {/* Simulated Download Link 2 */}
                <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      02. Direct Downloadable Audio Link
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Discovered via anchor URL matching <code className="text-slate-700">.mp3, .wav, .m4a, .ogg, .webm, .flac</code>
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        customer-interview-excerpt.wav
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Direct audio attachment link on page
                      </p>
                    </div>
                    <a
                      href={sampleAudioUrls.linkUrl}
                      download="customer-interview-excerpt.wav"
                      className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download WAV
                    </a>
                  </div>
                </section>
              </div>

              {/* Right Column: Live Capture Inspector */}
              <aside className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Extension Pipeline Inspector
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    Click the docked <strong className="text-slate-700">Transcribe Audio</strong> button in the bottom-right corner to execute the live Shadow DOM content script.
                  </p>
                </div>

                <div className="border-t border-slate-200 pt-4 space-y-3 text-xs">
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Azure Endpoint</span>
                    <span className="font-mono text-slate-900 truncate max-w-[200px]" title={settings.endpoint}>
                      {settings.endpoint.replace(/^https?:\/\//, '')}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Deployment</span>
                    <span className="font-mono text-slate-900">{settings.deployment || 'Unset'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">API Key Status</span>
                    <span className="font-medium text-slate-900">
                      {settings.apiKey ? 'Configured in Preview' : 'Not Set'}
                    </span>
                  </div>
                </div>

                <div className="border-t border-slate-200 pt-4">
                  <p className="text-xs font-semibold text-slate-700 mb-2">
                    Last Captured Audio Payload
                  </p>
                  {lastPayloadInspection ? (
                    <dl className="space-y-2 text-xs">
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Filename</dt>
                        <dd className="font-mono text-slate-900 truncate">{lastPayloadInspection.filename}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">MIME Type</dt>
                        <dd className="font-mono text-slate-900">{lastPayloadInspection.mimeType}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Size</dt>
                        <dd className="font-mono tabular-nums text-slate-900">
                          {(lastPayloadInspection.byteLength / 1024).toFixed(1)} KB
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Method</dt>
                        <dd className="font-mono text-slate-900">{lastPayloadInspection.captureMethod}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Captured</dt>
                        <dd className="font-mono tabular-nums text-slate-900">{lastPayloadInspection.capturedAt}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-xs text-slate-500">
                      No audio captured yet. Trigger transcription from the floating button to inspect the extracted Blob metadata.
                    </p>
                  )}
                </div>
              </aside>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-3xl space-y-6">
            <div className="border-b border-slate-200 pb-5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Azure Connection &amp; Post-Processing Settings
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Mirrors <code className="text-slate-800">options.html</code> for sandbox testing. In Chrome, settings are persisted via <code className="text-slate-800">chrome.storage.local</code>.
              </p>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-6">
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                <h2 className="text-base font-semibold text-slate-900">
                  Transcription Endpoint
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2 space-y-1.5">
                    <label htmlFor="wb-endpoint" className="block text-xs font-semibold text-slate-700">
                      Azure OpenAI / Foundry Resource URL
                    </label>
                    <input
                      id="wb-endpoint"
                      type="url"
                      value={settings.endpoint}
                      onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })}
                      placeholder="https://ruand-mllaybcr-swedencentral.openai.azure.com"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="wb-deployment" className="block text-xs font-semibold text-slate-700">
                      Transcription Deployment / Model
                    </label>
                    <input
                      id="wb-deployment"
                      type="text"
                      value={settings.deployment}
                      onChange={(e) => setSettings({ ...settings, deployment: e.target.value })}
                      placeholder="gpt-4o-transcribe"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="wb-style" className="block text-xs font-semibold text-slate-700">
                      URL Pattern
                    </label>
                    <select
                      id="wb-style"
                      value={settings.endpointStyle}
                      onChange={(e) =>
                        setSettings({ ...settings, endpointStyle: e.target.value as EndpointStyle })
                      }
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                    >
                      <option value="auto">Auto (Deployment if API version set, else v1)</option>
                      <option value="deployment">Deployment (/openai/deployments/&#123;name&#125;/...)</option>
                      <option value="v1">OpenAI v1 (/openai/v1/audio/transcriptions)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="wb-apiversion" className="block text-xs font-semibold text-slate-700">
                      API Version (Optional)
                    </label>
                    <input
                      id="wb-apiversion"
                      type="text"
                      value={settings.apiVersion}
                      onChange={(e) => setSettings({ ...settings, apiVersion: e.target.value })}
                      placeholder="2025-03-01-preview"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="wb-language" className="block text-xs font-semibold text-slate-700">
                      Language Hint (Optional)
                    </label>
                    <input
                      id="wb-language"
                      type="text"
                      value={settings.language}
                      onChange={(e) => setSettings({ ...settings, language: e.target.value })}
                      placeholder="en (blank = auto-detect)"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                    />
                  </div>

                  <div className="md:col-span-2 space-y-1.5">
                    <label htmlFor="wb-apikey" className="block text-xs font-semibold text-slate-700">
                      Azure API Key
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="wb-apikey"
                        type={showApiKey ? 'text' : 'password'}
                        value={settings.apiKey}
                        onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                        placeholder="Paste Azure OpenAI API key for sandbox testing"
                        className="flex-1 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-2 focus:outline-[#0078D4]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        className="px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-1">
                  <p className="text-xs font-semibold text-slate-600">Resolved Request URL</p>
                  <p className="text-xs font-mono text-slate-900 break-all">{resolvedTxUrl}</p>
                  {resolvedChatUrl && (
                    <p className="text-xs font-mono text-slate-700 break-all pt-1">
                      Refine: {resolvedChatUrl}
                    </p>
                  )}
                </div>
              </section>

              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-2.5">
                  <input
                    id="wb-postprocess"
                    type="checkbox"
                    checked={settings.enablePostProcessing}
                    onChange={(e) =>
                      setSettings({ ...settings, enablePostProcessing: e.target.checked })
                    }
                    className="w-4 h-4 accent-[#0078D4]"
                  />
                  <label htmlFor="wb-postprocess" className="text-sm font-semibold text-slate-900">
                    Enable Step 2 LLM Post-Processing
                  </label>
                </div>

                <div
                  className={`grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity ${
                    settings.enablePostProcessing ? 'opacity-100' : 'opacity-50'
                  }`}
                >
                  <div className="space-y-1.5">
                    <label htmlFor="wb-chat-dep" className="block text-xs font-semibold text-slate-700">
                      Chat / LLM Deployment
                    </label>
                    <input
                      id="wb-chat-dep"
                      type="text"
                      value={settings.chatDeployment}
                      onChange={(e) => setSettings({ ...settings, chatDeployment: e.target.value })}
                      placeholder="gpt-4o-mini"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wb-chat-ver" className="block text-xs font-semibold text-slate-700">
                      Chat API Version (Optional)
                    </label>
                    <input
                      id="wb-chat-ver"
                      type="text"
                      value={settings.chatApiVersion}
                      onChange={(e) => setSettings({ ...settings, chatApiVersion: e.target.value })}
                      placeholder="2024-10-21"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="md:col-span-2 space-y-2">
                    <label htmlFor="wb-prompt" className="block text-xs font-semibold text-slate-700">
                      Post-Processing Prompt
                    </label>
                    <textarea
                      id="wb-prompt"
                      rows={3}
                      value={settings.postProcessPrompt}
                      onChange={(e) =>
                        setSettings({ ...settings, postProcessPrompt: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    />
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(PROMPT_PRESETS).map(([key, promptText]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSettings({ ...settings, postProcessPrompt: promptText })}
                          className="px-2.5 py-1 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md cursor-pointer capitalize"
                        >
                          {key === 'cleanup' ? 'Clean & Punctuate' : key}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="px-4 py-2 text-sm font-semibold text-white bg-[#0078D4] hover:bg-[#006CBE] rounded-lg cursor-pointer"
                  >
                    Save Settings
                  </button>
                  <button
                    type="button"
                    disabled={testState.status === 'testing'}
                    onClick={() => void handleTestConnection()}
                    className="px-4 py-2 text-sm font-medium bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    {testState.status === 'testing' ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setSettings(DEFAULT_SETTINGS);
                    localStorage.removeItem(PREVIEW_STORAGE_KEY);
                    setTestState({ status: 'idle' });
                  }}
                  className="px-4 py-2 text-sm font-medium bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  Reset Defaults
                </button>
              </div>

              {saveNotice && (
                <div className="p-3 text-sm bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg">
                  {saveNotice}
                </div>
              )}

              {testState.status === 'success' && (
                <div className="p-4 text-xs bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg space-y-1 font-mono">
                  <p className="font-sans text-sm font-semibold">Azure connection verified</p>
                  <p>URL: {testState.data.transcriptionUrl}</p>
                  <p>Latency: {testState.data.transcriptionLatencyMs} ms</p>
                  <p>Response: {testState.data.transcriptionResponsePreview}</p>
                </div>
              )}

              {testState.status === 'error' && (
                <div className="p-4 text-xs bg-red-50 border border-red-200 text-red-900 rounded-lg space-y-1">
                  <p className="text-sm font-semibold">{testState.message}</p>
                  {testState.details && <p className="font-mono break-all">{testState.details}</p>}
                </div>
              )}
            </form>
          </div>
        )}

        {activeTab === 'install' && (
          <div className="space-y-8">
            <div className="border-b border-slate-200 pb-5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Compile &amp; Load Unpacked in Chrome
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Ready-to-compile Manifest V3 TypeScript extension targeting{' '}
                <code className="text-slate-800">{settings.endpoint}</code>.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <ExternalLink className="w-4 h-4 text-[#0078D4]" />
                  01. Target Site Configured
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  <code className="text-slate-800">manifest.json</code> targets{' '}
                  <code className="text-slate-800">https://praat.ai/*</code> and activates on{' '}
                  <code className="text-slate-800">/job/[GUID]</code> routes (supporting SPA navigation).
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Terminal className="w-4 h-4 text-[#0078D4]" />
                  02. Build Unpacked Bundle
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono">
                  <span>npm run build</span>
                  <button
                    type="button"
                    onClick={handleCopyBuildCommand}
                    className="text-slate-300 hover:text-white cursor-pointer"
                    aria-label="Copy build command"
                  >
                    {copiedCmd ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-xs text-slate-600">
                  Runs esbuild to output <code className="text-slate-800">background.js</code>,{' '}
                  <code className="text-slate-800">content.js</code>, <code className="text-slate-800">options.js</code>, and PNG icons into <code className="text-slate-800">dist/</code>.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <FolderOpen className="w-4 h-4 text-[#0078D4]" />
                  03. Load Unpacked in Chrome
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Open <code className="text-slate-800">chrome://extensions</code>, enable{' '}
                  <strong>Developer mode</strong>, click <strong>Load unpacked</strong>, and select the{' '}
                  <code className="text-slate-800">dist/</code> folder.
                </p>
              </div>
            </div>

            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">
                  Extension Module Architecture
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveTab('simulator')}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0078D4] hover:underline cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Try Live Simulator
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="py-3 px-6 font-semibold">Source File</th>
                      <th className="py-3 px-4 font-semibold">Build Output</th>
                      <th className="py-3 px-6 font-semibold">Responsibility</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {EXTENSION_FILES.map((file) => (
                      <tr key={file.path} className="hover:bg-slate-50/70">
                        <td className="py-3 px-6 font-mono text-slate-900 whitespace-nowrap">
                          {file.path}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                          {file.output}
                        </td>
                        <td className="py-3 px-6 text-slate-700">{file.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
