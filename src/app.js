import { HashRouter } from './shared/router.js';
import { VersionService, SafeNavigator } from './shared/version.js';
import { MissionService } from './services/missions.js';
import { RecordsService } from './services/records.js';
import { SoundService } from './services/sound.js';
import { HomeScreen, GuideScreen, ResultScreen, NotFoundScreen } from './screens/info-screens.js';
import { GameScreen } from './screens/game-screen.js';

export class ChecksumApp {
  constructor() {
    this.root = document.querySelector('#app'); this.records = new RecordsService(); this.missions = new MissionService(); this.sound = new SoundService(); this.screen = null; this.requestId = 0; this.lastResult = null; this.inflightSave = false;
    this.loadedBuild = document.querySelector('meta[name="app-build"]').content;
    this.version = new VersionService({ loadedBuild: this.loadedBuild, versionURL: new URL('../../version.json', import.meta.url).href });
    this.navigator = new SafeNavigator({ versionService: this.version, getSafety: () => ({ dirty: Boolean(this.screen?.dirty), saving: Boolean(this.screen?.saving || this.inflightSave || this.records.saving) }) });
    this.router = new HashRouter({ onNavigate: context => this.navigate(context) });
    this.globalAbort = new AbortController(); const opts = { signal: this.globalAbort.signal };
    document.addEventListener('click', e => {
      if (e.target.closest?.('.skip-link')) { e.preventDefault(); document.querySelector('#main').focus(); return; }
      const link = e.target.closest?.('[data-nav]'); if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault(); void this.sound.unlock(); void this.router.go(link.dataset.nav);
    }, opts);
    document.querySelector('#sound-toggle').addEventListener('click', () => { const enabled = this.sound.toggle(); document.querySelector('#sound-toggle').setAttribute('aria-pressed', String(enabled)); document.querySelector('#sound-toggle').setAttribute('aria-label', enabled ? '게임 사운드 끄기' : '게임 사운드 켜기'); document.querySelector('#sound-label').textContent = enabled ? 'SOUND ON' : 'SOUND OFF'; if (enabled) this.sound.play('scan'); }, opts);
    const check = async () => { await this.version.check(); this.updateNotice(); };
    window.addEventListener('focus', check, opts); window.addEventListener('pageshow', check, opts); document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); }, opts);
    window.addEventListener('beforeunload', e => { if (this.screen?.dirty || this.inflightSave || this.records.saving) { e.preventDefault(); e.returnValue = ''; } }, opts);
  }
  async start() { await this.router.start(); }
  updateNotice() { document.querySelector('#update-notice').hidden = !this.version.pendingBuild; }
  async navigate({ hash, history, signal }) {
    if (signal?.aborted) return false;
    const target = new URL(location.href); target.hash = hash;
    const outcome = await this.navigator.navigate(target.href, { history, signal }); this.updateNotice();
    if (signal?.aborted) return false;
    if (outcome === 'blocked') { this.screen?.requestLeave?.(hash); return false; }
    if (outcome === 'reload') return false;
    await this.render(hash, signal); return !signal?.aborted;
  }
  async render(hash, signal) {
    if (signal?.aborted) return;
    const id = ++this.requestId; this.abort?.abort(); const controller = new AbortController(); this.abort = controller; this.screen?.dispose(); this.screen = null;
    const cancel = () => { controller.abort(); if (id === this.requestId) this.screen?.dispose(); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.root.setAttribute('aria-busy', 'true'); this.root.innerHTML = '<div class="loading-state"><span class="loader-ring"></span><p>데이터 링크 연결 중…</p></div>';
    const [path, query = ''] = hash.replace(/^#/, '').split('?');
    try {
      let screen;
      if (path === '/' || !path) screen = new HomeScreen({ root: this.root, records: this.records });
      else if (path === '/guide') screen = new GuideScreen({ root: this.root });
      else if (path === '/play') {
        const mission = await this.missions.load({ signal: controller.signal }); if (id !== this.requestId || controller.signal.aborted) return;
        let checkpoint = null; if (new URLSearchParams(query).get('resume') === '1') { const data = await this.records.load(); checkpoint = data.checkpoint; if (!checkpoint) throw new Error('저장된 라운드가 없어요. 홈에서 새 라운드를 시작해 주세요.'); }
        if (id !== this.requestId || controller.signal.aborted) return;
        screen = new GameScreen({ root: this.root, mission, records: this.records, sound: this.sound, checkpoint, onFinish: result => this.finish(result), onNavigate: next => this.router.go(next) });
      } else if (path === '/results') {
        let data = {}; try { data = await this.records.load(); } catch { /* The in-memory result remains accessible when storage fails. */ }
        if (id !== this.requestId || controller.signal.aborted) return; screen = new ResultScreen({ root: this.root, result: this.lastResult || data.lastResult, best: data.best });
      } else screen = new NotFoundScreen({ root: this.root });
      if (id !== this.requestId || controller.signal.aborted) return; this.screen = screen; await screen.mount();
      if (id !== this.requestId || controller.signal.aborted) return;
      this.root.setAttribute('aria-busy', 'false'); document.title = `CHECKSUM RUSH${path === '/play' ? ' — 방어전 진행 중' : path === '/guide' ? ' — 플레이 가이드' : path === '/results' ? ' — 미션 리포트' : ' — 데이터 방어전'}`;
      for (const link of document.querySelectorAll('.topbar [data-nav]')) link.setAttribute('aria-current', link.dataset.nav === hash ? 'page' : 'false'); window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (error) {
      if (id !== this.requestId || controller.signal.aborted || error.name === 'AbortError') return; this.screen?.dispose(); this.screen = null; this.root.setAttribute('aria-busy', 'false'); this.root.innerHTML = '<section class="error-state"><p class="eyebrow accent">LINK INTERRUPTED</p><h1>잠시, 연결을 확인해 주세요.</h1><p id="error-description"></p><div class="results-actions"><button type="button" class="btn-primary" id="retry">다시 연결하기 ↻</button><a class="btn-secondary" href="#/" data-nav="#/">홈으로</a></div></section>'; this.root.querySelector('#error-description').textContent = error.message; this.root.querySelector('#retry').addEventListener('click', () => void this.router.go(hash), { once: true });
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async finish(result) {
    if (this.inflightSave) return; this.lastResult = result; this.inflightSave = true;
    try { await this.records.saveResult(result); this.inflightSave = false; if (this.screen) this.screen.saved = true; await this.router.go('#/results'); }
    catch (error) { this.inflightSave = false; this.screen?.recordError?.(error, () => this.finish(result), () => { this.screen.saved = true; void this.router.go('#/results'); }); }
  }
  dispose() { this.abort?.abort(); this.globalAbort.abort(); this.screen?.dispose(); this.router.dispose(); }
}
const app = new ChecksumApp();
// Observable local state aids deterministic verification; records never leave this browser.
Object.defineProperty(window, '__checksumApp', { value: app, configurable: true });
app.start().catch(error => { document.querySelector('#app').textContent = `게임을 시작하지 못했어요: ${error.message}`; });
