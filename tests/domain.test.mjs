import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../src/domain/checksum.js';
import { ChecksumEngine } from '../src/domain/engine.js';

const corrupt = (id = 1, lane = 1, z = 0.8) => ({
  id, lane, z, bytes: [1, 2, 3, 5], expected: 10, actual: 11,
  scanned: false, corrupt: true,
});
const normal = (id = 1, lane = 1, z = 0.8) => ({
  id, lane, z, bytes: [1, 2, 3, 4], expected: 10, actual: 10,
  scanned: false, corrupt: false,
});

function scenario(packets, overrides = {}) {
  const game = new ChecksumEngine({ seed: 7 });
  game.start();
  const save = game.snapshot();
  Object.assign(save.state, { lane: 1, packets }, overrides);
  save.nextPacketId = Math.max(0, ...packets.map(packet => packet.id)) + 1;
  const restored = ChecksumEngine.restore(save);
  restored.resume();
  return restored;
}

// A player can choose by position and scan status. TX/RX is read only after scan.
function inspectNearestPackets(game) {
  for (let lane = 0; lane < 3; lane++) {
    game.setLane(lane);
    const nearest = game.state.packets.filter(packet => packet.lane === lane)
      .sort((left, right) => right.z - left.z)[0];
    if (!nearest) continue;
    if (!nearest.scanned) game.scan();
    if (nearest.scanned && nearest.expected !== nearest.actual) game.block();
  }
}

test('SUM4 compares received digits using modulo sixteen', () => {
  assert.equal(checksum([0, 0, 0, 0]), 0);
  assert.equal(checksum([1, 2, 3, 4]), 10);
  assert.equal(checksum([15, 15, 15, 15]), 12);
  assert.notEqual(checksum([1, 2, 3, 4]), checksum([1, 2, 3, 5]));
});

test('different payloads can collide so matching SUM4 does not prove unchanged data', () => {
  const original = [1, 2, 3, 4];
  const changed = [2, 1, 3, 4];
  assert.notDeepEqual(original, changed);
  assert.equal(checksum(original), 10);
  assert.equal(checksum(changed), 10);
});

test('SUM4 rejects malformed length, fractional and out-of-range digits', () => {
  for (const invalid of [null, '1234', [], [1, 2, 3], [1, 2, 3, 4, 5],
    [1, 2, 3, -1], [1, 2, 3, 16], [1, 2, 3, 1.5], [1, 2, 3, NaN],
    [1, 2, 3, '4'], new Array(4)]) {
    assert.throws(() => checksum(invalid), TypeError);
  }
});

test('ready and paused rounds do not advance, and an ended round cannot restart implicitly', () => {
  const game = new ChecksumEngine({ duration: 2 });
  game.update(1);
  assert.equal(game.state.elapsed, 0);
  assert.equal(game.scan(), false);
  assert.equal(game.start(), true);
  game.update(0.5);
  assert.equal(game.pause(), true);
  const paused = game.snapshot();
  game.update(100);
  assert.deepEqual(game.snapshot(), paused);
  assert.equal(game.scan(), false);
  assert.equal(game.resume(), true);
  game.update(2);
  assert.equal(game.state.phase, 'won');
  assert.equal(game.state.remaining, 0);
  assert.equal(game.start(), false);
  assert.equal(game.resume(), false);
});

test('lane selection clamps movement and rejects invalid absolute lanes', () => {
  const game = new ChecksumEngine();
  game.start();
  game.setLane(0);
  game.moveLane(-1);
  assert.equal(game.state.lane, 0);
  game.moveLane(4);
  assert.equal(game.state.lane, 2);
  assert.equal(game.setLane(3), false);
  assert.equal(game.setLane(NaN), false);
  assert.equal(game.moveLane(0.5), false);
  assert.equal(game.state.lane, 2);
});

test('scan chooses nearest unscanned packet in selected lane and spends energy once', () => {
  const game = scenario([corrupt(1, 1, 0.4), normal(2, 1, 0.8), corrupt(3, 0, 0.95)]);
  const energy = game.state.energy;
  assert.equal(game.scan(), true);
  assert.equal(game.state.packets.find(p => p.id === 2).scanned, true);
  assert.equal(game.state.packets.find(p => p.id === 1).scanned, false);
  assert.ok(game.state.energy < energy);
  assert.equal(game.state.stats.scanned, 1);
  const event = game.drainEvents().find(e => e.type === 'scan');
  assert.equal(event.packet.id, 2);
  assert.equal(event.lane, 1);
  assert.equal(game.state.score, 0);
});

