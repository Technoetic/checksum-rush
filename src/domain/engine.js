import { checksum } from './checksum.js';

const EPSILON = 1e-9;
const SCAN_COST = 10;
const ENERGY_REGEN = 18;
const SLOW_COST = 35;
const SPAWN_INTERVALS = [1.2, 0.9, 0.65];
const TRAVEL_TIMES = [7, 6, 5];
const STAT_KEYS = ['scanned', 'blocked', 'accepted', 'falseBlocks', 'leaks'];
const clone = value => structuredClone(value);
const finiteIn = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const integerIn = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Deterministic, DOM-free round. Consumers render state without mutating it. */
export class ChecksumEngine {
  constructor({ seed = 1, duration = 90 } = {}) {
    if (!integerIn(seed, 0, 0xffffffff) || !finiteIn(duration, Number.MIN_VALUE, 3600)) {
      throw new TypeError('Invalid round seed or duration.');
    }
    this._duration = duration;
    this._randomState = seed || 0x6d2b79f5;
    this._spawnRemaining = 0.6;
    this._nextPacketId = 1;
    this._lastSpawnLane = -1;
    this._events = [];
    this.state = {
      phase: 'ready', elapsed: 0, remaining: duration, lane: 1,
      integrity: 100, energy: 100, score: 0, combo: 0, bestCombo: 0,
      wave: 1, slowRemaining: 0, packets: [],
      stats: { scanned: 0, blocked: 0, accepted: 0, falseBlocks: 0, leaks: 0 },
    };
  }

  start() {
    if (this.state.phase !== 'ready') return false;
    this.state.phase = 'running';
    return true;
  }

  pause() {
    if (this.state.phase !== 'running') return false;
    this.state.phase = 'paused';
    return true;
  }

  resume() {
    if (this.state.phase !== 'paused') return false;
    this.state.phase = 'running';
    return true;
  }

  setLane(lane) {
    if (this.state.phase !== 'running' || !integerIn(lane, 0, 2)) return false;
    this.state.lane = lane;
    return true;
  }

  moveLane(delta) {
    if (!Number.isSafeInteger(delta)) return false;
    return this.setLane(Math.max(0, Math.min(2, this.state.lane + delta)));
  }

  scan() {
    if (this.state.phase !== 'running' || this.state.energy < SCAN_COST) return false;
    const packet = this._nearest(true);
    if (!packet) return false;
    this.state.energy -= SCAN_COST;
    this.state.stats.scanned++;
    packet.scanned = true;
    this._emit('scan', packet.lane, { packet: clone(packet) });
    return true;
  }

  block() {
    if (this.state.phase !== 'running') return false;
    const packet = this._nearest(false);
    if (!packet) return false;
    this.state.packets = this.state.packets.filter(item => item.id !== packet.id);
    if (packet.scanned && packet.corrupt) {
      this.state.combo++;
      this.state.bestCombo = Math.max(this.state.bestCombo, this.state.combo);
      const points = 100 + (this.state.combo - 1) * 20;
      this.state.score += points;
      this.state.stats.blocked++;
      this._emit('block', packet.lane, { packet: clone(packet), points });
    } else {
      this.state.stats.falseBlocks++;
      this._damage(16);
      this._emit('wrong', packet.lane, { packet: clone(packet), message: '검사한 손상 패킷만 차단하세요' });
      this._checkLoss();
    }
    return true;
  }

  slow() {
    if (this.state.phase !== 'running' || this.state.energy < SLOW_COST || this.state.slowRemaining > 0) return false;
    this.state.energy -= SLOW_COST;
    this.state.slowRemaining = 2.5;
    this._emit('slow', this.state.lane);
    return true;
  }

  /** Split at simulation events so a large delta cannot skip a spawn or impact. */
  update(dt) {
    if (!finiteIn(dt, 0, Number.MAX_VALUE)) throw new TypeError('Delta time must be finite and non-negative.');
    if (this.state.phase !== 'running' || dt === 0) return;
    let budget = Math.min(dt, this.state.remaining);
    while (budget > EPSILON && this.state.phase === 'running') {
      const state = this.state;
      const travelTime = TRAVEL_TIMES[state.wave - 1];
      const speed = state.slowRemaining > EPSILON ? 0.4 : 1;
      const untilImpact = state.packets.reduce((minimum, packet) => Math.min(minimum, (1 - packet.z) * travelTime / speed), Infinity);
      const untilWave = state.wave < 3 ? this._duration * state.wave / 3 - state.elapsed : Infinity;
      const untilSlowEnd = state.slowRemaining > EPSILON ? state.slowRemaining : Infinity;
      const step = Math.max(0, Math.min(budget, state.remaining, this._spawnRemaining, untilImpact, untilWave, untilSlowEnd));

      state.elapsed += step;
      state.remaining = Math.max(0, this._duration - state.elapsed);
      state.energy = Math.min(100, state.energy + step * ENERGY_REGEN);
      state.slowRemaining = Math.max(0, state.slowRemaining - step);
      if (state.slowRemaining < EPSILON) state.slowRemaining = 0;
      for (const packet of state.packets) packet.z = Math.min(1, packet.z + step * speed / travelTime);
      this._spawnRemaining -= step;
      budget -= step;

      const arrivals = state.packets.filter(packet => packet.z >= 1 - EPSILON);
      if (arrivals.length) {
        state.packets = state.packets.filter(packet => packet.z < 1 - EPSILON);
        for (const packet of arrivals) {
          if (packet.corrupt) {
            state.stats.leaks++;
            this._damage(20);
            this._emit('leak', packet.lane, { packet: clone(packet) });
            if (this._checkLoss()) break;
          } else {
            state.stats.accepted++;
            state.score += 10;
            this._emit('accept', packet.lane, { packet: clone(packet), points: 10 });
          }
        }
      }
      if (state.phase !== 'running') break;
      if (state.remaining <= EPSILON) {
        state.elapsed = this._duration;
        state.remaining = 0;
        this._end('won');
        break;
      }
      if (state.wave < 3 && state.elapsed >= this._duration * state.wave / 3 - EPSILON) {
        state.wave++;
        this._emit('wave', state.lane, { wave: state.wave });
      }
      if (this._spawnRemaining <= EPSILON) {
        this._spawn();
        this._spawnRemaining += SPAWN_INTERVALS[state.wave - 1];
      }
    }
  }

