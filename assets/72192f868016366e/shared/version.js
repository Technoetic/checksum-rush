/** The executing document owns its identity for its entire lifetime. */
export class VersionService {
  constructor({ loadedBuild, versionURL = '/version.json', fetchImpl = globalThis.fetch.bind(globalThis), timeout = 1500 }) {
    Object.defineProperty(this, 'loadedBuild', { value: String(loadedBuild), enumerable: true });
    this.versionURL = versionURL;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.pendingBuild = null;
    this.sequence = 0;
  }

  async check() {
    const sequence = ++this.sequence;
    const controller = new AbortController();
    let timer;
    try {
      const documentURL = globalThis.location?.href || globalThis.window?.location?.href;
      const url = new URL(this.versionURL, documentURL || 'http://localhost/');
      if (documentURL && url.origin !== new URL(documentURL).origin) return this.pendingBuild;
      url.searchParams.set('_check', `${Date.now()}-${sequence}`);
      const request = (async () => {
        const result = await this.fetchImpl(url.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!result.ok || (result.url && new URL(result.url).origin !== url.origin)) throw new Error('Version unavailable');
        const payload = await result.json();
        if (typeof payload.buildId !== 'string' || !payload.buildId.trim() || payload.buildId.length > 128) throw new Error('Invalid version');
        return payload.buildId;
      })();
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Version timeout')); }, this.timeout);
      });
      const build = await Promise.race([request, deadline]);
      if (sequence === this.sequence) this.pendingBuild = build === this.loadedBuild ? null : build;
    } catch {
      // A network problem must never prevent play or erase an observed update.
    } finally {
      clearTimeout(timer);
    }
    return this.pendingBuild;
  }
}

/** Checks are read-only; only an explicit clean navigation may load a deployment. */
export class SafeNavigator {
  constructor({ versionService, getSafety = () => ({}), location = globalThis.window?.location || globalThis.location }) {
    this.versionService = versionService;
    this.getSafety = getSafety;
    this.location = location;
    this.reloadSequence = 0;
  }

  async navigate(target, { history = false, signal } = {}) {
    const unsafe = () => { const safety = this.getSafety() || {}; return Boolean(safety.dirty || safety.saving); };
    if (signal?.aborted || unsafe()) return 'blocked';
    let changed = null;
    try { changed = await this.versionService.check(); } catch { changed = this.versionService.pendingBuild || null; }
    // The game or a save may have begun while the version request was in flight.
    if (signal?.aborted || unsafe()) return 'blocked';
    if (!changed) return 'client';
    const current = new URL(this.location.href);
    const destination = new URL(target, current);
    if (destination.origin !== current.origin) return 'blocked';
    destination.searchParams.set('__build', changed);
    if (destination.search === current.search) destination.searchParams.set('__reload', `${Date.now()}-${++this.reloadSequence}`);
    // A hash change alone does not fetch HTML. A differing query guarantees it.
    this.location[history ? 'replace' : 'assign'](destination.href);
    return 'reload';
  }
}