test('repeated scan cannot spend energy or farm points on the same packet', () => {
  const game = scenario([corrupt()]);
  game.scan();
  const energy = game.state.energy;
  assert.equal(game.scan(), false);
  assert.equal(game.state.energy, energy);
  assert.equal(game.state.stats.scanned, 1);
  assert.equal(game.state.score, 0);
});

test('insufficient energy leaves the target unscanned and energy regenerates with time', () => {
  const game = scenario([corrupt()], { energy: 0 });
  assert.equal(game.scan(), false);
  assert.equal(game.state.packets[0].scanned, false);
  game.update(1.1);
  assert.ok(game.state.energy > 0);
  assert.equal(game.scan(), true);
  assert.ok(game.state.energy >= 0);
});

test('blocking scanned corruption rewards increasing combo and removes the target', () => {
  const game = scenario([corrupt(1, 1, 0.8), corrupt(2, 1, 0.4)]);
  game.scan();
  assert.equal(game.block(), true);
  const firstScore = game.state.score;
  assert.ok(firstScore > 0);
  assert.equal(game.state.combo, 1);
  game.scan();
  game.block();
  assert.ok(game.state.score - firstScore > firstScore);
  assert.equal(game.state.combo, 2);
  assert.equal(game.state.bestCombo, 2);
  assert.equal(game.state.stats.blocked, 2);
  assert.equal(game.state.integrity, 100);
  assert.equal(game.state.packets.length, 0);
  const score = game.state.score;
  assert.equal(game.block(), false);
  assert.equal(game.state.score, score);
});

test('blocking normal or unscanned packets penalizes integrity and breaks a combo', () => {
  for (const packet of [normal(), corrupt()]) {
    const game = scenario([packet], { combo: 3, bestCombo: 3 });
    if (!packet.corrupt) game.scan();
    assert.equal(game.block(), true);
    assert.ok(game.state.integrity < 100);
    assert.equal(game.state.score, 0);
    assert.equal(game.state.combo, 0);
    assert.equal(game.state.stats.falseBlocks, 1);
    assert.equal(game.state.packets.length, 0);
    assert.equal(game.drainEvents().filter(e => e.type === 'wrong').length, 1);
  }
});

test('block targets nearest packet even when another scanned corrupt packet is behind it', () => {
  const rear = corrupt(2, 1, 0.4);
  rear.scanned = true;
  const game = scenario([rear, normal(1, 1, 0.8)], { stats: {
    scanned: 1, blocked: 0, accepted: 0, falseBlocks: 0, leaks: 0,
  } });
  game.block();
  assert.deepEqual(game.state.packets.map(p => p.id), [2]);
  assert.equal(game.state.stats.falseBlocks, 1);
});

test('normal packets pass automatically while escaped corrupt packets damage integrity', () => {
  const game = scenario([normal(1, 0, 0.999), corrupt(2, 2, 0.999)]);
  game.update(0.1);
  assert.equal(game.state.stats.accepted, 1);
  assert.equal(game.state.stats.leaks, 1);
  assert.ok(game.state.score > 0);
  assert.ok(game.state.integrity < 100);
  assert.equal(game.state.packets.length, 0);
  const events = game.drainEvents();
  assert.equal(events.filter(e => e.type === 'accept').length, 1);
  assert.equal(events.filter(e => e.type === 'leak').length, 1);
  assert.deepEqual(game.drainEvents(), []);
});

test('depleted integrity ends a round once and freezes subsequent updates and actions', () => {
  const game = scenario([corrupt(1, 1, 0.999)], { integrity: 1 });
  game.update(1);
  assert.equal(game.state.phase, 'lost');
  assert.equal(game.state.integrity, 0);
  const end = game.drainEvents().filter(e => e.type === 'end');
  assert.equal(end.length, 1);
  const frozen = game.snapshot();
  game.update(100);
  assert.equal(game.block(), false);
  assert.deepEqual(game.snapshot(), frozen);
});

