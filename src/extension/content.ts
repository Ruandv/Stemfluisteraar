import {
  AudioExtractionError,
  discoverAudioSources,
  readAudioSource,
} from './audio-extractor';
import { arrayBufferToBase64 } from './azure';
import { DEFAULT_SETTINGS, loadSettings } from './storage';
import {
  CapturedAudioResult,
  DiscoveredAudioSource,
  ExtensionMessage,
  PipelineStage,
  SerializedExtensionError,
  SimpleActionResponse,
  TranscribeAudioPayload,
  TranscribeAudioResponse,
  TranscriptionSuccessData,
} from './types';

const HOST_ELEMENT_ID = 'azure-audio-transcriber-extension-host';
const FAB_POSITION_STORAGE_KEY = 'azureAudioTranscriberFabPosition';

interface FabPosition {
  left: number;
  top: number;
}

function isFabPosition(value: unknown): value is FabPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as FabPosition).left) &&
    Number.isFinite((value as FabPosition).top)
  );
}

async function loadFabPosition(): Promise<FabPosition | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }
  try {
    const stored = await chrome.storage.local.get(FAB_POSITION_STORAGE_KEY);
    const raw = stored[FAB_POSITION_STORAGE_KEY];
    return isFabPosition(raw) ? raw : null;
  } catch {
    // Extension context may be invalidated (e.g. after an update); just skip restoring.
    return null;
  }
}

function saveFabPosition(position: FabPosition): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  void chrome.storage.local.set({ [FAB_POSITION_STORAGE_KEY]: position }).catch(() => {
    // Ignore storage write failures; dragging still works for the current page view.
  });
}

export interface ExtensionTransport {
  getMaxFileSizeMb: () => Promise<number>;
  transcribeAudio: (payload: TranscribeAudioPayload) => Promise<TranscribeAudioResponse>;
  openOptionsPage: () => Promise<void>;
}

