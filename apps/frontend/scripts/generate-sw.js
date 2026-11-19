/**
 * Post-build step: emit dist/sw.js from scripts/sw-template.js.
 *
 * No dependencies (no Workbox). Reads the hashed asset URLs Vite emitted into
 * dist/index.html, precaches the app shell, and stamps a build id derived from
 * the precache list so an unchanged rebuild produces a byte-identical worker.
 *
 * The frontend package is `"type": "module"`, so this script is ESM.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');

const html = await readFile(path.join(dist, 'index.html'), 'utf8');

const assetRe = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g;
const assets = [...new Set([...html.matchAll(assetRe)].map((m) => m[1]))];

if (assets.length === 0) {
  // STOP condition 1: without hashed assets the shell cannot be invalidated.
  throw new Error('generate-sw: no hashed /assets/*.js|css references found in dist/index.html');
}

const precache = ['/', '/index.html', ...assets, '/manifest.webmanifest', '/favicon.svg'];
const buildId = createHash('sha256').update(JSON.stringify(precache)).digest('hex').slice(0, 16);

const template = await readFile(path.join(root, 'sw-template.js'), 'utf8');
const sw = template.replace('__PRECACHE__', JSON.stringify(precache)).replace('__BUILD__', buildId);

await writeFile(path.join(dist, 'sw.js'), sw);

console.log(`generate-sw: wrote dist/sw.js (build ${buildId}, ${precache.length} precached URLs)`);
