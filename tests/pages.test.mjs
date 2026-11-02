import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from '../scripts/build.mjs';
import { createStaticServer } from '../scripts/serve.mjs';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const prefix = '/checksum-rush/';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'checksum-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true });
  return root;
}

async function serve(t, directory, basePath = prefix) {
  const server = createStaticServer({ directory, basePath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('project builds normalize their mount path and give each deployment path its own identity', async t => {
  const root = await fixture(t);
  const rootBuild = await build({ root });
  const projectBuild = await build({ root, basePath: '/checksum-rush' });
  assert.notEqual(projectBuild.buildId, rootBuild.buildId);
  assert.equal((await build({ root, basePath: prefix })).buildId, projectBuild.buildId);
  assert.notEqual((await build({ root, basePath: '/another-game/' })).buildId, projectBuild.buildId);
});

test('Pages output prefixes entry assets and the 404 home link and disables Jekyll', async t => {
  const root = await fixture(t);
  const { buildId, directory } = await build({ root, basePath: prefix });
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  assert.ok(html.includes(`src="/checksum-rush/assets/${buildId}/app.js"`));
  assert.ok(html.includes(`href="/checksum-rush/assets/${buildId}/styles/components.css"`));
  assert.ok((await readFile(path.join(directory, '404.html'), 'utf8')).includes('href="/checksum-rush/"'));
  assert.equal(await readFile(path.join(directory, '.nojekyll'), 'utf8'), '');
});

test('unsafe mount paths are rejected before build output is changed or a server is created', async t => {
  const root = await fixture(t);
  const { directory } = await build({ root });
  const original = await readFile(path.join(directory, 'index.html'), 'utf8');
  for (const basePath of ['', 'checksum-rush/', '//checksum-rush/', '/a//b/', '/a/../b/', '/a/./b/', '/a?x=1/', '/a#b/', '/a\\b/', '/%2e%2e/', '/a%2fb/', '/a\0b/']) {
    await assert.rejects(build({ root, basePath }), /base path/i, basePath);
    assert.throws(() => createStaticServer({ directory, basePath }), /base path/i, basePath);
  }
  assert.equal(await readFile(path.join(directory, 'index.html'), 'utf8'), original);
});

test('the build CLI accepts the Pages base path and rejects an incomplete option', async t => {
  const root = await fixture(t);
  const script = path.join(repository, 'scripts/build.mjs');
  await run(process.execPath, [script, '--base', prefix], { cwd: root });
  assert.match(await readFile(path.join(root, 'dist/index.html'), 'utf8'), /src="\/checksum-rush\/assets\/[a-f0-9]+\/app\.js"/);
  await assert.rejects(run(process.execPath, [script, '--base'], { cwd: root }), /Unknown or incomplete option/);
});

test('a new build retains previous immutable graphs while its entry and version identify the current deployment', async t => {
  const root = await fixture(t);
  const first = await build({ root, basePath: prefix });
  const previousDirectory = path.join(root, 'previous');
  await cp(first.directory, previousDirectory, { recursive: true });
  await mkdir(path.join(previousDirectory, 'assets/not-a-build'), { recursive: true });
  await writeFile(path.join(previousDirectory, 'assets/not-a-build/unrelated.txt'), 'Do not publish unrelated files');
  const oldApp = await readFile(path.join(first.directory, 'assets', first.buildId, 'app.js'), 'utf8');
  await writeFile(path.join(root, 'src/app.js'), oldApp + '\n// Next deployment.\n');
  const current = await build({ root, basePath: prefix, previousDirectory });
  assert.notEqual(current.buildId, first.buildId);
  assert.equal(await readFile(path.join(current.directory, 'assets', first.buildId, 'app.js'), 'utf8'), oldApp);
  assert.equal(await readFile(path.join(current.directory, 'assets', current.buildId, 'app.js'), 'utf8'), oldApp + '\n// Next deployment.\n');
  assert.ok((await readFile(path.join(current.directory, 'index.html'), 'utf8')).includes(`/checksum-rush/assets/${current.buildId}/app.js`));
  assert.equal(JSON.parse(await readFile(path.join(current.directory, 'version.json'), 'utf8')).buildId, current.buildId);
  await assert.rejects(readFile(path.join(current.directory, 'assets/not-a-build/unrelated.txt')), { code: 'ENOENT' });
  const origin = await serve(t, current.directory);
  for (const id of [first.buildId, current.buildId]) {
    for (const name of ['app.js', 'domain/engine.js', 'data/missions.json']) assert.equal((await fetch(`${origin}${prefix}assets/${id}/${name}`)).status, 200);
  }
});

test('the build CLI retains a supplied previous artifact', async t => {
  const root = await fixture(t);
  const previous = await build({ root, basePath: prefix });
  const previousDirectory = path.join(root, 'previous');
  await cp(previous.directory, previousDirectory, { recursive: true });
  await writeFile(path.join(root, 'src/new-release.txt'), 'Current release');
  await run(process.execPath, [path.join(repository, 'scripts/build.mjs'), '--base', prefix, '--previous', previousDirectory], { cwd: root });
  assert.ok((await readFile(path.join(root, 'dist/assets', previous.buildId, 'app.js'), 'utf8')).includes('ChecksumApp'));
  const currentId = JSON.parse(await readFile(path.join(root, 'dist/version.json'), 'utf8')).buildId;
  assert.notEqual(currentId, previous.buildId);
  assert.equal(await readFile(path.join(root, 'dist/assets', currentId, 'new-release.txt'), 'utf8'), 'Current release');
});

test('retaining previous graphs refuses directory links before replacing a valid output', async t => {
  const root = await fixture(t);
  const { directory } = await build({ root, basePath: prefix });
  const previousDirectory = path.join(root, 'previous');
  await cp(directory, previousDirectory, { recursive: true });
  const original = await readFile(path.join(directory, 'index.html'), 'utf8');
  const { buildId } = JSON.parse(await readFile(path.join(previousDirectory, 'version.json'), 'utf8'));
  await symlink(path.join(root, 'src'), path.join(previousDirectory, 'assets', buildId, 'linked'), 'junction');
  await assert.rejects(build({ root, basePath: prefix, previousDirectory }), /link/i);
  assert.equal(await readFile(path.join(directory, 'index.html'), 'utf8'), original);
});

test('the mounted preview serves the complete relative module and stylesheet graph', async t => {
  const root = await fixture(t);
  const { buildId, directory } = await build({ root, basePath: prefix });
  const origin = await serve(t, directory);
  const page = await fetch(origin + prefix);
  assert.equal(page.status, 200);
  const html = await page.text();
  const pending = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(url => url.startsWith('/'));
  const visited = new Set();
  while (pending.length) {
    const url = new URL(pending.pop(), origin);
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    assert.ok(url.pathname.startsWith(`/checksum-rush/assets/${buildId}/`), url.href);
    const response = await fetch(url);
    assert.equal(response.status, 200, url.href);
    assert.match(response.headers.get('cache-control'), /immutable/);
    const source = await response.text();
    for (const match of source.matchAll(/\b(?:import\s+(?:[^'";]*?\sfrom\s*)?|@import\s*)['"]([^'"]+)['"]/g)) pending.push(new URL(match[1], url).href);
  }
  for (const name of ['app.js', 'services/missions.js', 'domain/engine.js', 'styles/tokens.css', 'styles/base.css']) {
    assert.ok(visited.has(`${origin}/checksum-rush/assets/${buildId}/${name}`), name);
  }
});

test('mounted preview redirects its bare prefix, isolates other paths, and preserves local cache and HEAD semantics', async t => {
  const root = await fixture(t);
  const { buildId, directory } = await build({ root, basePath: prefix });
  const origin = await serve(t, directory);
  const redirect = await fetch(`${origin}/checksum-rush?mode=arcade`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/checksum-rush/?mode=arcade');
  for (const name of ['', 'index.html', 'version.json', '404.html']) {
    const response = await fetch(origin + prefix + name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const head = await fetch(`${origin}${prefix}assets/${buildId}/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('cache-control'), /immutable/);
  assert.equal(await head.text(), '');
  for (const url of ['/', '/version.json', `/assets/${buildId}/app.js`, '/checksum-rush-other/', '/checksum-rush/guide', `/checksum-rush/assets/${buildId}/missing.js`]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(`${origin}${prefix}..%2fversion.json`)).status, 403);
  assert.equal((await fetch(`${origin}${prefix}assets/${buildId}/..%2f..%2fversion.json`)).status, 403);
  assert.equal((await fetch(`${origin}${prefix}assets%5capp.js`)).status, 400);
});

test('the preview CLI mounts the same project prefix', async t => {
  const root = await fixture(t);
  const { directory } = await build({ root, basePath: prefix });
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(repository, 'scripts/serve.mjs'), '--directory', directory, '--base', prefix, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { child.kill(); });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.stderr.on('data', chunk => reject(new Error(String(chunk))));
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Preview exited with ${code}`)));
  });
  assert.equal((await fetch(origin + prefix)).status, 200);
  assert.equal((await fetch(origin + '/')).status, 404);
});

test('the executing app requests version and mission data inside the Pages project prefix', async t => {
  const root = await fixture(t);
  const { buildId, directory } = await build({ root, basePath: prefix });
  const origin = await serve(t, directory);
  // Execute the real HTTP module graph with browser import.meta URLs. The small
  // DOM boundary permits construction; screen rendering is verified separately.
  const script = `
    import { SourceTextModule, createContext } from 'node:vm';
    const [appURL, pageURL] = process.argv.slice(1);
    const requests = [];
    const node = { content: 'loaded-build', addEventListener() {}, setAttribute() {} };
    const window = { addEventListener() {}, removeEventListener() {} };
    const document = { querySelector: () => node, addEventListener() {} };
    const context = createContext({ URL, AbortController, DOMException, setTimeout, clearTimeout,
      location: { href: pageURL, origin: new URL(pageURL).origin }, window, document,
      fetch: (url, options) => { requests.push(String(url)); return fetch(url, options); } });
    const modules = new Map();
    function load(url) {
      if (!modules.has(url)) modules.set(url, (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Module unavailable: ' + url);
        return new SourceTextModule(await response.text(), { context, identifier: url,
          initializeImportMeta: meta => { meta.url = url; } });
      })());
      return modules.get(url);
    }
    const appModule = await load(appURL);
    await appModule.link((specifier, importer) => load(new URL(specifier, importer.identifier).href));
    await appModule.evaluate();
    const app = window.__checksumApp;
    await app.version.check();
    const mission = await app.missions.load();
    console.log(JSON.stringify({ requests, missionChecksum: mission.checksum, versionURL: app.version.versionURL }));
  `;
  const { stdout } = await run(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, `${origin}${prefix}assets/${buildId}/app.js`, origin + prefix]);
  const result = JSON.parse(stdout);
  assert.equal(result.versionURL, `${origin}/checksum-rush/version.json`);
  assert.equal(result.missionChecksum, 'SUM4');
  assert.ok(result.requests.some(url => new URL(url).pathname === '/checksum-rush/version.json'));
  assert.ok(result.requests.some(url => new URL(url).pathname === `/checksum-rush/assets/${buildId}/data/missions.json`));
  assert.ok(result.requests.every(url => new URL(url).pathname.startsWith(prefix)));
});
