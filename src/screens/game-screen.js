import { ChecksumEngine } from '../domain/engine.js';
import { ArenaRenderer } from './arena-renderer.js';
const fmt = n => Math.round(n).toLocaleString('en-US');
export class GameScreen {
  constructor({ root, mission, records, sound, checkpoint, onFinish, onNavigate }) {
    Object.assign(this, { root, mission, records, sound, checkpoint, onFinish, onNavigate });
    this.disposed = false; this.saved = false; this.saving = false; this.ending = false; this.lastScan = null; this.feedbackUntil = 0;
  }
  mount() {
    this.engine = this.checkpoint ? ChecksumEngine.restore(this.checkpoint) : new ChecksumEngine({ seed: Date.now() & 0x7fffffff, duration: this.mission.duration });
    this.root.innerHTML = `<section class="arena-page"><div class="game-topline"><p class="eyebrow">DEFENSE ACTIVE / SECTOR 07</p><span class="mission-name">NEON GATE / 001</span></div><div class="game-grid"><div><div class="arena-wrap" data-wave="1"><canvas class="arena-canvas" aria-label="세 개 레일로 패킷이 도착하는 게임 화면. 레일을 선택하고 검사 후 체크섬이 다른 패킷을 차단하세요."></canvas><div class="arena-hud"><div class="hud-score"><p class="stat-label">TRANSMISSION SCORE</p><strong id="hud-score">0</strong></div><div class="hud-time"><strong id="hud-time">01:30</strong><span id="hud-wave">WAVE 01 / 03</span></div><button class="pause-btn" id="pause" type="button" aria-label="일시정지">Ⅱ</button></div><div class="arena-feedback" id="feedback" role="status" aria-live="polite"></div><div class="combo-display"><strong id="hud-combo">0×</strong><small>BLOCK COMBO</small></div><div class="lane-indicators" aria-hidden="true"><span data-lane-indicator="0">RAIL A</span><span data-lane-indicator="1" class="active">RAIL B</span><span data-lane-indicator="2">RAIL C</span></div><div class="overlay" id="game-overlay" hidden></div></div><div class="touch-lanes" aria-label="레일 선택"><button type="button" data-lane="0" aria-pressed="false">← 레일 A</button><button type="button" data-lane="1" aria-pressed="true">레일 B</button><button type="button" data-lane="2" aria-pressed="false">레일 C →</button></div><div class="game-actions"><button class="action-button scan" id="scan" type="button">⌖ &nbsp; 패킷 검사 <small>SPACE</small></button><button class="action-button block" id="block" type="button">⟐ &nbsp; 변조 차단 <small>J</small></button></div><div class="controls-hint"><span><kbd>A</kbd><kbd>D</kbd> 이동 <kbd>SPACE</kbd> 검사 <kbd>J</kbd> 차단 <kbd>SHIFT</kbd> 감속</span><span>마우스 클릭: 검사 · 우클릭: 차단</span></div></div><aside class="game-sidebar" aria-label="게임 상태"><section class="side-panel"><div class="side-heading">INTEGRITY SHIELD <span>ONLINE</span></div><div class="integrity-row"><strong id="integrity">100</strong><small>%</small></div><div class="meter" aria-label="방어선 상태"><i id="integrity-bar"></i></div><div class="energy-meter"><div class="side-heading">SCAN ENERGY <span id="energy">100%</span></div><div class="meter"><i id="energy-bar"></i></div></div></section><section class="side-panel"><div class="side-heading">CHECKSUM COMPARATOR <span>SUM4</span></div><div class="compare-box" id="compare" data-status="idle"><div><small>전송 전 · TX</small><strong id="tx">—</strong></div><span id="compare-sign">·</span><div><small>수신 후 · RX</small><strong id="rx">—</strong></div></div><p class="packet-bytes" id="packet-bytes">— — — —</p><p class="scan-status" id="scan-status" role="status">패킷을 검사하면 비교값이 보여요.</p></section><section class="side-panel"><div class="side-heading">THREAT LEVEL <span id="wave-index">01 / 03</span></div><h2 class="wave-tag" id="wave-name">LINK ESTABLISHED</h2><p class="wave-caption" id="wave-caption"></p><button class="text-link" type="button" id="slow">⌁ 감속 필드 <span>SHIFT →</span></button><p class="wave-caption">에너지 35 · 2.5초 감속</p></section></aside></div></section>`;
    this.canvas = this.root.querySelector('canvas'); this.renderer = new ArenaRenderer(this.canvas); this.overlay = this.root.querySelector('#game-overlay');
    this.nodes = Object.fromEntries([...this.root.querySelectorAll('[id]')].map(n => [n.id, n]));
    this.abort = new AbortController(); const opts = { signal: this.abort.signal };
    this.root.querySelector('#scan').addEventListener('click', () => this.act('scan'), opts);
    this.root.querySelector('#block').addEventListener('click', () => this.act('block'), opts);
    this.root.querySelector('#slow').addEventListener('click', () => this.act('slow'), opts);
    const touchSlow = document.createElement('button'); touchSlow.type = 'button'; touchSlow.className = 'mobile-slow'; touchSlow.textContent = '⌁ 감속 필드 · 에너지 35';
    touchSlow.addEventListener('click', () => this.act('slow'), opts); this.root.querySelector('.controls-hint').append(touchSlow);
    this.root.querySelector('#pause').addEventListener('click', () => this.pause(), opts);
    for (const button of this.root.querySelectorAll('[data-lane]')) button.addEventListener('click', () => this.engine.setLane(Number(button.dataset.lane)), opts);
    this.canvas.addEventListener('pointerdown', e => { if (this.engine.state.phase !== 'running') return; const box = this.canvas.getBoundingClientRect(); this.engine.setLane(Math.min(2, Math.max(0, Math.floor((e.clientX - box.left) / box.width * 3)))); if (e.pointerType === 'mouse') this.act(e.button === 2 ? 'block' : 'scan'); }, opts);
    this.canvas.addEventListener('contextmenu', e => e.preventDefault(), opts);
    document.addEventListener('keydown', e => this.key(e), opts);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); }, opts);
    window.addEventListener('blur', () => this.pause(), opts);
    this.overlay.addEventListener('keydown', e => { if (e.key !== 'Tab') return; const buttons = [...this.overlay.querySelectorAll('button:not(:disabled)')]; if (!buttons.length) return; if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); } }, opts);
    if (this.checkpoint) this.showOverlay('CHECKPOINT RESTORED', '방어선으로 복귀할까요?', '저장했던 패킷과 점수, 남은 시간을 그대로 이어갑니다.', [{ text: '저장 라운드 재개 →', action: () => this.resume() }, { text: '홈으로 돌아가기', secondary: true, action: () => { this.saved = true; void this.onNavigate('#/'); } }]);
    else this.engine.start();
    this.last = performance.now();
    const frame = now => { if (this.disposed) return; const dt = Math.min((now - this.last) / 1000, .05); this.last = now; this.engine.update(dt); this.consumeEvents(now); this.updateHUD(now); this.renderer.draw(this.engine.state, dt, now / 1000); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame); void this.sound.unlock();
  }
  get dirty() { return !this.saved && !this.disposed; }
  key(e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable) return;
    if (e.key === 'Escape') { e.preventDefault(); if (this.engine.state.phase === 'running') this.pause(); else if (this.overlayMode === 'pause') this.resume(); return; }
    if (this.engine.state.phase !== 'running' || e.repeat) return;
    const map = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
    if (e.code in map) { e.preventDefault(); this.engine.moveLane(map[e.code]); }
    else if (['Space', 'KeyJ', 'ShiftLeft', 'ShiftRight'].includes(e.code)) { e.preventDefault(); this.act(e.code === 'Space' ? 'scan' : e.code === 'KeyJ' ? 'block' : 'slow'); }
  }
  act(action) {
    if (this.engine.state.phase !== 'running' || this.saving) return;
    const done = this.engine[action]();
    if (!done) { if (this.engine.state.energy < (action === 'slow' ? 35 : 10)) this.message('에너지 충전 중…', 'bad'); else if (action !== 'slow') this.message('선택한 레일에 대상이 없어요.', 'neutral'); }
  }
  consumeEvents(now) {
    for (const e of this.engine.drainEvents()) {
      this.renderer.effect(e); this.sound.play(e.type);
      if (e.type === 'scan') { this.lastScan = e.packet; const p = e.packet, equal = p.actual === p.expected; this.nodes.tx.textContent = p.expected.toString(16).toUpperCase(); this.nodes.rx.textContent = p.actual.toString(16).toUpperCase(); this.nodes['compare-sign'].textContent = equal ? '=' : '≠'; this.nodes.compare.dataset.status = equal ? 'match' : 'mismatch'; this.nodes['packet-bytes'].textContent = p.bytes.map(n => n.toString(16).toUpperCase()).join(' '); this.nodes['scan-status'].textContent = equal ? '체크섬 일치 · 그대로 통과시키세요.' : '체크섬 불일치 · J / 차단!'; if (!equal) this.message('불일치 발견 · 차단하세요', 'bad'); }
      if (e.type === 'block') this.message(`변조 차단 +${e.points ?? 100}`, 'good');
      if (e.type === 'wrong') this.message(e.packet?.scanned ? '정상 패킷 오차단!' : '먼저 검사해야 해요!', 'bad');
      if (e.type === 'leak') this.message('변조 패킷 유입 · 방어선 손상', 'bad');
      if (e.type === 'slow') this.message('감속 필드 전개', 'good');
      if (e.type === 'wave') this.message(`WAVE ${this.engine.state.wave} · ${this.engine.state.wave === 3 ? 'FINAL RUSH' : 'TRAFFIC SURGE'}`, 'good');
      if (e.type === 'end' && !this.ending) { this.ending = true; this.showOverlay('TRANSMISSION ENDED', this.engine.state.phase === 'won' ? '방어 성공!' : '신호 연결 종료', '이번 라운드의 기록을 정리하고 있어요.', []); const s = this.engine.state; const result = { score: s.score, won: s.phase === 'won', stats: { ...s.stats }, bestCombo: s.bestCombo, wave: s.wave, elapsed: s.elapsed, integrity: s.integrity }; this.endTimer = setTimeout(() => { if (!this.disposed) void this.onFinish(result); }, 650); }
    }
  }
  message(text, tone = 'good') { this.nodes.feedback.textContent = text; this.nodes.feedback.dataset.tone = tone; this.feedbackUntil = performance.now() + 1300; }
  updateHUD(now) {
    const s = this.engine.state, time = Math.max(0, Math.ceil(s.remaining));
    const set = (id, value) => { if (this.nodes[id].textContent !== String(value)) this.nodes[id].textContent = value; };
    set('hud-score', fmt(s.score)); set('hud-combo', `${s.combo}×`); set('hud-time', `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toString().padStart(2, '0')}`); set('hud-wave', `WAVE 0${s.wave} / 03`); set('integrity', Math.max(0, Math.ceil(s.integrity))); set('energy', `${Math.floor(s.energy)}%`);
    this.nodes['integrity-bar'].style.width = `${Math.max(0, s.integrity)}%`; this.nodes['integrity-bar'].style.background = s.integrity < 35 ? '#ff6576' : '#c6ff40'; this.nodes['energy-bar'].style.width = `${s.energy}%`;
    this.root.querySelector('.arena-wrap').dataset.wave = s.wave; set('wave-index', `0${s.wave} / 03`); set('wave-name', this.mission.waves[s.wave - 1].name); set('wave-caption', this.mission.waves[s.wave - 1].caption);
    for (const span of this.root.querySelectorAll('[data-lane-indicator]')) span.classList.toggle('active', Number(span.dataset.laneIndicator) === s.lane);
    for (const button of this.root.querySelectorAll('[data-lane]')) button.setAttribute('aria-pressed', String(Number(button.dataset.lane) === s.lane));
    if (now > this.feedbackUntil) this.nodes.feedback.textContent = '';
  }
  showOverlay(eyebrow, title, description, actions) {
    this.overlay.innerHTML = '<div class="overlay-card" role="dialog" aria-modal="true" aria-labelledby="overlay-title"><p class="eyebrow"></p><h2 id="overlay-title"></h2><p class="overlay-description"></p><div class="overlay-actions"></div></div>';
    this.overlay.querySelector('.eyebrow').textContent = eyebrow; this.overlay.querySelector('h2').textContent = title; this.overlay.querySelector('.overlay-description').textContent = description;
    const target = this.overlay.querySelector('.overlay-actions');
    for (const a of actions) { const button = document.createElement('button'); button.type = 'button'; button.className = a.danger ? 'btn-danger' : a.secondary ? 'btn-secondary' : a.text ? 'text-link' : 'btn-primary'; button.textContent = a.text; button.addEventListener('click', a.action, { signal: this.abort.signal }); target.append(button); }
    this.overlay.hidden = false; target.querySelector('button')?.focus();
  }
  pause() {
    if (this.engine.state.phase !== 'running' || this.saving) return;
    this.engine.pause(); this.overlayMode = 'pause';
    this.showOverlay('LINK ON HOLD', '잠깐, 숨을 고르세요.', '라운드는 멈춰 있어요. 저장하고 나가면 같은 지점에서 다시 플레이할 수 있습니다.', [{ text: '계속 방어하기 →', action: () => this.resume() }, { text: '저장하고 홈으로', secondary: true, action: () => this.saveAndLeave('#/') }]);
  }
  resume() { if (this.saving) return; this.overlay.hidden = true; this.overlayMode = null; this.engine.resume(); this.saved = false; this.last = performance.now(); void this.sound.unlock(); }
  requestLeave(target) {
    if (this.saving || this.records.saving || this.ending) { this.message('기록 저장을 마친 후 이동할 수 있어요.', 'neutral'); return; }
    this.engine.pause(); this.overlayMode = 'leave';
    this.showOverlay('PROTECT YOUR PROGRESS', '라운드를 저장할까요?', '진행 중인 패킷과 점수를 저장해 두면 나중에 이어서 플레이할 수 있어요.', [{ text: '저장하고 이동', action: () => this.saveAndLeave(target) }, { text: '라운드로 돌아가기', secondary: true, action: () => this.resume() }, { text: '저장하지 않고 이동', danger: true, action: () => { this.saved = true; void this.onNavigate(target); } }]);
  }
  async saveAndLeave(target) {
    if (this.saving) return; this.saving = true;
    for (const b of this.overlay.querySelectorAll('button')) b.disabled = true;
    try { await this.records.saveCheckpoint(this.engine.snapshot()); if (this.disposed) return; this.saved = true; this.saving = false; await this.onNavigate(target); }
    catch (error) { this.saving = false; if (this.disposed) return; this.showOverlay('CHECKPOINT NOT SAVED', '저장에 실패했어요.', error.message, [{ text: '저장 다시 시도', action: () => this.saveAndLeave(target) }, { text: '라운드로 돌아가기', secondary: true, action: () => this.resume() }, { text: '저장하지 않고 이동', danger: true, action: () => { this.saved = true; void this.onNavigate(target); } }]); }
  }
  recordError(error, retry, skip) { this.showOverlay('RECORD NOT SAVED', '기록을 저장하지 못했어요.', error.message, [{ text: '기록 저장 다시 시도', action: retry }, { text: '저장 없이 결과 보기', secondary: true, action: skip }]); }
  dispose() { this.disposed = true; this.abort?.abort(); cancelAnimationFrame(this.raf); clearTimeout(this.endTimer); this.renderer?.dispose(); }
}
