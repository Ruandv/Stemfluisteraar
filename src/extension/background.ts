import {
  AzureClientError,
  base64ToUint8Array,
  testAzureConnection,
  transcribeWithAzure,
} from './azure';
import { loadSettings } from './storage';
import {
  ExtensionMessage,
  SerializedExtensionError,
  SimpleActionResponse,
  TestConnectionResponse,
  TranscribeAudioPayload,
  TranscribeAudioResponse,
} from './types';

/**
 * Manifest V3 Service Worker Architecture Notes:
 *
 * 1. Service Worker Lifecycle:
 *    MV3 background scripts run as ephemeral Service Workers rather than persistent background pages.
 *    Chrome suspends the worker after ~30 seconds of inactivity, wiping all in-memory variables.
 *    Therefore, Azure settings are ALWAYS loaded fresh from `chrome.storage.local` on each request.
 *
 * 2. CORS & Host Permissions:
 *    Content scripts execute inside the host page's security origin, so calling
 *    `https://*.openai.azure.com` directly from `content.ts` would fail CORS preflight checks
 *    unless Azure explicitly whitelisted that third-party website.
 *    Routing requests through this Service Worker leverages `"host_permissions"` in `manifest.json`,
 *    which allows cross-origin `fetch()` calls to Azure endpoints without host page CORS restrictions.
 *
 * 3. `chrome.runtime.onMessage` Async `return true`:
 *    The `onMessage` listener itself MUST remain synchronous (never mark the outer callback `async`).
 *    Returning `true` synchronously tells Chrome to keep the IPC message port open until
 *    `sendResponse(...)` resolves asynchronously; omitting `return true` closes the channel immediately
 *    and leaves the caller with `undefined`.
 */

function toSerializedError(error: unknown): SerializedExtensionError {
  if (error instanceof AzureClientError) {
    return error.toSerialized();
  }
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: error.message,
    };
  }
  return {
    code: 'UNKNOWN',
    message: String(error),
  };
}

async function handleTranscribeAudio(
  payload: TranscribeAudioPayload
): Promise<TranscribeAudioResponse> {
  try {
    const settings = await loadSettings();
    // Content scripts encode binary audio as Base64 because Chrome's runtime messaging
    // uses JSON serialization under the hood (Blob/ArrayBuffer instances become `{}`).
    const bytes = base64ToUint8Array(payload.base64Data);

    const data = await transcribeWithAzure(
      {
        bytes,
        mimeType: payload.mimeType,
        filename: payload.filename,
      },
      settings
    );

    return { ok: true, data };
  } catch (error: unknown) {
    return {
      ok: false,
      error: toSerializedError(error),
    };
  }
}

async function handleTestConnection(
  settings: Parameters<typeof testAzureConnection>[0]
): Promise<TestConnectionResponse> {
  try {
    const data = await testAzureConnection(settings);
    return { ok: true, data };
  } catch (error: unknown) {
    return {
      ok: false,
      error: toSerializedError(error),
    };
  }
}

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (
      response: TranscribeAudioResponse | TestConnectionResponse | SimpleActionResponse
    ) => void
  ): boolean => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'TRANSCRIBE_AUDIO') {
      void handleTranscribeAudio(message.payload).then(sendResponse);
      // MUST return true synchronously to keep the message channel open for async sendResponse.
      return true;
    }

    if (message.type === 'TEST_AZURE_CONNECTION') {
      void handleTestConnection(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'OPEN_OPTIONS_PAGE') {
      chrome.runtime
        .openOptionsPage()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({ ok: false, error: toSerializedError(error) })
        );
      return true;
    }

    return false;
  }
);
