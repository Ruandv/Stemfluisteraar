import { buildChatCompletionsUrl, buildTranscriptionUrl } from './azure';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeEndpoint,
  saveSettings,
  validateSettingsForTranscription,
} from './storage';
import {
  EndpointStyle,
  ExtensionMessage,
  ExtensionSettings,
  TestConnectionResponse,
} from './types';

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

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element #${id} in options.html`);
  }
  return el as T;
}

function readFormValues(): ExtensionSettings {
  const endpointRaw = getElement<HTMLInputElement>('endpoint').value;
  const endpointStyle = getElement<HTMLSelectElement>('endpointStyle').value as EndpointStyle;
  const deployment = getElement<HTMLInputElement>('deployment').value.trim();
  const apiVersion = getElement<HTMLInputElement>('apiVersion').value.trim();
  const apiKey = getElement<HTMLInputElement>('apiKey').value.trim();
  const language = getElement<HTMLInputElement>('language').value.trim();
  const maxFileSizeRaw = Number(getElement<HTMLInputElement>('maxFileSizeMb').value);
  const enablePostProcessing = getElement<HTMLInputElement>('enablePostProcessing').checked;
  const chatDeployment = getElement<HTMLInputElement>('chatDeployment').value.trim();
  const chatApiVersion = getElement<HTMLInputElement>('chatApiVersion').value.trim();
  const postProcessPrompt = getElement<HTMLTextAreaElement>('postProcessPrompt').value.trim();
  const automateProcess = getElement<HTMLInputElement>('automateProcess').checked;

  return {
    endpoint: normalizeEndpoint(endpointRaw),
    endpointStyle,
    deployment,
    apiVersion,
    apiKey,
    language,
    maxFileSizeMb:
      Number.isFinite(maxFileSizeRaw) && maxFileSizeRaw > 0 ? maxFileSizeRaw : 25,
    enablePostProcessing,
    chatDeployment,
    chatApiVersion,
    postProcessPrompt: postProcessPrompt || DEFAULT_SETTINGS.postProcessPrompt,
    automateProcess,
  };
}

function writeFormValues(settings: ExtensionSettings): void {
  getElement<HTMLInputElement>('endpoint').value = settings.endpoint;
  getElement<HTMLSelectElement>('endpointStyle').value = settings.endpointStyle;
  getElement<HTMLInputElement>('deployment').value = settings.deployment;
  getElement<HTMLInputElement>('apiVersion').value = settings.apiVersion;
  getElement<HTMLInputElement>('apiKey').value = settings.apiKey;
  getElement<HTMLInputElement>('language').value = settings.language;
  getElement<HTMLInputElement>('maxFileSizeMb').value = String(settings.maxFileSizeMb);
  getElement<HTMLInputElement>('enablePostProcessing').checked = settings.enablePostProcessing;
  getElement<HTMLInputElement>('chatDeployment').value = settings.chatDeployment;
  getElement<HTMLInputElement>('chatApiVersion').value = settings.chatApiVersion;
  getElement<HTMLTextAreaElement>('postProcessPrompt').value = settings.postProcessPrompt;
  getElement<HTMLInputElement>('automateProcess').checked = settings.automateProcess;
  updatePostProcessVisibility();
  updateResolvedUrlPreview();
}

function updatePostProcessVisibility(): void {
  const enabled = getElement<HTMLInputElement>('enablePostProcessing').checked;
  const container = getElement<HTMLDivElement>('post-process-fields');
  container.style.opacity = enabled ? '1' : '0.55';
}

function updateResolvedUrlPreview(): void {
  const preview = getElement<HTMLDivElement>('resolved-url-preview');
  const current = readFormValues();

  if (!current.endpoint || !current.deployment) {
    preview.textContent = 'Enter an endpoint URL and deployment name to preview.';
    return;
  }

  const tx = buildTranscriptionUrl(current);
  if (current.enablePostProcessing && current.chatDeployment) {
    const chat = buildChatCompletionsUrl(current);
    preview.textContent = `Transcribe: ${tx.url}\nRefine:     ${chat.url}`;
  } else {
    preview.textContent = tx.url;
  }
}

