# Stemfluisteraar — Azure Audio Transcriber

Stemfluisteraar ("Voice Whisperer") is a Manifest V3 browser extension that discovers audio on a matching page, sends it to an Azure OpenAI or Microsoft Foundry audio transcription deployment, and displays the resulting transcript. It can optionally send the transcript to a second Azure chat deployment for punctuation, cleanup, translation, or summarization.

> The extension currently targets `https://praat.ai/*` and `https://www.praat.ai/*`. The transcription interface is shown on Praat job pages.

## Features

- Audio discovery and transcription on supported web pages
- Azure OpenAI deployment-scoped and `/openai/v1` URL patterns
- Optional post-processing with a separate chat deployment
- Language hints and configurable audio-size limits
- A built-in Azure connection test
- Local extension settings using `chrome.storage.local`
- 16 px, 48 px, and 128 px extension icons generated from an SVG source

## Requirements

- Node.js 20 or later and npm
- Google Chrome or Microsoft Edge
- An Azure subscription
- An Azure OpenAI resource, or a Microsoft Foundry project with a compatible Azure OpenAI resource
- At least one deployed audio transcription model, such as:
  - `gpt-4o-transcribe`
  - `gpt-4o-mini-transcribe`
  - `whisper`

Optional transcript post-processing also requires a deployed chat model such as `gpt-4o-mini`.

## Build and load the extension

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Build the extension:

   ```powershell
   npm run build
   ```

   This creates the unpacked extension in `dist/`.

3. Open the browser extension page:

   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`

4. Enable **Developer mode**.

5. Choose **Load unpacked** and select the `dist` directory.

6. Open the extension's options:

   - Select **Details**, then **Extension options**, or
   - Click the extension icon, which opens the options page.

To rebuild only the extension bundle and icons, run:

```powershell
npm run build:extension
```

## Quick configuration

The minimum required settings are:

| Extension field | What to enter | Example |
| --- | --- | --- |
| Azure Resource Endpoint URL | Resource base URL only | `https://my-resource.openai.azure.com` |
| Transcription Deployment / Model | The exact deployment name | `gpt-4o-transcribe` |
| URL Pattern | `Auto` unless Azure gave you a specific URL style | `Auto` |
| API Version | The version expected by your endpoint | `2024-10-21` |
| Azure API Key | Key 1 or Key 2 for the resource | Not shown |

Example configuration:

```text
Endpoint:    https://contoso-audio.openai.azure.com
Deployment:  audio-transcription
URL Pattern: Auto
API Version: 2024-10-21
API Key:     <copied from Keys and Endpoint>
```

The resolved request will look similar to:

```text
https://contoso-audio.openai.azure.com/openai/deployments/audio-transcription/audio/transcriptions?api-version=2024-10-21
```

Save the settings, select **Test Connection**, and wait for the extension to confirm the transcription endpoint.

## Where to get each Azure value

### 1. Endpoint URL

The endpoint identifies the Azure OpenAI resource that owns the deployment.

#### From the Azure portal

