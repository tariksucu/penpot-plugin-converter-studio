// Builds the plugin into dist/: the files that are hosted together, next to each other, at
// https://converter.studio/integrations/penpot/ (or wherever the manifest is served from).
//
//   node build.mjs                          for converter.studio (API: https://converter.studio/api)
//   node build.mjs --api <url> [--out dir]  a development build against another API (a local one)
//   node build.mjs --api <url> --serve [--port 4400]
//                                           the same, served on 127.0.0.1 with the CORS header
//                                           Penpot needs, to load http://localhost:<port>/manifest.json
//                                           in Penpot's plugin manager
//
// Nothing in dist/ names its own address: the manifest is version 2, so Penpot resolves
// `plugin.js`, `icon.png` and the panel (`index.html`) from wherever the manifest is. The API's
// address is the one setting, `__API_BASE__` in ui.js (and the page's `connect-src`).
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
export const PRODUCTION_API = 'https://converter.studio/api';
/** Penpot's manifest schema (plugins-runtime, manifest.schema.ts) caps the description. */
const MAX_DESCRIPTION = 200;
/** What the plugin may ask Penpot for (and does: see src/plugin/plugin.ts). */
const PERMISSIONS = ['content:read', 'content:write', 'allow:downloads'];

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  // Readable for anyone who looks: bundled and transpiled, not minified, no source map.
  minify: false,
  legalComments: 'inline',
  logLevel: 'warning',
};

/** Builds into `out` (default dist/) against `api` (default production's). */
export async function build({ api = PRODUCTION_API, out = 'dist' } = {}) {
  const apiBase = api.replace(/\/$/, '');
  const dist = resolve(root, out);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: ['src/plugin/index.ts'],
    outfile: join(dist, 'plugin.js'),
    // Penpot evaluates plugin.js in its sandbox (a SES compartment): no DOM, no network.
    platform: 'neutral',
  });
  await esbuild.build({
    ...common,
    entryPoints: ['src/ui/main.ts'],
    outfile: join(dist, 'ui.js'),
    platform: 'browser',
    define: { __API_BASE__: JSON.stringify(apiBase) },
  });
  const html = await readFile(join(root, 'public/index.html'), 'utf8');
  await writeFile(
    join(dist, 'index.html'),
    html.replace('__CONNECT_SRC__', new URL(apiBase).origin),
  );
  for (const file of ['styles.css', 'icon.png'])
    await copyFile(join(root, 'public', file), join(dist, file));
  const manifest = JSON.parse(await readFile(join(root, 'public/manifest.json'), 'utf8'));
  checkManifest(manifest);
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await checkDist(dist, apiBase);
  return { dist, apiBase };
}

/** The manifest as Penpot's runtime validates it, and nothing more than the plugin needs. */
export function checkManifest(manifest) {
  const problems = [];
  if (manifest.version !== 2) problems.push('version must be 2 (relative paths)');
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('no name');
  if (typeof manifest.description !== 'string' || manifest.description.length > MAX_DESCRIPTION)
    problems.push(`description must be a text of ${MAX_DESCRIPTION} characters at most`);
  if (manifest.code !== 'plugin.js' || manifest.icon !== 'icon.png')
    problems.push('code and icon must be plugin.js and icon.png');
  const asked = manifest.permissions ?? [];
  if (!Array.isArray(asked) || asked.some((p) => !PERMISSIONS.includes(p)))
    problems.push(`permissions beyond ${PERMISSIONS.join(', ')}`);
  if ('scope' in manifest) problems.push('no scope: the plugin works in the workspace only');
  if (problems.length) throw new Error(`manifest.json: ${problems.join('; ')}`);
}

/** No local address, source map, code from strings or key in what is hosted. */
async function checkDist(dist, apiBase) {
  const production = apiBase === PRODUCTION_API;
  const plugin = await readFile(join(dist, 'plugin.js'), 'utf8');
  const ui = await readFile(join(dist, 'ui.js'), 'utf8');
  const problems = [];
  for (const [name, code] of [
    ['plugin.js', plugin],
    ['ui.js', ui],
  ]) {
    for (const [pattern, what] of [
      [/sourceMappingURL/, 'a source map reference'],
      [/\beval\s*\(|new Function\s*\(/, 'code built from strings'],
      [/cvs_live_[A-Za-z0-9]{32}/, 'an API key'],
      ...(production ? [[/localhost|127\.0\.0\.1|\[::1\]/, 'a local address']] : []),
    ])
      if (pattern.test(code)) problems.push(`${name} has ${what}`);
  }
  // The sandbox has none of these: plugin.js would fail when Penpot runs it.
  for (const name of ['window', 'document', 'localStorage', 'XMLHttpRequest', 'TextDecoder'])
    if (new RegExp(`\\b${name}\\b`).test(plugin)) problems.push(`plugin.js uses ${name}`);
  if (/\bfetch\s*\(/.test(plugin)) problems.push('plugin.js calls fetch');
  if (production && !ui.includes(PRODUCTION_API)) problems.push('ui.js lacks the production API');
  if (problems.length) throw new Error(problems.join('; '));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/** dist/ on 127.0.0.1, with the headers converter.studio must send too (see the README). */
function serve(dist, apiBase, port) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const file = normalize(join(dist, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(dist + sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        // Penpot's page fetches manifest.json and plugin.js from its own origin.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`Serving ${dist} at http://localhost:${port}/manifest.json (API: ${apiBase})`),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      api: { type: 'string' },
      out: { type: 'string' },
      serve: { type: 'boolean', default: false },
      port: { type: 'string', default: '4400' },
    },
  });
  const { dist, apiBase } = await build({ api: args.api, out: args.out });
  console.log(`Built ${dist} (API: ${apiBase})`);
  if (args.serve) serve(dist, apiBase, Number(args.port));
}