test('slow spends energy once and reduces travel while expiry restores normal travel', () => {
  const slow = scenario([normal(1, 1, 0.1)]);
  const fast = scenario([normal(1, 1, 0.1)]);
  assert.equal(slow.slow(), true);
  const energy = slow.state.energy;
  assert.equal(slow.slow(), false);
  assert.equal(slow.state.energy, energy);
  slow.update(1);
  fast.update(1);
  assert.ok(slow.state.packets[0].z < fast.state.packets[0].z);
  assert.ok(slow.state.slowRemaining > 0);
  slow.update(2);
  assert.equal(slow.state.slowRemaining, 0);
  const empty = scenario([], { energy: 0 });
  assert.equal(empty.slow(), false);
});

test('three waves progress before a single victory event at the duration boundary', () => {
  const game = new ChecksumEngine({ seed: 1, duration: 3 });
  game.start();
  game.update(1);
  assert.equal(game.state.wave, 2);
  game.update(1);
  assert.equal(game.state.wave, 3);
  game.update(1);
  assert.equal(game.state.phase, 'won');
  assert.equal(game.state.elapsed, 3);
  const events = game.drainEvents();
  assert.deepEqual(events.filter(e => e.type === 'wave').map(e => e.wave), [2, 3]);
  assert.equal(events.filter(e => e.type === 'end').length, 1);
});

test('seeded spawning is reproducible and never creates undetectable corrupt packets', () => {
  const first = new ChecksumEngine({ seed: 123 });
  const second = new ChecksumEngine({ seed: 123 });
  first.start(); second.start();
  let count = 0;
  for (let step = 0; step < 250; step++) {
    first.update(0.05); second.update(0.05);
    assert.deepEqual(first.snapshot(), second.snapshot());
    for (const packet of first.state.packets) {
      assert.equal(packet.actual, checksum(packet.bytes));
      assert.equal(packet.corrupt, packet.expected !== packet.actual);
      assert.ok(packet.z >= 0 && packet.z <= 1);
      count++;
    }
  }
  assert.ok(count > 100);
});