1. Open [the Azure portal](https://portal.azure.com/).
2. Search for and open your **Azure OpenAI** resource.
3. In the left menu, select **Keys and Endpoint** under **Resource Management**.
4. Copy the value labeled **Endpoint**.

It normally resembles:

```text
https://<resource-name>.openai.azure.com/
```

Paste only the base URL into the extension. A trailing slash is removed automatically. The extension also strips accidental `/openai`, `/openai/v1`, and `/openai/v1/audio/transcriptions` suffixes.

#### From Microsoft Foundry

1. Open [Microsoft Foundry](https://ai.azure.com/).
2. Select the project that contains the audio deployment.
3. Open **Deployments** or **Models + endpoints**.
4. Select the transcription deployment.
5. Copy its **Endpoint** or open a generated code sample and copy the Azure OpenAI base endpoint.

For this extension, prefer an endpoint whose base host is an Azure OpenAI-compatible resource endpoint, for example:

```text
https://<resource-name>.openai.azure.com
```

Do not confuse the resource endpoint with:

- A complete request URL containing `/openai/deployments/...`
- A project management endpoint ending in `/api/projects/...`
- A deployment playground URL
- The model catalog page URL

The extension appends the audio API path itself.

### 2. Transcription deployment or model name

The deployment name is the **name assigned when the model was deployed**, not necessarily the underlying model's published name.

For example, the deployed model can be `gpt-4o-transcribe` while the deployment name is:

```text
production-audio
```

In that case, enter `production-audio` in **Transcription Deployment / Model**.

#### Locate an existing deployment

In **Microsoft Foundry**:

1. Open the project.
2. Select **Deployments** or **Models + endpoints**.
3. Open the model that supports audio transcription.
4. Copy the value in the **Deployment name** column.

In the **Azure portal**, open the Azure OpenAI resource and select **Model deployments**, then select **Manage Deployments in Microsoft Foundry portal** if needed.

#### Create a transcription deployment

1. In Microsoft Foundry, open the desired project.
2. Open **Model catalog**.
3. Search for a supported audio model such as `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, or `whisper`.
4. Select **Deploy** or **Use this model**.
5. Choose a deployment name you will recognize.
6. Select a region in which the model is available and choose an appropriate deployment capacity.
7. Complete the deployment.
8. Copy the exact **deployment name** into the extension.

Model and region availability can vary by subscription and can change over time. If a model is unavailable, choose another supported transcription model or another allowed region.

### 3. API version

The API version is sent as the `api-version` query parameter for deployment-scoped requests.

Use the API version shown by Microsoft in the code sample or REST reference for your chosen endpoint style:

1. Open the deployment in Microsoft Foundry.
2. Open **Code** or **Sample code**.
3. Select a REST or OpenAI SDK sample.
4. Find the `api-version` value in the generated URL or client configuration.
5. Copy that date string into the extension.

The extension defaults to `2025-03-01-preview`. A currently documented transcription REST example also uses:

```text
2024-10-21
```

Use the version returned for your deployment by the portal rather than assuming one is universally compatible. If the portal's generated sample uses a different supported version, use that version.

For `/openai/v1` mode, the extension intentionally omits the query-string `api-version` because the v1-compatible route handles version selection separately.

### 4. API key

The API key authenticates the extension request to the Azure resource.

#### Azure portal

1. Open the Azure OpenAI resource.
2. Select **Keys and Endpoint**.
3. Reveal and copy **KEY 1** or **KEY 2**.

The two keys provide the same access. Either one works. Having two keys allows rotation without downtime.

#### Microsoft Foundry

Use the linked Azure OpenAI resource shown in the project's endpoint or deployment details:

1. Open the deployment details.
2. Follow the parent or connected Azure resource link.
3. In the Azure portal, select **Keys and Endpoint**.
4. Copy Key 1 or Key 2.

Some Foundry experiences also display credentials directly in the deployment's code sample or endpoint details. Only copy a key belonging to the same resource as the endpoint.

> Security note: The extension stores the key in `chrome.storage.local` on the current browser profile. Anyone with access to that profile or the unpacked extension may be able to retrieve it. Never commit the key, place it in `manifest.json`, publish it in a screenshot, or paste it into an issue. Rotate the key in Azure if it is exposed.

This browser extension requires an API key. Microsoft Entra token authentication is not currently supported by the settings page.

## URL pattern settings

### Auto (recommended)

`Auto` selects the request format based on **API Version**:

- A non-empty API version builds a deployment-scoped URL.
- A blank API version, or the literal value `v1`, builds an `/openai/v1` URL.

Deployment-scoped URL:

```text
{endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={apiVersion}
```

v1 URL:

```text
{endpoint}/openai/v1/audio/transcriptions
```

For v1 mode, the extension still sends the configured deployment/model name in the multipart request's `model` field.

### Deployment

Always builds:

```text
{endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={apiVersion}
```

Use this when the generated Azure REST sample contains `/openai/deployments/`.

### OpenAI v1

Always builds:

```text
{endpoint}/openai/v1/audio/transcriptions
```

Use this only when the endpoint and deployment are exposed through Azure's OpenAI-compatible v1 route. Enter the exact transcription deployment/model name in the deployment field because it is sent in the `model` request field.

## Optional settings

### Language hint

Enter an ISO-639-1 language code to improve recognition speed and accuracy:

| Value | Language |
| --- | --- |
| `en` | English |
| `es` | Spanish |
| `de` | German |
| `fr` | French |
| `ja` | Japanese |
| `nl` | Dutch |

Leave this field blank for automatic language detection.

### Maximum audio size

The default is `25` MB. The extension rejects audio larger than the configured value before sending it to Azure.

The Azure model/service limit may be lower or differ by model. If Azure returns a file-size error, check the model's current limit and reduce this setting or use a shorter audio file.

## Optional transcript post-processing

Post-processing performs a second request after transcription. It can clean punctuation, summarize, translate, or extract actions.

| Extension field | Description |
| --- | --- |
| Enable post-processing | Turns on the second Azure chat request |
| Chat / LLM Deployment | Exact deployment name for a chat-capable model |
| Chat API Version | API version for the chat deployment request |
| Post-Processing System Prompt | Instructions for how to transform the transcript |

The chat deployment:

- Must exist on the same resource endpoint as the transcription deployment
- Must support chat completions
- Must be entered by its deployment name, not by a model family name
- Uses the same API key and endpoint as transcription

Example:

```text
Chat Deployment:   meeting-gpt-mini
Chat API Version:  2024-10-21
```

The resolved chat request is:

```text
{endpoint}/openai/deployments/meeting-gpt-mini/chat/completions?api-version=2024-10-21
```

If v1 mode is selected, it becomes:

```text
{endpoint}/openai/v1/chat/completions
```

## Test the configuration

In the options page, select **Test Connection**. The extension sends a generated 0.5-second silent WAV file to the transcription endpoint. A successful test may return an empty transcript because the sample contains no speech; the endpoint is still valid.

If post-processing is enabled, the extension also sends a minimal `Reply with OK.` request to the configured chat deployment.

The result displays:

- The final resolved transcription URL
- Transcription latency
- The response preview
- The chat URL and latency when post-processing is tested

## Troubleshooting

### `401` or authentication error

- Confirm the API key belongs to the same resource as the endpoint.
- Verify no extra spaces or hidden characters were pasted.
- Try the other key from **Keys and Endpoint**.
- Confirm key-based authentication is enabled for the resource.

### `404` or resource/deployment not found

- Confirm the deployment name exactly, including case, hyphens, and spaces.
- Do not enter the underlying model name unless it is also the deployment name.
- Confirm the endpoint and deployment are in the same Azure resource/project.
- Compare the resolved URL preview with the Azure portal's sample request.

### `400` invalid API version or operation not supported

- Copy the API version from the deployment's generated code sample.
- Try the portal-documented deployment-scoped version `2024-10-21`.
- Select **Deployment** or **OpenAI v1** explicitly if `Auto` chose the wrong URL style.
- Confirm that the deployed model supports audio transcription.

### `429` rate-limit or quota error

- Wait and retry.
- Check the deployment's capacity and quota in Microsoft Foundry.
- Reduce concurrent requests.
- Deploy additional capacity where available.

### Network, CORS, or timeout error

- Confirm the endpoint uses `https://` and is reachable from the browser.
- Confirm the endpoint host is included in the extension's `host_permissions`.
- Check private endpoint, firewall, DNS, and virtual-network restrictions.
- Keep the browser window open while the test runs.

The extension sends Azure requests from its background service worker, not directly from the Praat page, to avoid page-origin CORS restrictions.

### Audio is too large

- Lower the selected source duration.
- Increase **Max Audio Size** only when the Azure model supports it.
- Split the recording into smaller clips.

### No audio/transcription controls appear

- Confirm you are on `https://praat.ai/*` or `https://www.praat.ai/*`.
- Confirm the page contains a job GUID path.
- Reload the page after installing or updating the extension.
- Reload the extension from the browser extension page.

## Development

Run the web project locally:

```powershell
npm run dev
```

Type-check the project:

```powershell
npm run lint
```

Build the web application and extension:

```powershell
npm run build
```

Build only the Chrome/Edge extension:

```powershell
npm run build:extension
```

## Project structure

```text
assets/
  extension-icon.svg          Icon source artwork
scripts/
  build-extension.mjs         Extension bundling and icon generation
src/
  extension/
    azure.ts                  Azure URL construction and requests
    background.ts             Manifest V3 service worker
    content.ts                Page audio UI and transcription pipeline
    options.ts                Settings page behavior
    options.html              Settings page
    storage.ts                Defaults, validation, and local storage
manifest.json                 Extension permissions and entry points
dist/                         Build output; load this directory unpacked
```

## Official Microsoft references

- [Azure OpenAI speech-to-text quickstart](https://learn.microsoft.com/azure/foundry/openai/whisper-quickstart)
- [Azure OpenAI REST API reference](https://learn.microsoft.com/azure/foundry/openai/reference#transcriptions---create)
- [Azure OpenAI v1 preview REST reference](https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview-latest?view=foundry-classic#create-transcription)
- [Azure OpenAI supported audio models](https://learn.microsoft.com/azure/ai-foundry/openai/concepts/models#audio-models)
- [Authenticate requests to Azure AI services](https://learn.microsoft.com/azure/ai-services/authentication)

API versions, model availability, endpoint behavior, and supported regions can change. When documentation and the generated code sample for a deployed model differ, prefer the version and URL shown in that deployment's current sample code.
