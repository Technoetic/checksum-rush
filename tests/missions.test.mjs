import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MissionService } from '../src/services/missions.js';

const mission = JSON.parse(await readFile(new URL('../src/data/missions.json', import.meta.url), 'utf8'));
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('mission did not settle')), 150); })]); }
  finally { clearTimeout(timer); }
}

test('valid shipped mission data loads asynchronously with the bundled module-relative address', async () => {
  let address;
  const service = new MissionService(async url => { address = url; return response(mission); });
  assert.deepEqual(await service.load(), mission);
  assert.ok(String(address).endsWith('/data/missions.json'));
});

test('the default browser fetch retains its global receiver when the mission service invokes it', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = function () {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response(mission));
    };
    assert.deepEqual(await new MissionService().load(), mission);
  } finally { globalThis.fetch = original; }
});

test('mission timeout covers a fetch that ignores cancellation and aborts its transport signal', async () => {
  let signal;
  const service = new MissionService((url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeout: 15 });
  await assert.rejects(within(service.load()), error => error.name === 'TimeoutError');
  assert.equal(signal.aborted, true);
});

test('mission timeout also covers a response whose JSON body never finishes', async () => {
  let signal;
  const service = new MissionService(async (url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; }, { timeout: 15 });
  await assert.rejects(within(service.load()), error => error.name === 'TimeoutError');
  assert.equal(signal.aborted, true);
});

test('caller abort settles a hung fetch even if transport ignores its signal', async () => {
  const controller = new AbortController();
  let transportSignal;
  const service = new MissionService((url, { signal }) => { transportSignal = signal; return new Promise(() => {}); });
  const loading = service.load({ signal: controller.signal });
  controller.abort();
  await assert.rejects(within(loading), error => error.name === 'AbortError');
  assert.equal(transportSignal.aborted, true);
});

test('caller abort remains effective after headers arrive and a JSON body hangs', async () => {
  const controller = new AbortController();
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const service = new MissionService(async () => ({ ok: true, json() { bodyStarted(); return new Promise(() => {}); } }));
  const loading = service.load({ signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(within(loading), error => error.name === 'AbortError');
});

test('an already aborted caller does not start a mission request', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const service = new MissionService(async () => { calls++; return response(mission); });
  await assert.rejects(service.load({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
});

test('stale and malformed mission formats reject safely and a later retry can succeed', async () => {
  const invalid = [null, [], { ...mission, version: 0 }, { ...mission, checksum: 'CRC' }, { ...mission, duration: 30 }, { ...mission, title: null }, { ...mission, waves: [null, ...mission.waves.slice(1)] }, { ...mission, waves: mission.waves.slice(1) }, { ...mission, waves: mission.waves.map(wave => ({ ...wave, caption: 5 })) }];
  for (const data of invalid) {
    const service = new MissionService(async () => response(data));
    await assert.rejects(service.load(), error => error instanceof Error && error.name !== 'TypeError');
  }
  let offline = true;
  const service = new MissionService(async () => { if (offline) throw new Error('offline'); return response(mission); });
  await assert.rejects(service.load(), Error);
  offline = false;
  assert.deepEqual(await service.load(), mission);
});

test('HTTP failures and invalid JSON reject through the normal retry error path', async () => {
  for (const fetchImpl of [async () => new Response('unavailable', { status: 503 }), async () => new Response('{broken', { status: 200 })]) {
    await assert.rejects(new MissionService(fetchImpl).load(), error => error instanceof Error && /미션/.test(error.message));
  }
});
