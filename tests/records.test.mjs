import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordsService } from '../src/services/records.js';
import { ChecksumEngine } from '../src/domain/engine.js';

const KEY = 'checksum-rush.v1';
const result = (score = 11) => ({
  score, won: true, bestCombo: 2, wave: 3, elapsed: 90, integrity: 80,
  stats: { scanned: 7, blocked: 3, accepted: 4, falseBlocks: 0, leaks: 1 },
});
const envelope = (values = {}) => ({ version: 1, best: null, lastResult: null, checkpoint: null, ...values });
function memoryStorage(initial = null) {
  const items = new Map(initial === null ? [] : [[KEY, JSON.stringify(initial)]]);
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  };
}

test('denied global localStorage access is contained during service construction', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let records;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Access denied', 'SecurityError'); } });
    assert.doesNotThrow(() => { records = new RecordsService(); });
    await assert.rejects(records.load(), error => error instanceof Error && error.name !== 'SecurityError' && /기록/.test(error.message));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('empty persistence provides a fresh playable record without fabricating a result', async () => {
  const records = new RecordsService(memoryStorage());
  assert.deepEqual(await records.load(), envelope());
});

test('saved results reject missing UI fields and malformed counters before a result screen can dereference them', async () => {
  const damagedResults = [
    { score: 11 },
    result(-1),
    { ...result(), won: 'yes' },
    { ...result(), stats: null },
    { ...result(), stats: { scanned: 1 } },
    { ...result(), stats: { ...result().stats, blocked: -1 } },
    { ...result(), stats: { ...result().stats, leaks: '2' } },
    { ...result(), bestCombo: -1 },
    { ...result(), wave: 4 },
    { ...result(), elapsed: -1 },
    { ...result(), integrity: 101 },
    [],
  ];
  for (const field of ['best', 'lastResult']) {
    for (const damaged of damagedResults) {
      const records = new RecordsService(memoryStorage(envelope({ [field]: damaged })));
      await assert.rejects(records.load(), Error, `${field} must reject ${JSON.stringify(damaged)}`);
    }
  }
});

test('corrupt JSON, wrong schema roots and malformed checkpoint envelopes fail without erasing storage', async () => {
  const invalid = [null, [], { version: 2 }, envelope({ checkpoint: 'resume' }), envelope({ checkpoint: [] }), envelope({ checkpoint: {} }), envelope({ checkpoint: { version: 1, state: null } })];
  for (const data of invalid) {
    const serialized = JSON.stringify(data);
    const records = new RecordsService({ getItem: () => serialized, setItem: () => assert.fail('a load cannot modify storage') });
    await assert.rejects(records.load(), Error, `must reject ${serialized}`);
  }
  await assert.rejects(new RecordsService({ getItem: () => '{broken' }).load(), Error);
});

test('valid running and paused engine checkpoints survive persistence and engine restore', async () => {
  const engine = new ChecksumEngine({ seed: 9 });
  engine.start(); engine.update(1);
  const records = new RecordsService(memoryStorage());
  for (const paused of [false, true]) {
    if (paused) engine.pause();
    const checkpoint = engine.snapshot();
    assert.deepEqual((await records.saveCheckpoint(checkpoint)).checkpoint, checkpoint);
    const loaded = await records.load();
    assert.equal(ChecksumEngine.restore(loaded.checkpoint).state.phase, 'paused');
    assert.equal(loaded.checkpoint.state.phase, paused ? 'paused' : 'running');
  }
});

test('saving result updates last result, preserves the higher best and clears only a successfully saved checkpoint', async () => {
  const records = new RecordsService(memoryStorage());
  const engine = new ChecksumEngine(); engine.start();
  await records.saveResult(result(100));
  await records.saveCheckpoint(engine.snapshot());
  const lower = await records.saveResult(result(20));
  assert.equal(lower.best.score, 100);
  assert.equal(lower.lastResult.score, 20);
  assert.equal(lower.checkpoint, null);
  const higher = await records.saveResult(result(150));
  assert.equal(higher.best.score, 150);
  assert.deepEqual(await records.load(), higher);
});

test('storage read denial returns a useful error and prevents an attempted write', async () => {
  const records = new RecordsService({ getItem() { throw new DOMException('Denied', 'SecurityError'); }, setItem: () => assert.fail('read failure must not write') });
  await assert.rejects(records.load(), error => /기록/.test(error.message));
  await assert.rejects(records.saveResult(result()), error => /저장/.test(error.message));
  assert.equal(records.saving, false);
});

test('quota failure rejects the save, retains the prior checkpoint and best, and releases the saving guard', async () => {
  const engine = new ChecksumEngine(); engine.start();
  const prior = envelope({ best: result(100), lastResult: result(80), checkpoint: engine.snapshot() });
  const storage = memoryStorage(prior);
  const write = storage.setItem;
  let quota = true;
  storage.setItem = (key, value) => { if (quota) throw new DOMException('Full', 'QuotaExceededError'); write(key, value); };
  const records = new RecordsService(storage);
  const saving = records.saveResult(result(150));
  assert.equal(records.saving, true);
  await assert.rejects(saving, error => /저장/.test(error.message));
  assert.equal(records.saving, false);
  assert.deepEqual(await records.load(), prior);
  quota = false;
  assert.equal((await records.saveResult(result(150))).best.score, 150);
  assert.equal(records.saving, false);
});

test('invalid new results and checkpoints never create a corrupt persisted record', async () => {
  const records = new RecordsService(memoryStorage());
  await assert.rejects(records.saveResult({ score: 11 }), Error);
  await assert.rejects(records.saveCheckpoint('broken'), Error);
  assert.deepEqual(await records.load(), envelope());
  assert.equal(records.saving, false);
});

test('overlapping save requests cannot overwrite a checkpoint with a stale record', async () => {
  const records = new RecordsService(memoryStorage());
  const engine = new ChecksumEngine(); engine.start();
  const first = records.saveCheckpoint(engine.snapshot());
  assert.equal(records.saving, true);
  await assert.rejects(records.saveResult(result(90)), Error);
  await first;
  const loaded = await records.load();
  assert.ok(loaded.checkpoint);
  assert.equal(loaded.lastResult, null);
  assert.equal(records.saving, false);
});
