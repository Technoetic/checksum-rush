const LOAD_ERROR = '미션 데이터를 불러오지 못했어요. 다시 연결해 주세요.';
const FORMAT_ERROR = '미션 형식이 올바르지 않아요. 다시 시도해 주세요.';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validMission = data => isObject(data) && data.version === 1 && data.checksum === 'SUM4' && data.duration === 90
  && typeof data.title === 'string' && data.title.trim().length > 0
  && Array.isArray(data.waves) && data.waves.length === 3
  && data.waves.every(wave => isObject(wave) && typeof wave.name === 'string' && typeof wave.caption === 'string');

export class MissionService {
  constructor(fetchImpl = globalThis.fetch.bind(globalThis), { timeout = 6000 } = {}) {
    this.fetch = fetchImpl;
    this.timeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 6000;
  }

  async load({ signal } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    let timer;
    let onAbort;
    try {
      const cancelled = new Promise((resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      timer = setTimeout(() => controller.abort(new DOMException('미션 연결 시간이 초과됐어요. 다시 시도해 주세요.', 'TimeoutError')), this.timeout);
      // Bound the response body as well as headers. Cancellation must settle
      // load even when a broken fetch implementation ignores its AbortSignal.
      const request = (async () => {
        const response = await this.fetch(new URL('../data/missions.json', import.meta.url), { signal: controller.signal, cache: 'no-store' });
        controller.signal.throwIfAborted();
        if (!response.ok) throw new Error(LOAD_ERROR);
        const data = await response.json();
        controller.signal.throwIfAborted();
        if (!validMission(data)) throw new Error(FORMAT_ERROR);
        return data;
      })();
      return await Promise.race([request, cancelled]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new Error(error?.message === FORMAT_ERROR ? FORMAT_ERROR : LOAD_ERROR);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