test('checkpoint is a detached copy and resumes the same PRNG and spawn schedule', () => {
  const original = new ChecksumEngine({ seed: 982 });
  original.start();
  original.update(3.37);
  original.setLane(2);
  original.scan();
  original.slow();
  const checkpoint = original.snapshot();
  const detached = original.snapshot();
  const originalDigit = original.state.packets[0].bytes[0];
  detached.state.packets[0].bytes[0] = (originalDigit + 1) % 16;
  assert.equal(original.state.packets[0].bytes[0], originalDigit);
  const restored = ChecksumEngine.restore(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(restored.state.phase, 'paused');
  const before = restored.snapshot();
  restored.update(100);
  assert.deepEqual(restored.snapshot(), before);
  restored.resume();
  original.drainEvents(); restored.drainEvents();
  for (const dt of [0.01, 0.64, 1.75, 0.1, 1]) {
    original.update(dt); restored.update(dt);
    assert.deepEqual(restored.snapshot(), original.snapshot());
    assert.deepEqual(restored.drainEvents(), original.drainEvents());
  }
});

test('a checkpoint at a floating-point wave boundary remains restorable', () => {
  const game = new ChecksumEngine({ duration: 3 });
  game.start();
  for (let frame = 0; frame < 10; frame++) game.update(0.1);
  assert.equal(game.state.wave, 2);
  const restored = ChecksumEngine.restore(game.snapshot());
  assert.equal(restored.state.wave, 2);
});

test('event payloads are detached from active packet data', () => {
  const game = scenario([corrupt()]);
  game.scan();
  const event = game.drainEvents()[0];
  event.packet.bytes[0] = 15;
  event.packet.scanned = false;
  assert.deepEqual(game.state.packets[0].bytes, [1, 2, 3, 5]);
  assert.equal(game.state.packets[0].scanned, true);
});

test('the final wave moves packets faster than the opening wave', () => {
  const opening = scenario([normal(1, 1, 0.1)]);
  const final = scenario([normal(1, 1, 0.1)], { elapsed: 60, remaining: 30, wave: 3 });
  opening.update(1);
  final.update(1);
  assert.ok(final.state.packets[0].z > opening.state.packets[0].z);
});

test('a complete ninety-second round is playable with faster spawning and readable rail gaps', () => {
  const game = new ChecksumEngine({ seed: 81 });
  game.start();
  const seen = new Set();
  const waveSpawns = [0, 0, 0];
  let lastLane = -1;
  for (let frame = 0; frame < 1801 && game.state.phase === 'running'; frame++) {
    game.update(0.05);
    for (const packet of game.state.packets) {
      if (seen.has(packet.id)) continue;
      seen.add(packet.id);
      waveSpawns[game.state.wave - 1]++;
      assert.notEqual(packet.lane, lastLane);
      lastLane = packet.lane;
      if (packet.corrupt) assert.notEqual(packet.actual, packet.expected);
    }
    inspectNearestPackets(game);
  }
  assert.equal(game.state.phase, 'won');
  assert.equal(game.state.integrity, 100);
  assert.equal(game.state.stats.leaks, 0);
  assert.equal(game.state.stats.falseBlocks, 0);
  assert.ok(game.state.stats.blocked > 30);
  assert.ok(game.state.stats.accepted > 20);
  assert.ok(waveSpawns[2] > waveSpawns[1]);
  assert.ok(waveSpawns[1] > waveSpawns[0]);
});

test('energy permits perfect scan-first play across one hundred seeds without hidden corruption knowledge', () => {
  const unfair = [];
  for (let seed = 1; seed <= 100; seed++) {
    const game = new ChecksumEngine({ seed });
    game.start();
    for (let frame = 0; frame < 1801 && game.state.phase === 'running'; frame++) {
      game.update(0.05);
      inspectNearestPackets(game);
    }
    if (game.state.phase !== 'won' || game.state.stats.leaks !== 0
      || game.state.stats.falseBlocks !== 0) {
      unfair.push({ seed, phase: game.state.phase, leaks: game.state.stats.leaks });
    }
  }
  assert.deepEqual(unfair, [], 'Perfect input must have enough energy to identify every packet.');
});

test('scan-first play can afford emergency slowdowns throughout a complete round', () => {
  const game = new ChecksumEngine({ seed: 81 });
  game.start();
  let nextEmergency = 10;
  let slowdowns = 0;
  for (let frame = 0; frame < 1801 && game.state.phase === 'running'; frame++) {
    game.update(0.05);
    inspectNearestPackets(game);
    if (game.state.phase === 'running' && game.state.elapsed >= nextEmergency) {
      if (game.slow()) slowdowns++;
      nextEmergency += 10;
    }
  }
  assert.equal(game.state.phase, 'won');
  assert.equal(game.state.integrity, 100);
  assert.equal(game.state.stats.leaks, 0);
  assert.equal(slowdowns, 8);
});

test('checkpoint validation rejects damaged state rather than admitting forged runtime values', () => {
  const game = new ChecksumEngine();
  game.start();
  const good = game.snapshot();
  for (const mutate of [
    save => { save.version = 99; },
    save => { save.state.energy = NaN; },
    save => { save.state.integrity = -1; },
    save => { save.state.lane = 3; },
    save => { save.state.elapsed = -1; },
    save => { save.state.remaining = 1; },
    save => { save.state.phase = 'won'; },
    save => { save.state.stats.scanned = -1; },
    save => { save.randomState = 0; },
    save => { save.spawnRemaining = -1; },
    save => { save.state.packets = [corrupt(1), corrupt(1)]; },
    save => { save.state.packets = [{ ...normal(), actual: 15 }]; },
    save => { save.state.packets = [{ ...normal(), corrupt: true }]; },
    save => { save.state.packets = [{ ...normal(), z: Infinity }]; },
  ]) {
    const invalid = structuredClone(good);
    mutate(invalid);
    assert.throws(() => ChecksumEngine.restore(invalid), TypeError);
  }
  assert.throws(() => ChecksumEngine.restore(null), TypeError);
});

test('invalid clock deltas and invalid construction fail without poisoning state', () => {
  for (const options of [{ duration: 0 }, { duration: NaN }, { seed: 'x' }]) {
    assert.throws(() => new ChecksumEngine(options), TypeError);
  }
  const game = new ChecksumEngine();
  game.start();
  const before = game.snapshot();
  for (const dt of [NaN, Infinity, -1, '1']) {
    assert.throws(() => game.update(dt), TypeError);
    assert.deepEqual(game.snapshot(), before);
  }
});