const chromeRuntimeTransport: ExtensionTransport = {
  async getMaxFileSizeMb(): Promise<number> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const settings = await loadSettings();
      return settings.maxFileSizeMb;
    }
    return DEFAULT_SETTINGS.maxFileSizeMb;
  },
  transcribeAudio(payload: TranscribeAudioPayload): Promise<TranscribeAudioResponse> {
    return new Promise((resolve) => {
      const message: ExtensionMessage = {
        type: 'TRANSCRIBE_AUDIO',
        payload,
      };
      chrome.runtime.sendMessage(
        message,
        (response: TranscribeAudioResponse | undefined) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: {
                code: 'UNKNOWN',
                message:
                  chrome.runtime.lastError.message ??
                  'Background service worker did not respond.',
              },
            });
            return;
          }
          if (!response) {
            resolve({
              ok: false,
              error: {
                code: 'UNKNOWN',
                message:
                  'Received empty response from extension background service worker.',
              },
            });
            return;
          }
          resolve(response);
        }
      );
    });
  },
  openOptionsPage(): Promise<void> {
    return new Promise((resolve) => {
      const message: ExtensionMessage = { type: 'OPEN_OPTIONS_PAGE' };
      chrome.runtime.sendMessage(message, (_response: SimpleActionResponse | undefined) => {
        resolve();
      });
    });
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function createShadowStyles(): string {
  return `
    :host {
      all: initial;
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    .aat-shell {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
    }

    .aat-panel {
      width: 390px;
      max-width: calc(100vw - 32px);
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      box-shadow: 0 18px 40px -12px rgba(15, 23, 42, 0.22);
      overflow: hidden;
      display: none;
    }

    .aat-panel.is-open {
      display: block;
    }

    .aat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }

    .aat-title {
      font-size: 13px;
      font-weight: 600;
      color: #0f172a;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .aat-header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .aat-icon-btn {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: #475569;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease;
    }

    .aat-icon-btn:hover {
      background: #e2e8f0;
      color: #0f172a;
    }

    .aat-icon-btn:focus-visible,
    .aat-btn:focus-visible,
    .aat-fab:focus-visible,
    .aat-select:focus-visible,
    .aat-tab-btn:focus-visible {
      outline: 2px solid #0078d4;
      outline-offset: 2px;
    }

    .aat-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .aat-source-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .aat-select {
      flex: 1;
      min-width: 0;
      height: 34px;
      padding: 0 10px;
      font-size: 12px;
      color: #0f172a;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 7px;
      font-family: inherit;
    }

    .aat-status-box {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .aat-status-box.is-error {
      background: #fef2f2;
      border-color: #fecaca;
      color: #991b1b;
      align-items: flex-start;
      flex-direction: column;
    }

    .aat-status-box.is-done {
      background: #f0fdf4;
      border-color: #bbf7d0;
      color: #166534;
    }

    .aat-status-box.is-recording {
      background: #eff6ff;
      border-color: #bfdbfe;
      color: #1e40af;
    }

    .aat-status-main {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 500;
      min-width: 0;
    }

    .aat-status-meta {
      font-size: 11.5px;
      color: #64748b;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .aat-error-detail {
      font-size: 11.5px;
      color: #7f1d1d;
      word-break: break-word;
      margin: 0;
    }

    .aat-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #cbd5e1;
      border-top-color: #0078d4;
      border-radius: 50%;
      flex-shrink: 0;
      animation: aat-spin 700ms linear infinite;
    }

    @keyframes aat-spin {
      to { transform: rotate(360deg); }
    }

    .aat-view-tabs {
      display: flex;
      gap: 4px;
      padding: 3px;
      background: #f1f5f9;
      border-radius: 7px;
      align-self: flex-start;
    }

    .aat-tab-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: #475569;
      font-size: 11.5px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 5px;
      cursor: pointer;
      font-family: inherit;
    }

    .aat-tab-btn.is-active {
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }

    .aat-transcript {
      width: 100%;
      min-height: 150px;
      max-height: 260px;
      resize: vertical;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.55;
      color: #0f172a;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-family: inherit;
    }

    .aat-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .aat-btn-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .aat-btn {
      appearance: none;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #0f172a;
      font-size: 12px;
      font-weight: 500;
      padding: 7px 12px;
      border-radius: 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      font-family: inherit;
      transition: background-color 140ms ease, border-color 140ms ease;
    }

    .aat-btn:hover:not(:disabled) {
      background: #f8fafc;
      border-color: #94a3b8;
    }

    .aat-btn:disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }

    .aat-btn-primary {
      background: #0078d4;
      border-color: #0078d4;
      color: #ffffff;
    }

    .aat-btn-primary:hover:not(:disabled) {
      background: #006cbe;
      border-color: #006cbe;
    }

    .aat-btn-danger {
      background: #dc2626;
      border-color: #dc2626;
      color: #ffffff;
    }

    .aat-btn-danger:hover:not(:disabled) {
      background: #b91c1c;
      border-color: #b91c1c;
    }

    .aat-fab {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: #0f172a;
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 16px;
      border-radius: 10px;
      box-shadow: 0 10px 25px -6px rgba(15, 23, 42, 0.4);
      cursor: grab;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: inherit;
      white-space: nowrap;
      touch-action: none;
      user-select: none;
      transition: transform 140ms ease, background-color 140ms ease;
    }

    .aat-fab:hover {
      background: #1e293b;
      transform: translateY(-1px);
    }

    .aat-fab:active {
      transform: translateY(0);
    }

    .aat-fab.is-dragging {
      cursor: grabbing;
      transition: none;
    }
  `;
}

export interface MountedTranscriberController {
  unmount: () => void;
  refreshSources: () => void;
}

export function mountTranscriberOverlay(
  transport: ExtensionTransport = chromeRuntimeTransport,
  container: HTMLElement = document.body
): MountedTranscriberController {
  const existing = document.getElementById(HOST_ELEMENT_ID);
  if (existing) {
    existing.remove();
  }

  const host = document.createElement('div');
  host.id = HOST_ELEMENT_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = createShadowStyles();
  shadow.appendChild(styleEl);

  const shell = document.createElement('div');
  shell.className = 'aat-shell';
  shadow.appendChild(shell);

  // Panel markup built safely via DOM APIs (avoiding innerHTML XSS risk on host pages)
  const panel = document.createElement('section');
  panel.className = 'aat-panel';
  panel.setAttribute('aria-label', 'Stemfluisteraar Panel');

  const header = document.createElement('div');
  header.className = 'aat-header';

  const title = document.createElement('h2');
  title.className = 'aat-title';
  title.textContent = 'Stemfluisteraar';

  const headerActions = document.createElement('div');
  headerActions.className = 'aat-header-actions';

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'aat-icon-btn';
  settingsBtn.title = 'Extension Settings';
  settingsBtn.setAttribute('aria-label', 'Open extension settings');
  settingsBtn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'aat-icon-btn';
  collapseBtn.title = 'Collapse panel';
  collapseBtn.setAttribute('aria-label', 'Collapse transcription panel');
  collapseBtn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  headerActions.append(settingsBtn, collapseBtn);
  header.append(title, headerActions);

  const body = document.createElement('div');
  body.className = 'aat-body';

  // Source selector row
  const sourceRow = document.createElement('div');
  sourceRow.className = 'aat-source-row';

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'aat-select';
  sourceSelect.setAttribute('aria-label', 'Detected audio source');

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'aat-btn';
  refreshBtn.textContent = 'Rescan';

  sourceRow.append(sourceSelect, refreshBtn);

  // Status box
  const statusBox = document.createElement('div');
  statusBox.className = 'aat-status-box';

  // View mode tabs (Processed vs Raw when Step 2 LLM ran)
  const viewTabs = document.createElement('div');
  viewTabs.className = 'aat-view-tabs';
  viewTabs.style.display = 'none';

  const processedTabBtn = document.createElement('button');
  processedTabBtn.type = 'button';
  processedTabBtn.className = 'aat-tab-btn is-active';
  processedTabBtn.textContent = 'Refined Output';

  const rawTabBtn = document.createElement('button');
  rawTabBtn.type = 'button';
  rawTabBtn.className = 'aat-tab-btn';
  rawTabBtn.textContent = 'Raw Transcript';

  viewTabs.append(processedTabBtn, rawTabBtn);

  // Transcript output textarea
  const transcriptArea = document.createElement('textarea');
  transcriptArea.className = 'aat-transcript';
  transcriptArea.readOnly = true;
  transcriptArea.placeholder = 'Transcript will appear here after capturing and submitting page audio.';
  transcriptArea.style.display = 'none';

  // Action bar
  const actionsRow = document.createElement('div');
  actionsRow.className = 'aat-actions';

  const leftActions = document.createElement('div');
  leftActions.className = 'aat-btn-group';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'aat-btn aat-btn-primary';
  runBtn.textContent = 'Transcribe Selected';

  const stopStreamBtn = document.createElement('button');
  stopStreamBtn.type = 'button';
  stopStreamBtn.className = 'aat-btn aat-btn-danger';
  stopStreamBtn.textContent = 'Stop & Transcribe';
  stopStreamBtn.style.display = 'none';

  leftActions.append(runBtn, stopStreamBtn);

  const exportActions = document.createElement('div');
  exportActions.className = 'aat-btn-group';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'aat-btn';
  copyBtn.textContent = 'Copy Transcript';
  copyBtn.disabled = true;

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'aat-btn';
  downloadBtn.textContent = 'Download .txt';
  downloadBtn.disabled = true;

  exportActions.append(copyBtn, downloadBtn);
  actionsRow.append(leftActions, exportActions);

  body.append(sourceRow, statusBox, viewTabs, transcriptArea, actionsRow);
  panel.append(header, body);

  // Floating docked trigger button
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'aat-fab';
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38BDF8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="M6 6v12"/><path d="M18 6v12"/><path d="M2 10v4"/><path d="M22 10v4"/></svg><span>Transcribe Audio</span>';

  shell.append(panel, fab);
  container.appendChild(host);

  // State
  let isPanelOpen = false;
  let stage: PipelineStage = 'idle';
  let discoveredSources: DiscoveredAudioSource[] = [];
  let lastResult: TranscriptionSuccessData | null = null;
  let activeView: 'processed' | 'raw' = 'processed';
  let streamStopController: AbortController | null = null;
  let copyResetTimer: number | null = null;

  // Draggable floating button: the fab (and the panel docked to it) can be
  // repositioned anywhere on the page instead of being pinned to the
  // bottom-right corner. Position is persisted so it survives page reloads.
  const DRAG_THRESHOLD_PX = 4;
  let dragPointerId: number | null = null;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragStartHostLeft = 0;
  let dragStartHostTop = 0;
  let didDrag = false;

  function clampHostPosition(left: number, top: number): FabPosition {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function applyHostPosition(position: FabPosition): void {
    host.style.left = `${position.left}px`;
    host.style.top = `${position.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  void loadFabPosition().then((saved) => {
    if (saved) {
      applyHostPosition(clampHostPosition(saved.left, saved.top));
    }
  });

  fab.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    dragPointerId = event.pointerId;
    didDrag = false;
    const rect = host.getBoundingClientRect();
    dragStartClientX = event.clientX;
    dragStartClientY = event.clientY;
    dragStartHostLeft = rect.left;
    dragStartHostTop = rect.top;
    fab.setPointerCapture(event.pointerId);
  });

  fab.addEventListener('pointermove', (event: PointerEvent) => {
    if (dragPointerId === null || event.pointerId !== dragPointerId) {
      return;
    }
    const deltaX = event.clientX - dragStartClientX;
    const deltaY = event.clientY - dragStartClientY;
    if (!didDrag && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) {
      return;
    }
    didDrag = true;
    fab.classList.add('is-dragging');
    applyHostPosition(clampHostPosition(dragStartHostLeft + deltaX, dragStartHostTop + deltaY));
  });

  function endFabDrag(event: PointerEvent): void {
    if (dragPointerId === null || event.pointerId !== dragPointerId) {
      return;
    }
    fab.releasePointerCapture(event.pointerId);
    dragPointerId = null;
    fab.classList.remove('is-dragging');
    if (didDrag) {
      const rect = host.getBoundingClientRect();
      saveFabPosition({ left: rect.left, top: rect.top });
    }
  }

  fab.addEventListener('pointerup', endFabDrag);
  fab.addEventListener('pointercancel', endFabDrag);

  window.addEventListener('resize', () => {
    // Only reclamp a previously dragged (explicitly positioned) widget.
    if (host.style.left && host.style.top) {
      const rect = host.getBoundingClientRect();
      applyHostPosition(clampHostPosition(rect.left, rect.top));
    }
  });

  function setPanelOpen(open: boolean): void {
    isPanelOpen = open;
    panel.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function populateSourceOptions(): DiscoveredAudioSource[] {
    discoveredSources = discoverAudioSources(document);
    const previousId = sourceSelect.value;
    sourceSelect.innerHTML = '';

    if (discoveredSources.length === 0) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = 'No audio elements or links found on page';
      sourceSelect.appendChild(emptyOpt);
      sourceSelect.disabled = true;
      return discoveredSources;
    }

    sourceSelect.disabled = false;
    discoveredSources.forEach((src) => {
      const opt = document.createElement('option');
      opt.value = src.id;
      const tag = src.isPlaying
        ? 'Playing'
        : src.kind === 'audio-element'
          ? 'Player'
          : 'Link';
      opt.textContent = `[${tag}] ${src.label}`;
      sourceSelect.appendChild(opt);
    });

    if (discoveredSources.some((s) => s.id === previousId)) {
      sourceSelect.value = previousId;
    }
    return discoveredSources;
  }

  function renderStatus(
    nextStage: PipelineStage,
    label: string,
    meta = '',
    error?: SerializedExtensionError
  ): void {
    stage = nextStage;
    statusBox.className = 'aat-status-box';
    statusBox.innerHTML = '';

    const isBusy =
      nextStage === 'locating' ||
      nextStage === 'reading' ||
      nextStage === 'recording' ||
      nextStage === 'transcribing' ||
      nextStage === 'post-processing';

    runBtn.disabled = isBusy;
    refreshBtn.disabled = isBusy;
    sourceSelect.disabled = isBusy || discoveredSources.length === 0;
    stopStreamBtn.style.display = nextStage === 'recording' ? 'inline-flex' : 'none';

    if (nextStage === 'error') {
      statusBox.classList.add('is-error');
      const main = document.createElement('div');
      main.className = 'aat-status-main';
      main.textContent = label;
      statusBox.appendChild(main);

      if (error?.details) {
        const detailEl = document.createElement('p');
        detailEl.className = 'aat-error-detail';
        detailEl.textContent = error.details;
        statusBox.appendChild(detailEl);
      }

      if (error?.code === 'MISSING_CONFIG') {
        const fixBtn = document.createElement('button');
        fixBtn.type = 'button';
        fixBtn.className = 'aat-btn';
        fixBtn.textContent = 'Open Settings';
        fixBtn.addEventListener('click', () => {
          void transport.openOptionsPage();
        });
        statusBox.appendChild(fixBtn);
      }
      return;
    }

    if (nextStage === 'done') {
      statusBox.classList.add('is-done');
    } else if (nextStage === 'recording') {
      statusBox.classList.add('is-recording');
    }

    const main = document.createElement('div');
    main.className = 'aat-status-main';

    if (isBusy) {
      const spinner = document.createElement('span');
      spinner.className = 'aat-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      main.appendChild(spinner);
    }

    const textSpan = document.createElement('span');
    textSpan.textContent = label;
    main.appendChild(textSpan);
    statusBox.appendChild(main);

    if (meta) {
      const metaEl = document.createElement('span');
      metaEl.className = 'aat-status-meta';
      metaEl.textContent = meta;
      statusBox.appendChild(metaEl);
    }
  }

  function updateTranscriptDisplay(): void {
    if (!lastResult) {
      transcriptArea.style.display = 'none';
      viewTabs.style.display = 'none';
      copyBtn.disabled = true;
      downloadBtn.disabled = true;
      return;
    }

    transcriptArea.style.display = 'block';
    const showTabs =
      lastResult.postProcessed &&
      lastResult.rawTranscript &&
      lastResult.rawTranscript !== lastResult.transcript;
    viewTabs.style.display = showTabs ? 'flex' : 'none';

    processedTabBtn.classList.toggle('is-active', activeView === 'processed');
    rawTabBtn.classList.toggle('is-active', activeView === 'raw');

    const text =
      activeView === 'raw' && lastResult.rawTranscript
        ? lastResult.rawTranscript
        : lastResult.transcript;

    transcriptArea.value = text || '(Empty transcript returned)';
    copyBtn.disabled = text.length === 0;
    downloadBtn.disabled = text.length === 0;
  }

  async function runTranscriptionPipeline(): Promise<void> {
    setPanelOpen(true);
    lastResult = null;
    activeView = 'processed';
    updateTranscriptDisplay();

    renderStatus('locating', 'Locating audio...');
    const sources = populateSourceOptions();

    if (sources.length === 0) {
      renderStatus(
        'error',
        'No audio found on this page.',
        '',
        {
          code: 'NO_AUDIO_FOUND',
          message: 'No audio found on this page.',
          details:
            'Looked for <audio> players and direct .mp3, .wav, .m4a, .ogg, .webm, or .flac links. Start playback if the player loads lazily, then click Rescan.',
        }
      );
      return;
    }

    const selected =
      sources.find((s) => s.id === sourceSelect.value) ?? sources[0];

    renderStatus('reading', 'Reading audio...', selected.label);
    streamStopController = new AbortController();

    let captured: CapturedAudioResult;
    try {
      const maxFileSizeMb = await transport.getMaxFileSizeMb();
      captured = await readAudioSource(selected, {
        maxFileSizeMb,
        streamStopSignal: streamStopController.signal,
        onStreamCaptureStarted: () => {
          renderStatus(
            'recording',
            'Recording live/MSE stream...',
            '0:00'
          );
        },
        onStreamProgress: (elapsedSeconds, collectedBytes) => {
          if (stage === 'recording') {
            renderStatus(
              'recording',
              'Recording live/MSE stream...',
              `${formatSeconds(elapsedSeconds)} · ${formatBytes(collectedBytes)}`
            );
          }
        },
      });
    } catch (error: unknown) {
      streamStopController = null;
      if (error instanceof AudioExtractionError) {
        renderStatus('error', error.message, '', {
          code: error.code,
          message: error.message,
          details: error.details,
        });
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        renderStatus('error', msg, '', {
          code: 'UNKNOWN',
          message: msg,
        });
      }
      return;
    }

    streamStopController = null;
    renderStatus(
      'transcribing',
      'Transcribing...',
      `${formatBytes(captured.byteLength)} · ${captured.captureMethod}`
    );

    try {
      const buffer = await captured.blob.arrayBuffer();
      const base64Data = arrayBufferToBase64(buffer);

      const response = await transport.transcribeAudio({
        base64Data,
        mimeType: captured.mimeType,
        filename: captured.filename,
        byteLength: captured.byteLength,
        captureMethod: captured.captureMethod,
        pageUrl: window.location.href,
      });

      if (!response.ok) {
        renderStatus('error', response.error.message, '', response.error);
        return;
      }

      lastResult = response.data;
      updateTranscriptDisplay();

      const latencySec = (response.data.latencyMs / 1000).toFixed(1);
      const summaryMeta = `${formatBytes(captured.byteLength)} · ${latencySec}s`;
      renderStatus('done', 'Done', summaryMeta);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      renderStatus('error', `Failed to send audio to background worker: ${msg}`, '', {
        code: 'UNKNOWN',
        message: msg,
      });
    }
  }

  // Wire event handlers
  fab.addEventListener('click', (event) => {
    if (didDrag) {
      // Suppress the click that follows a drag-release so dragging the fab
      // doesn't also toggle the panel open/closed.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!isPanelOpen) {
      setPanelOpen(true);
      populateSourceOptions();
      if (stage === 'idle') {
        void runTranscriptionPipeline();
      }
    } else {
      setPanelOpen(false);
    }
  });

  collapseBtn.addEventListener('click', () => {
    setPanelOpen(false);
  });

  settingsBtn.addEventListener('click', () => {
    void transport.openOptionsPage();
  });

  refreshBtn.addEventListener('click', () => {
    const found = populateSourceOptions();
    if (found.length > 0) {
      renderStatus('idle', `Found ${found.length} audio source${found.length === 1 ? '' : 's'}.`);
    } else {
      renderStatus('idle', 'No audio sources detected yet.');
    }
  });

  runBtn.addEventListener('click', () => {
    void runTranscriptionPipeline();
  });

  stopStreamBtn.addEventListener('click', () => {
    streamStopController?.abort();
  });

  processedTabBtn.addEventListener('click', () => {
    activeView = 'processed';
    updateTranscriptDisplay();
  });

  rawTabBtn.addEventListener('click', () => {
    activeView = 'raw';
    updateTranscriptDisplay();
  });

  copyBtn.addEventListener('click', () => {
    const text = transcriptArea.value;
    if (!text) {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied';
      if (copyResetTimer !== null) {
        window.clearTimeout(copyResetTimer);
      }
      copyResetTimer = window.setTimeout(() => {
        copyBtn.textContent = 'Copy Transcript';
      }, 2000);
    });
  });

  downloadBtn.addEventListener('click', () => {
    const text = transcriptArea.value;
    if (!text) {
      return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jobMatch = /^\/job\/([a-zA-Z0-9_-]+)/i.exec(window.location.pathname);
    const safeJobId = jobMatch?.[1] ? `praat-job-${jobMatch[1]}` : 'transcript';
    link.href = objectUrl;
    link.download = `${safeJobId}-${stamp}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  });

  // Initial source scan
  populateSourceOptions();
  renderStatus('idle', 'Ready to locate and transcribe page audio.');

  return {
    unmount: () => {
      streamStopController?.abort();
      if (copyResetTimer !== null) {
        window.clearTimeout(copyResetTimer);
      }
      host.remove();
    },
    refreshSources: () => {
      populateSourceOptions();
    },
  };
}

function isTargetJobUrl(pathname: string): boolean {
  return /^\/job\/[^/]+/i.test(pathname);
}

/**
 * Watches client-side SPA navigation (history.pushState / popstate) on praat.ai
 * so the floating Transcribe button mounts automatically when navigating to /job/[GUID]
 * without requiring a full browser reload, and unmounts when leaving /job/*.
 */
function initExtensionAutoMount(): void {
  let activeController: MountedTranscriberController | null = null;
  let lastPathname = '';

  const syncMountForCurrentRoute = (): void => {
    const currentPath = window.location.pathname;
    if (currentPath === lastPathname && activeController !== null) {
      return;
    }
    lastPathname = currentPath;

    if (isTargetJobUrl(currentPath)) {
      if (!activeController && document.body) {
        activeController = mountTranscriberOverlay(chromeRuntimeTransport);
      } else {
        activeController?.refreshSources();
      }
    } else if (activeController) {
      activeController.unmount();
      activeController = null;
    }
  };

  syncMountForCurrentRoute();

  window.addEventListener('popstate', syncMountForCurrentRoute);
  window.addEventListener('hashchange', syncMountForCurrentRoute);

  // Content scripts live in an isolated world so patching window.history wouldn't intercept
  // the host page's own SPA router calls; a lightweight 750ms pathname check handles React/Next.js pushState cleanly.
  window.setInterval(() => {
    if (window.location.pathname !== lastPathname) {
      syncMountForCurrentRoute();
    }
  }, 750);
}

// Auto-mount only when executing inside a real Chrome Extension content script context.
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtensionAutoMount);
  } else {
    initExtensionAutoMount();
  }
}