  drainEvents() {
    const events = this._events;
    this._events = [];
    return events;
  }

  snapshot() {
    return clone({
      version: 1, duration: this._duration, state: this.state,
      randomState: this._randomState, spawnRemaining: this._spawnRemaining,
      nextPacketId: this._nextPacketId, lastSpawnLane: this._lastSpawnLane,
    });
  }

  static restore(snapshot) {
    validateSnapshot(snapshot);
    const game = new ChecksumEngine({ duration: snapshot.duration });
    game.state = clone(snapshot.state);
    game.state.phase = 'paused';
    game._randomState = snapshot.randomState;
    game._spawnRemaining = snapshot.spawnRemaining;
    game._nextPacketId = snapshot.nextPacketId;
    game._lastSpawnLane = snapshot.lastSpawnLane;
    return game;
  }

  _random() {
    let value = this._randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this._randomState = value >>> 0;
    return this._randomState / 0x100000000;
  }

  _spawn() {
    // Never repeat a rail immediately; packet spacing remains readable at rush speed.
    const lanes = [0, 1, 2].filter(lane => lane !== this._lastSpawnLane);
    const lane = lanes[Math.floor(this._random() * lanes.length)];
    const bytes = Array.from({ length: 4 }, () => Math.floor(this._random() * 16));
    const expected = checksum(bytes);
    const corrupt = this._random() < [0.42, 0.5, 0.56][this.state.wave - 1];
    if (corrupt) {
      const index = Math.floor(this._random() * 4);
      bytes[index] = (bytes[index] + 1 + Math.floor(this._random() * 15)) % 16;
    }
    this.state.packets.push({
      id: this._nextPacketId++, lane, z: 0, bytes, expected,
      actual: checksum(bytes), scanned: false, corrupt,
    });
    this._lastSpawnLane = lane;
  }

  _nearest(unscannedOnly) {
    return this.state.packets.reduce((nearest, packet) => {
      if (packet.lane !== this.state.lane || (unscannedOnly && packet.scanned)) return nearest;
      return !nearest || packet.z > nearest.z ? packet : nearest;
    }, null);
  }

  _damage(amount) {
    this.state.integrity = Math.max(0, this.state.integrity - amount);
    this.state.combo = 0;
  }

  _checkLoss() {
    if (this.state.integrity > 0) return false;
    this._end('lost');
    return true;
  }

  _end(phase) {
    if (this.state.phase !== 'running') return;
    this.state.phase = phase;
    this._emit('end', this.state.lane, { phase });
  }

  _emit(type, lane, extra = {}) {
    this._events.push({ type, lane, ...extra });
  }
}

function validateSnapshot(save) {
  const invalid = () => { throw new TypeError('Invalid or incompatible checkpoint.'); };
  if (!save || save.version !== 1 || !finiteIn(save.duration, Number.MIN_VALUE, 3600)
    || !integerIn(save.randomState, 1, 0xffffffff)
    || !finiteIn(save.spawnRemaining, 0, 1.2)
    || !integerIn(save.nextPacketId, 1)
    || !integerIn(save.lastSpawnLane, -1, 2)) invalid();
  const state = save.state;
  if (!state || !['running', 'paused'].includes(state.phase)
    || !finiteIn(state.elapsed, 0, save.duration)
    || !finiteIn(state.remaining, Number.MIN_VALUE, save.duration)
    || Math.abs(state.elapsed + state.remaining - save.duration) > EPSILON
    || !integerIn(state.lane, 0, 2)
    || !finiteIn(state.integrity, Number.MIN_VALUE, 100)
    || !finiteIn(state.energy, 0, 100)
    || !integerIn(state.score, 0) || !integerIn(state.combo, 0)
    || !integerIn(state.bestCombo, state.combo)
    || !integerIn(state.wave, 1, 3)
    || state.wave !== Math.min(3, Math.floor((state.elapsed + EPSILON) / (save.duration / 3)) + 1)
    || !finiteIn(state.slowRemaining, 0, 2.5)
    || !Array.isArray(state.packets) || state.packets.length > 100
    || !state.stats || STAT_KEYS.some(key => !integerIn(state.stats[key], 0))) invalid();
  const ids = new Set();
  for (const packet of state.packets) {
    if (!packet || !integerIn(packet.id, 1, save.nextPacketId - 1) || ids.has(packet.id)
      || !integerIn(packet.lane, 0, 2) || !finiteIn(packet.z, 0, 1)
      || !integerIn(packet.expected, 0, 15) || !integerIn(packet.actual, 0, 15)
      || typeof packet.scanned !== 'boolean' || typeof packet.corrupt !== 'boolean'
      || packet.corrupt !== (packet.expected !== packet.actual)) invalid();
    try { if (checksum(packet.bytes) !== packet.actual) invalid(); } catch { invalid(); }
    ids.add(packet.id);
  }
}
