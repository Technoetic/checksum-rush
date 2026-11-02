import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const versionModule = await import('../src/shared/version.js').catch(() => ({}));
const routerModule = await import('../src/shared/router.js').catch(() => ({}));
const buildModule = await import('../scripts/build.mjs').catch(() => ({}));
const serverModule = await import('../scripts/serve.mjs').catch(() => ({}));
const { VersionService, SafeNavigator } = versionModule;
const { HashRouter } = routerModule;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function response(buildId) { return new Response(JSON.stringify({ buildId }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function requireAPI(value, name) { assert.equal(typeof value, 'function', `${name} implementation is required`); }

test('fresh version checks detect new builds and rollback without changing the loaded HTML identity', async () => {
  requireAPI(VersionService, 'VersionService');
  const builds = ['A', 'B', '0', 'A'];
  const requests = [];
  const service = new VersionService({ loadedBuild: 'A', versionURL: 'https://game.test/version.json', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return response(builds.shift());
  } });
  assert.equal(await service.check(), null);
  assert.equal(await service.check(), 'B');
  assert.equal(await service.check(), '0');
  assert.equal(await service.check(), null);
  assert.equal(service.loadedBuild, 'A');
  assert.ok(requests.every(request => request.options.cache === 'no-store' && request.options.credentials === 'same-origin'));
  assert.equal(new URL(requests[0].url).origin, 'https://game.test');
});

test('the default browser fetch retains its global receiver so deployment checks actually execute', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = function () {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response('B'));
    };
    assert.equal(await new VersionService({ loadedBuild: 'A' }).check(), 'B');
  } finally { globalThis.fetch = original; }
});