function showBanner(kind: 'success' | 'error', title: string, detail?: string): void {
  const banner = getElement<HTMLDivElement>('status-banner');
  banner.className = `banner is-visible ${kind === 'success' ? 'is-success' : 'is-error'}`;
  banner.textContent = '';

  const strong = document.createElement('strong');
  strong.textContent = title;
  banner.appendChild(strong);

  if (detail) {
    const pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = detail;
    banner.appendChild(pre);
  }
}

function sendConnectionTest(settings: ExtensionSettings): Promise<TestConnectionResponse> {
  return new Promise((resolve) => {
    const message: ExtensionMessage = {
      type: 'TEST_AZURE_CONNECTION',
      payload: settings,
    };
    chrome.runtime.sendMessage(message, (response: TestConnectionResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: {
            code: 'UNKNOWN',
            message: chrome.runtime.lastError.message ?? 'Failed to reach background worker.',
          },
        });
        return;
      }
      if (!response) {
        resolve({
          ok: false,
          error: {
            code: 'UNKNOWN',
            message: 'Empty response from background service worker.',
          },
        });
        return;
      }
      resolve(response);
    });
  });
}

async function initOptionsPage(): Promise<void> {
  const loaded = await loadSettings();
  writeFormValues(loaded);

  const form = getElement<HTMLFormElement>('settings-form');
  const toggleKeyBtn = getElement<HTMLButtonElement>('toggle-key-btn');
  const apiKeyInput = getElement<HTMLInputElement>('apiKey');
  const testBtn = getElement<HTMLButtonElement>('test-btn');
  const resetBtn = getElement<HTMLButtonElement>('reset-btn');
  const postProcessCheckbox = getElement<HTMLInputElement>('enablePostProcessing');

  ['endpoint', 'endpointStyle', 'deployment', 'apiVersion', 'chatDeployment', 'chatApiVersion'].forEach(
    (id) => {
      getElement<HTMLElement>(id).addEventListener('input', updateResolvedUrlPreview);
      getElement<HTMLElement>(id).addEventListener('change', updateResolvedUrlPreview);
    }
  );

  postProcessCheckbox.addEventListener('change', () => {
    updatePostProcessVisibility();
    updateResolvedUrlPreview();
  });

  toggleKeyBtn.addEventListener('click', () => {
    const isHidden = apiKeyInput.type === 'password';
    apiKeyInput.type = isHidden ? 'text' : 'password';
    toggleKeyBtn.textContent = isHidden ? 'Hide' : 'Show';
  });

  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      if (presetKey && PROMPT_PRESETS[presetKey]) {
        getElement<HTMLTextAreaElement>('postProcessPrompt').value = PROMPT_PRESETS[presetKey];
      }
    });
  });

  form.addEventListener('submit', async (event: SubmitEvent) => {
    event.preventDefault();
    const values = readFormValues();
    const saved = await saveSettings(values);
    writeFormValues(saved);
    showBanner(
      'success',
      'Settings saved to chrome.storage.local.',
      `Endpoint: ${saved.endpoint} · Deployment: ${saved.deployment}`
    );
  });

  testBtn.addEventListener('click', async () => {
    const values = readFormValues();
    const validationErr = validateSettingsForTranscription(values);
    if (validationErr) {
      showBanner('error', 'Configuration incomplete', validationErr);
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';

    try {
      await saveSettings(values);
      const response = await sendConnectionTest(values);

      if (!response.ok) {
        const detailLines = [
          response.error.message,
          response.error.details ?? '',
        ]
          .filter(Boolean)
          .join('\n');
        showBanner('error', 'Connection test failed', detailLines);
        return;
      }

      const lines = [
        `Transcription URL: ${response.data.transcriptionUrl}`,
        `Latency: ${response.data.transcriptionLatencyMs} ms`,
        `Response: ${response.data.transcriptionResponsePreview}`,
      ];
      if (response.data.chatUrl) {
        lines.push(
          `Chat URL: ${response.data.chatUrl}`,
          `Chat Latency: ${response.data.chatLatencyMs ?? 0} ms`,
          `Chat Response: ${response.data.chatResponsePreview ?? 'OK'}`
        );
      }

      showBanner('success', 'Azure connection verified.', lines.join('\n'));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Connection';
    }
  });

  resetBtn.addEventListener('click', async () => {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    writeFormValues(saved);
    showBanner('success', 'Settings reset to defaults (API key cleared).');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initOptionsPage();
});
