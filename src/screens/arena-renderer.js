const COLORS = { lime: '#c6ff40', cyan: '#5de9fa', red: '#ff6576', neutral: '#879b78' };
export class ArenaRenderer {
  constructor(canvas, { demo = false } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.demo = demo;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.particles = []; this.beams = []; this.shake = 0;
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }
  resize() {
    const bounds = this.canvas.getBoundingClientRect(); this.w = Math.max(1, bounds.width); this.h = Math.max(1, bounds.height);
    this.dpr = Math.min(devicePixelRatio || 1, 1.75); this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
  }
  point(lane, z) { const perspective = .16 + .84 * z; return { x: this.w / 2 + (lane - 1) * this.w * .31 * perspective, y: this.h * .13 + z * this.h * .76 }; }
  effect(event) {
    const point = this.point(event.lane ?? 1, event.packet?.z ?? .8);
    const color = event.type === 'wrong' || event.type === 'leak' ? COLORS.red : event.type === 'scan' ? COLORS.cyan : COLORS.lime;
    if (event.type === 'scan' || event.type === 'block') this.beams.push({ lane: event.lane, z: event.packet?.z ?? .7, life: .19, max: .19, color });
    if (event.type === 'block' || event.type === 'wrong' || event.type === 'leak') {
      if (!this.reduced) this.shake = event.type === 'block' ? 3 : 6;
      const count = this.reduced ? 5 : 24;
      for (let i = 0; i < count; i++) { const angle = Math.random() * Math.PI * 2; const speed = 30 + Math.random() * 150; this.particles.push({ x: point.x, y: point.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .3 + Math.random() * .5, color }); }
      this.particles = this.particles.slice(-180);
    }
  }
  roundRect(x, y, w, h, radius, fill, stroke) {
    const c = this.ctx; c.beginPath(); c.roundRect(x, y, w, h, radius); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); }
  }
  draw(state, dt, clock) {
    const c = this.ctx, w = this.w, h = this.h; if (!c || !w || !h) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (this.shake > .1 && !this.reduced) { c.translate((Math.random() - .5) * this.shake, (Math.random() - .5) * this.shake); this.shake *= .83; }
    const glow = c.createRadialGradient(w * .5, h * .47, 5, w * .5, h * .5, w * .65); glow.addColorStop(0, '#21371566'); glow.addColorStop(.6, '#0d1a1022'); glow.addColorStop(1, '#090d0b00'); c.fillStyle = glow; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 52; i++) { const x = ((i * 137.53) % w); const y = ((i * 71.17 + (this.reduced ? 0 : clock * (i % 3 + 1) * 3)) % h); c.fillStyle = i % 4 ? '#53684455' : '#a5c78199'; c.fillRect(x, y, 1, i % 7 === 0 ? 4 : 1); }
    c.lineWidth = 1;
    for (let lane = -.5; lane <= 2.5; lane++) { const a = this.point(lane, 0), b = this.point(lane, 1.08); const grad = c.createLinearGradient(a.x, a.y, b.x, b.y); grad.addColorStop(0, '#b2e67c05'); grad.addColorStop(1, '#8cb55c44'); c.strokeStyle = grad; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }
    for (let i = 0; i < 18; i++) { const z = ((i / 18 + (this.reduced ? 0 : clock * .075)) % 1) ** 1.6; const a = this.point(-.5, z), b = this.point(2.5, z); c.strokeStyle = `rgba(111,154,75,${.035 + z * .14})`; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }
    const horizon = this.point(1, 0); c.strokeStyle = '#a9d87c20'; c.beginPath(); c.ellipse(horizon.x, horizon.y, w * .15, h * .04, 0, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#7f9a6d'; c.font = '8px Consolas, monospace'; c.textAlign = 'center'; if (this.demo) c.fillText('TRANSMISSION IN PROGRESS', w / 2, h * .08);
    const selectedA = this.point(state.lane, .1), selectedB = this.point(state.lane, 1);
    const laneGlow = c.createLinearGradient(0, selectedA.y, 0, selectedB.y); laneGlow.addColorStop(0, '#c6ff4000'); laneGlow.addColorStop(1, '#c6ff4010'); c.fillStyle = laneGlow;
    const la = this.point(state.lane - .44, .1), ra = this.point(state.lane + .44, .1), lb = this.point(state.lane - .44, 1.05), rb = this.point(state.lane + .44, 1.05); c.beginPath(); c.moveTo(la.x, la.y); c.lineTo(ra.x, ra.y); c.lineTo(rb.x, rb.y); c.lineTo(lb.x, lb.y); c.closePath(); c.fill();
    for (const packet of [...state.packets].sort((a, b) => a.z - b.z)) this.packet(packet, clock);
    const drone = this.point(state.lane, .94); this.drone(drone.x, drone.y, this.demo ? 1.14 : 1, clock);
    for (const beam of this.beams) { beam.life -= dt; const target = this.point(beam.lane, beam.z); c.globalAlpha = Math.max(0, beam.life / beam.max); c.strokeStyle = beam.color; c.lineWidth = this.reduced ? 1 : 3; c.shadowBlur = 18; c.shadowColor = beam.color; c.beginPath(); c.moveTo(drone.x, drone.y - 18); c.lineTo(target.x, target.y); c.stroke(); c.shadowBlur = 0; c.beginPath(); c.arc(target.x, target.y, (1 - beam.life / beam.max) * 40, 0, Math.PI * 2); c.lineWidth = 1; c.stroke(); }
    this.beams = this.beams.filter(b => b.life > 0); c.globalAlpha = 1;
    for (const p of this.particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 75 * dt; c.globalAlpha = Math.max(0, Math.min(1, p.life * 2)); c.fillStyle = p.color; c.fillRect(p.x, p.y, 2, 2); } c.globalAlpha = 1; this.particles = this.particles.filter(p => p.life > 0);
    if (state.slowRemaining > 0) { c.strokeStyle = '#5de9fa44'; c.lineWidth = 4; c.strokeRect(3, 3, w - 6, h - 6); c.fillStyle = '#5de9fa'; c.textAlign = 'center'; c.font = '9px Consolas, monospace'; c.fillText('TIME DILATION', w / 2, h * .24); }
  }
  packet(p, clock) {
    const c = this.ctx, { x, y } = this.point(p.lane, p.z), scale = .4 + p.z * .8;
    const pw = Math.min(105, this.w * .23) * scale, ph = 48 * scale;
    const color = !p.scanned ? COLORS.neutral : p.actual !== p.expected ? COLORS.red : COLORS.lime;
    c.save(); c.translate(x, y); c.shadowColor = color; c.shadowBlur = p.scanned && !this.reduced ? 13 : 0;
    this.roundRect(-pw / 2, -ph / 2, pw, ph, 5, '#101b12ed', color + (p.scanned ? 'd9' : '70')); c.shadowBlur = 0;
    c.fillStyle = color; c.textAlign = 'center'; c.font = `${Math.max(8, 12 * scale)}px Consolas, monospace`; c.fillText(p.bytes.map(v => v.toString(16).toUpperCase()).join(' '), 0, -3 * scale);
    c.font = `${Math.max(6, 8 * scale)}px Consolas, monospace`; c.fillStyle = p.scanned ? color : '#62745d'; c.fillText(`TX ${p.expected.toString(16).toUpperCase()}  ${p.scanned ? (p.actual === p.expected ? '=' : '≠') : '·'}  RX ${p.scanned ? p.actual.toString(16).toUpperCase() : '?'}`, 0, 12 * scale);
    if (p.scanned) { c.fillStyle = color; c.fillRect(-pw / 2 - 3, -ph / 2 + 7, 2, ph - 14); c.fillRect(pw / 2 + 1, -ph / 2 + 7, 2, ph - 14); }
    c.restore();
  }
  drone(x, y, scale, clock) {
    const c = this.ctx; c.save(); c.translate(x, y + (this.reduced ? 0 : Math.sin(clock * 3) * 2)); c.scale(scale, scale);
    const g = c.createRadialGradient(0, 8, 2, 0, 8, 53); g.addColorStop(0, '#c6ff4039'); g.addColorStop(1, '#c6ff4000'); c.fillStyle = g; c.fillRect(-53, -45, 106, 106);
    c.fillStyle = '#c6ff40'; c.shadowBlur = this.reduced ? 0 : 14; c.shadowColor = '#c6ff4066'; c.beginPath(); c.moveTo(0, -29); c.lineTo(13, -7); c.lineTo(39, 10); c.lineTo(35, 18); c.lineTo(12, 13); c.lineTo(0, 25); c.lineTo(-12, 13); c.lineTo(-35, 18); c.lineTo(-39, 10); c.lineTo(-13, -7); c.closePath(); c.fill(); c.shadowBlur = 0;
    c.fillStyle = '#17240e'; c.beginPath(); c.moveTo(0, -18); c.lineTo(8, 1); c.lineTo(0, 14); c.lineTo(-8, 1); c.closePath(); c.fill(); c.fillStyle = '#efffd1'; c.fillRect(-2, -8, 4, 8); c.strokeStyle = '#90ba38'; c.beginPath(); c.moveTo(-11, -2); c.lineTo(-28, 9); c.moveTo(11, -2); c.lineTo(28, 9); c.stroke(); c.restore();
  }
  dispose() { this.observer.disconnect(); this.particles.length = 0; this.beams.length = 0; }
}