test('failed, malformed and timed-out version requests leave a known update and a usable client', async () => {
  requireAPI(VersionService, 'VersionService');
  let mode = 'updated';
  const service = new VersionService({ loadedBuild: 'A', timeout: 15, fetchImpl: async () => {
    if (mode === 'updated') return response('B');
    if (mode === 'network') throw new Error('offline');
    if (mode === 'malformed') return response('');
    return new Promise(() => {});
  } });
  assert.equal(await service.check(), 'B');
  for (mode of ['network', 'malformed', 'timeout']) assert.equal(await service.check(), 'B');
  const offline = new VersionService({ loadedBuild: 'A', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await offline.check(), null);
});

test('overlapping version checks cannot let an older response erase a newer deployment', async () => {
  requireAPI(VersionService, 'VersionService');
  const older = deferred();
  let call = 0;
  const service = new VersionService({ loadedBuild: 'A', fetchImpl: () => ++call === 1 ? older.promise : Promise.resolve(response('C')) });
  const oldCheck = service.check();
  assert.equal(await service.check(), 'C');
  older.resolve(response('A'));
  await oldCheck;
  assert.equal(service.pendingBuild, 'C');
});

test('changed hash targets cause full document navigation with a different query, including history replacement', async () => {
  requireAPI(SafeNavigator, 'SafeNavigator');
  const calls = [];
  const location = { href: 'https://game.test/?mode=arcade#/', assign: url => calls.push(['assign', url]), replace: url => calls.push(['replace', url]) };
  const navigator = new SafeNavigator({ versionService: { check: async () => 'B' }, getSafety: () => ({ dirty: false, saving: false }), location });
  assert.equal(await navigator.navigate('#/guide'), 'reload');
  assert.equal(await navigator.navigate('#/results', { history: true }), 'reload');
  assert.equal(calls[0][0], 'assign');
  assert.equal(calls[1][0], 'replace');
  const target = new URL(calls[0][1]);
  assert.equal(target.hash, '#/guide');
  assert.equal(target.searchParams.get('mode'), 'arcade');
  assert.notEqual(target.search, new URL(location.href).search);
});

test('a round becoming dirty while a version request waits blocks document navigation', async () => {
  requireAPI(SafeNavigator, 'SafeNavigator');
  const pending = deferred();
  let dirty = false;
  const location = { href: 'https://game.test/#/', assign: () => assert.fail('lost active progress'), replace: () => assert.fail('lost active progress') };
  const navigator = new SafeNavigator({ versionService: { check: () => pending.promise }, getSafety: () => ({ dirty, saving: false }), location });
  const navigation = navigator.navigate('#/guide');
  dirty = true;
  pending.resolve('B');
  assert.equal(await navigation, 'blocked');
});

test('saving protects progress before and after the async check, and clean offline navigation stays client-side', async () => {
  requireAPI(SafeNavigator, 'SafeNavigator');
  let saving = true;
  let checks = 0;
  const pending = deferred();
  const navigator = new SafeNavigator({ versionService: { check: () => { checks++; return pending.promise; } }, getSafety: () => ({ saving }), location: { href: 'https://game.test/#/' } });
  assert.equal(await navigator.navigate('#/guide'), 'blocked');
  assert.equal(checks, 0);
  saving = false;
  const navigation = navigator.navigate('#/guide');
  saving = true;
  pending.resolve('B');
  assert.equal(await navigation, 'blocked');
  const offline = new SafeNavigator({ versionService: { check: async () => { throw new Error('offline'); } }, getSafety: () => ({}), location: { href: 'https://game.test/#/' } });
  assert.equal(await offline.navigate('#/guide'), 'client');
});

test('cancelled navigation cannot load the wrong target when a deployment check finishes later', async () => {
  requireAPI(SafeNavigator, 'SafeNavigator');
  const pending = deferred();
  const controller = new AbortController();
  const location = { href: 'https://game.test/#/', assign: () => assert.fail('cancelled target reloaded'), replace: () => assert.fail('cancelled target replaced') };
  const navigator = new SafeNavigator({ versionService: { check: () => pending.promise }, getSafety: () => ({}), location });
  const navigation = navigator.navigate('#/play', { signal: controller.signal });
  controller.abort();
  pending.resolve('B');
  assert.equal(await navigation, 'blocked');
  assert.equal(await navigator.navigate('#/guide', { signal: controller.signal }), 'blocked');
});

// A browser history boundary with actual URL parsing and browser event ordering.
// push/replaceState do not emit events; traversal emits both popstate and hashchange.
function browser(initial = 'https://game.test/#/') {
  const events = new EventTarget();
  const entries = [{ href: initial, state: null }];
  let cursor = 0;
  const location = { get href() { return entries[cursor].href; }, get hash() { return new URL(this.href).hash; } };
  const emit = (type, details) => { const event = new Event(type); Object.assign(event, details); events.dispatchEvent(event); };
  const history = {
    get state() { return entries[cursor].state; },
    get length() { return entries.length; },
    pushState(state, title, url) { entries.splice(cursor + 1); entries.push({ href: new URL(url, location.href).href, state }); cursor++; },
    replaceState(state, title, url) { entries[cursor] = { href: new URL(url, location.href).href, state }; },
    go(delta) {
      const next = cursor + delta;
      if (next < 0 || next >= entries.length || next === cursor) return;
      const oldURL = location.href;
      cursor = next;
      queueMicrotask(() => { emit('popstate', { state: history.state }); emit('hashchange', { oldURL, newURL: location.href }); });
    },
    back() { this.go(-1); }, forward() { this.go(1); },
  };
  return { location, history, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), externalHash(hash) {
    const oldURL = location.href;
    history.pushState(null, '', hash);
    queueMicrotask(() => emit('hashchange', { oldURL, newURL: location.href }));
  } };
}

test('router renders direct links once and gates client navigation before changing the URL', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser('https://game.test/#/guide');
  const seen = [];
  const router = new HashRouter({ window, onNavigate: async ({ hash, history }) => { seen.push({ hash, history }); return hash !== '#/blocked'; } });
  await router.start();
  assert.deepEqual(seen, [{ hash: '#/guide', history: true }]);
  assert.equal(await router.go('#/play'), true);
  assert.equal(window.location.hash, '#/play');
  assert.equal(await router.go('#/blocked'), false);
  assert.equal(window.location.hash, '#/play');
  assert.equal(window.history.length, 2);
  router.dispose();
});

test('router deduplicates popstate/hashchange and reverses rejected Back without destroying Forward history', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  let blocked = false;
  const seen = [];
  const router = new HashRouter({ window, onNavigate: async ({ hash }) => { seen.push(hash); return !blocked; } });
  await router.start();
  await router.go('#/guide');
  await router.go('#/play');
  blocked = true;
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/play');
  assert.equal(window.history.length, 3);
  assert.deepEqual(seen, ['#/', '#/guide', '#/play', '#/guide']);
  blocked = false;
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/guide');
  window.history.forward();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/play');
  assert.deepEqual(seen.slice(-2), ['#/guide', '#/play']);
  router.dispose();
});

