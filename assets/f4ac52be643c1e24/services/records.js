const EMPTY = () => ({ version: 1, best: null, lastResult: null, checkpoint: null });
const STAT_KEYS = ['scanned', 'blocked', 'accepted', 'falseBlocks', 'leaks'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const validResult = value => isObject(value)
  && nonnegative(value.score) && typeof value.won === 'boolean'
  && isObject(value.stats) && STAT_KEYS.every(key => nonnegative(value.stats[key]))
  && nonnegative(value.bestCombo)
  && Number.isInteger(value.wave) && value.wave >= 1 && value.wave <= 3
  && nonnegative(value.elapsed)
  && nonnegative(value.integrity) && value.integrity <= 100;
const validCheckpoint = value => value === null || (isObject(value) && value.version === 1 && isObject(value.state));

function validated(data) {
  if (!isObject(data) || data.version !== 1
    || (data.best != null && !validResult(data.best))
    || (data.lastResult != null && !validResult(data.lastResult))
    || !validCheckpoint(data.checkpoint ?? null)) throw new Error('Invalid saved record');
  // The engine validates checkpoint contents on restore. Persistence only checks
  // the envelope, so both running and paused snapshots remain resumable.
  return { version: 1, best: data.best ?? null, lastResult: data.lastResult ?? null, checkpoint: data.checkpoint ?? null };
}

export class RecordsService {
  constructor(storage) {
    // Accessing the global storage getter itself can throw in private or
    // sandboxed contexts, before getItem ever has a chance to run.
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; }
    catch { this.storage = null; }
    this.key = 'checksum-rush.v1';
    this.saving = false;
  }
  async load() {
    await Promise.resolve();
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return EMPTY();
      return validated(JSON.parse(raw));
    } catch { throw new Error('이 브라우저의 기록을 읽을 수 없어요. 게임은 새로 시작할 수 있어요.'); }
  }
  async write(change) {
    if (this.saving) throw new Error('기록을 저장 중이에요. 잠시 후 다시 시도해 주세요.');
    this.saving = true;
    try {
      const previous = await this.load();
      const next = validated(change(previous));
      this.storage.setItem(this.key, JSON.stringify(next));
      return next;
    } catch { throw new Error('기록을 저장하지 못했어요. 브라우저 저장 공간을 확인하거나 저장 없이 계속해 주세요.'); }
    finally { this.saving = false; }
  }
  async saveCheckpoint(checkpoint) { return this.write(data => ({ ...data, checkpoint })); }
  async saveResult(result) {
    return this.write(data => ({ ...data, checkpoint: null, lastResult: result, best: !data.best || result.score > data.best.score ? result : data.best }));
  }
}
