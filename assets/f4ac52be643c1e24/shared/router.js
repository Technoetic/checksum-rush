const STATE_KEY = '__checksumRushIndex';
const hashOf = value => !value || value === '#' ? '#/' : value.startsWith('#') ? value : `#${value.startsWith('/') ? '' : '/'}${value}`;
const stateAt = history => Number.isInteger(history.state?.[STATE_KEY]) ? history.state[STATE_KEY] : null;
const stateWith = (history, index) => ({ ...(history.state && typeof history.state === 'object' ? history.state : {}), [STATE_KEY]: index });

/** Async, gated hash routing with one render per traversal and reversible Back. */
export class HashRouter {
  constructor({ onNavigate, window = globalThis.window }) {
    this.onNavigate = onNavigate;
    this.window = window;
    this.sequence = 0;
    this.running = false;
    this.pending = null;
    this.started = false;
    this.disposed = false;
    this.onHistory = event => this.observeHistory(event);
  }

  start() {
    if (this.started) return this.initial;
    this.started = true;
    const { history, location } = this.window;
    this.index = stateAt(history) ?? 0;
    const url = new URL(location.href);
    url.hash = hashOf(url.hash);
    history.replaceState(stateWith(history, this.index), '', url.href);
    this.committedHref = location.href;
    this.observedHref = location.href;
    this.observedIndex = this.index;
    this.window.addEventListener('popstate', this.onHistory);
    this.window.addEventListener('hashchange', this.onHistory);
    this.initial = this.enqueue({ hash: url.hash, history: true, href: url.href, index: this.index });
    return this.initial;
  }

  go(hash) {
    if (this.disposed) return Promise.resolve(false);
    return this.enqueue({ hash: hashOf(hash), history: false });
  }

  observeHistory(event) {
    if (this.disposed) return;
    const { location, history } = this.window;
    const href = location.href;
    if (href === this.observedHref) return;
    const previousHref = this.observedHref;
    let index = stateAt(history);
    // An address-bar hash creates an entry without router state. Stamp its
    // physical position before awaiting the gate, even if it is superseded.
    if (index === null && event.type === 'hashchange' && event.oldURL === previousHref) {
      index = (this.observedIndex ?? this.index) + 1;
      history.replaceState(stateWith(history, index), '', href);
    }
    this.observedHref = href;
    this.observedIndex = index;
    if (href === this.restoringHref) { this.restoringHref = null; return; }
    if (href === this.committedHref) {
      // The pending screen may already have replaced the DOM with a loader.
      // Cancel it and restore the committed screen as well as its URL.
      if (this.active || this.pending) this.enqueue({ hash: hashOf(location.hash), history: true, href, index });
      return;
    }
    this.enqueue({ hash: hashOf(location.hash), history: true, href, index, oldURL: event.oldURL });
  }

  enqueue(request) {
    if (this.disposed) return Promise.resolve(false);
    request.id = ++this.sequence;
    request.controller = new AbortController();
    const result = new Promise(resolve => { request.resolve = resolve; });
    this.active?.controller.abort();
    if (this.pending) { this.pending.controller.abort(); this.pending.resolve(false); }
    this.pending = request;
    this.drain();
    return result;
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.pending && !this.disposed) {
      const request = this.pending;
      this.pending = null;
      this.active = request;
      let allowed = false;
      try { allowed = await this.onNavigate({ hash: request.hash, history: request.history, signal: request.controller.signal }); } catch { /* Keep the committed route usable. */ }
      if (this.active === request) this.active = null;
      if (this.disposed || request.id !== this.sequence) { request.resolve(false); continue; }
      if (allowed === true) {
        const { history, location } = this.window;
        if (!request.history) {
          const next = new URL(this.committedHref);
          next.hash = request.hash;
          // A pending traversal may already have moved the browser's cursor.
          // Base the new entry on that cursor, not the last rendered route.
          this.index = stateAt(history) ?? this.observedIndex ?? this.index;
          if (next.href !== location.href) history.pushState(stateWith(history, ++this.index), '', next.href);
        } else if (request.index !== null) this.index = request.index;
        else history.replaceState(stateWith(history, ++this.index), '', location.href);
        this.committedHref = location.href;
        this.observedHref = location.href;
        this.observedIndex = this.index;
        request.resolve(true);
      } else {
        if (request.history) this.revert(request);
        request.resolve(false);
      }
    }
    this.running = false;
  }

  revert(request) {
    const { history, location } = this.window;
    if (location.href !== request.href || location.href === this.committedHref) return;
    this.restoringHref = this.committedHref;
    if (request.index !== null && request.index !== this.index) history.go(this.index - request.index);
    else if (request.oldURL === this.committedHref && history.length > 1) history.back();
    else {
      history.replaceState(stateWith(history, this.index), '', this.committedHref);
      this.observedHref = this.committedHref;
      this.restoringHref = null;
    }
  }

  dispose() {
    this.disposed = true;
    ++this.sequence;
    this.active?.controller.abort();
    if (this.pending) { this.pending.controller.abort(); this.pending.resolve(false); this.pending = null; }
    this.window.removeEventListener('popstate', this.onHistory);
    this.window.removeEventListener('hashchange', this.onHistory);
  }
}