test('router serializes rapid async requests and does not commit a superseded target', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  const gate = deferred();
  const seen = [];
  let active = 0;
  const router = new HashRouter({ window, onNavigate: async ({ hash }) => {
    assert.equal(active++, 0, 'navigation renders must not overlap');
    seen.push(hash);
    if (hash === '#/guide') await gate.promise;
    active--;
    return true;
  } });
  await router.start();
  const first = router.go('#/guide');
  await tick();
  const last = router.go('#/play');
  gate.resolve();
  assert.equal(await first, false);
  assert.equal(await last, true);
  assert.equal(window.location.hash, '#/play');
  assert.equal(window.history.length, 2);
  assert.deepEqual(seen, ['#/', '#/guide', '#/play']);
  router.dispose();
});

test('rejected manually edited hashes return to the committed entry and handler errors are contained', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  const router = new HashRouter({ window, onNavigate: async ({ hash }) => { if (hash === '#/oops') throw new Error('screen failed'); return hash === '#/'; } });
  await router.start();
  window.externalHash('#/blocked');
  await tick(); await tick();
  assert.equal(window.location.hash, '#/');
  assert.equal(await router.go('#/oops'), false);
  assert.equal(window.location.hash, '#/');
  router.dispose();
  window.externalHash('#/guide');
  await tick();
  assert.equal(window.location.hash, '#/guide');
});

test('a client navigation superseding pending Back keeps history indices aligned for the next rejected Back', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  const gate = deferred();
  let waitForBack = false;
  let blocked = false;
  const router = new HashRouter({ window, onNavigate: async ({ hash, history }) => {
    if (waitForBack && history && hash === '#/guide') await gate.promise;
    return !blocked;
  } });
  await router.start();
  await router.go('#/guide');
  await router.go('#/play');
  waitForBack = true;
  window.history.back();
  await tick();
  const latest = router.go('#/results');
  gate.resolve();
  assert.equal(await latest, true);
  assert.equal(window.location.hash, '#/results');
  blocked = true;
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/results');
  router.dispose();
});

test('a client navigation superseding a manually edited hash preserves traversal through that hash', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  const gate = deferred();
  let blocked = false;
  const router = new HashRouter({ window, onNavigate: async ({ hash }) => {
    if (hash === '#/manual') await gate.promise;
    return !blocked;
  } });
  await router.start();
  await router.go('#/play');
  window.externalHash('#/manual');
  await tick();
  const latest = router.go('#/results');
  gate.resolve();
  await latest;
  blocked = true;
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/results');
  blocked = false;
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/manual');
  router.dispose();
});

test('returning to the rendered route while Back is pending restores its visible URL', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  const gate = deferred();
  let wait = false;
  const router = new HashRouter({ window, onNavigate: async ({ hash, history }) => {
    if (wait && history && hash === '#/') await gate.promise;
    return true;
  } });
  await router.start();
  await router.go('#/play');
  wait = true;
  window.history.back();
  await tick();
  const navigation = router.go('#/play');
  gate.resolve();
  assert.equal(await navigation, true);
  assert.equal(window.location.hash, '#/play');
  router.dispose();
});

test('superseding a hung route aborts its request so the next screen can render', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  let playSignal;
  const rendered = [];
  const router = new HashRouter({ window, onNavigate: async ({ hash, signal }) => {
    if (hash === '#/play') {
      playSignal = signal;
      if (!signal) return false;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return false;
    }
    rendered.push(hash);
    return true;
  } });
  await router.start();
  const play = router.go('#/play');
  assert.ok(playSignal instanceof AbortSignal, 'every route gets a cancellable request');
  const home = router.go('#/');
  assert.equal(playSignal.aborted, true);
  assert.equal(await play, false);
  assert.equal(await home, true);
  assert.deepEqual(rendered, ['#/', '#/']);
  assert.equal(window.location.hash, '#/');
  router.dispose();
});

