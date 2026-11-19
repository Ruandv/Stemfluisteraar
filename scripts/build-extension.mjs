import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const iconsDir = path.join(distDir, 'icons');
const iconSourcePath = path.join(rootDir, 'assets/extension-icon.svg');

async function main() {
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });

  // 1. Bundle MV3 Service Worker as ESM (matches "type": "module" in manifest.json)
  await build({
    entryPoints: [path.join(rootDir, 'src/extension/background.ts')],
    outfile: path.join(distDir, 'background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  // 2. Bundle Content Script as IIFE (Chrome content scripts run as classic scripts, not ESM)
  await build({
    entryPoints: [path.join(rootDir, 'src/extension/content.ts')],
    outfile: path.join(distDir, 'content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  // 3. Bundle Options Page Script as IIFE
  await build({
    entryPoints: [path.join(rootDir, 'src/extension/options.ts')],
    outfile: path.join(distDir, 'options.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  // 4. Copy static extension manifest and options HTML
  fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  fs.copyFileSync(
    path.join(rootDir, 'src/extension/options.html'),
    path.join(distDir, 'options.html')
  );

  // 5. Render the source illustration at the exact sizes required by manifest.json
  await Promise.all(
    [16, 48, 128].map((size) =>
      sharp(iconSourcePath)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, `icon${size}.png`))
    )
  );

  console.log('Chrome extension unpacked build complete -> dist/');
}

main().catch((error) => {
  console.error('Extension build failed:', error);
  process.exit(1);
});