test('Back returning to the committed screen and dispose both abort pending route work', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser();
  let pendingSignal;
  let aborts = 0;
  const router = new HashRouter({ window, onNavigate: async ({ hash, signal }) => {
    if (hash !== '#/play') return true;
    pendingSignal = signal;
    if (!signal) return false;
    await new Promise(resolve => signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }));
    return false;
  } });
  await router.start();
  window.externalHash('#/play');
  await tick();
  assert.ok(pendingSignal instanceof AbortSignal);
  window.history.back();
  await tick(); await tick();
  assert.equal(pendingSignal.aborted, true);
  assert.equal(window.location.hash, '#/');
  const play = router.go('#/play');
  router.dispose();
  assert.equal(pendingSignal.aborted, true);
  assert.equal(await play, false);
  assert.equal(aborts, 2);
});

test('Back to the committed route rerenders it after cancelling a loading screen', async () => {
  requireAPI(HashRouter, 'HashRouter');
  const window = browser('https://game.test/#/guide');
  let visible;
  const renders = [];
  const router = new HashRouter({ window, onNavigate: async ({ hash, signal }) => {
    renders.push(hash);
    if (hash === '#/play') {
      visible = 'loading';
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return false;
    }
    visible = hash;
    return true;
  } });
  await router.start();
  window.externalHash('#/play');
  await tick();
  assert.equal(visible, 'loading');
  window.history.back();
  await tick(); await tick();
  assert.equal(window.location.hash, '#/guide');
  assert.equal(visible, '#/guide');
  assert.deepEqual(renders, ['#/guide', '#/play', '#/guide']);
  assert.equal(window.history.length, 2, 'restoring a render must not add a history entry');
  router.dispose();
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'checksum-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/shared'), { recursive: true });
  await writeFile(path.join(root, 'src/index.html'), '<!doctype html><html><head><meta name="build-id" content="__BUILD_ID__"></head><body><script type="module" src="__ASSET_BASE__/main.js"></script></body></html>');
  await writeFile(path.join(root, 'src/main.js'), "import { answer } from './shared/answer.js'; console.log(answer);");
  await writeFile(path.join(root, 'src/shared/answer.js'), 'export const answer = 42;');
  return root;
}

test('build makes stable content identities and keeps the entire import graph within one immutable directory', async t => {
  requireAPI(buildModule.build, 'build');
  const root = await fixture(t);
  const first = await buildModule.build({ root });
  assert.match(first.buildId, /^[a-f0-9]{12,64}$/);
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  assert.ok(html.includes(`content="${first.buildId}"`));
  assert.ok(html.includes(`/assets/${first.buildId}/main.js`));
  assert.ok(!html.includes('__BUILD_ID__') && !html.includes('__ASSET_BASE__'));
  assert.equal(await readFile(path.join(root, `dist/assets/${first.buildId}/shared/answer.js`), 'utf8'), 'export const answer = 42;');
  assert.equal(JSON.parse(await readFile(path.join(root, 'dist/version.json'), 'utf8')).buildId, first.buildId);
  assert.equal((await buildModule.build({ root })).buildId, first.buildId);
  await writeFile(path.join(root, 'src/shared/answer.js'), 'export const answer = 43;');
  assert.notEqual((await buildModule.build({ root })).buildId, first.buildId);
  assert.ok((await stat(path.join(root, 'src/main.js'))).isFile());
  assert.ok((await readFile(path.join(root, 'dist/_headers'), 'utf8')).includes('immutable'));
});

test('static service has no-store entry/version, immutable assets, HEAD support and genuine 404s', async t => {
  requireAPI(buildModule.build, 'build');
  requireAPI(serverModule.createStaticServer, 'createStaticServer');
  const root = await fixture(t);
  const { buildId } = await buildModule.build({ root });
  const server = serverModule.createStaticServer({ directory: path.join(root, 'dist') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const target of ['/', '/index.html', '/version.json']) {
    const result = await fetch(base + target);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  const asset = await fetch(`${base}/assets/${buildId}/main.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const head = await fetch(`${base}/assets/${buildId}/main.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const target of ['/api/unknown', '/guide', `/assets/${buildId}/missing.js`]) assert.equal((await fetch(base + target)).status, 404);
  // Encoded slashes keep traversal visible instead of URL-normalizing it in fetch.
  const traversal = await fetch(`${base}/..%2f..%2fsecret.txt`);
  assert.equal(traversal.status, 403);
});
