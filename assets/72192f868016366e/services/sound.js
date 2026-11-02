export class SoundService {
  constructor() { this.enabled = false; this.context = null; }
  async unlock() {
    if (!this.enabled) return;
    try { const Audio = globalThis.AudioContext || globalThis.webkitAudioContext; if (!Audio) return; this.context ??= new Audio(); if (this.context.state === 'suspended') await this.context.resume(); } catch { /* Silent play remains available. */ }
  }
  toggle() { this.enabled = !this.enabled; if (this.enabled) void this.unlock(); return this.enabled; }
  play(type) {
    if (!this.enabled || this.context?.state !== 'running') return;
    const preset = { scan: [850, 1500, .075, 'sine'], block: [160, 65, .14, 'triangle'], wrong: [100, 48, .22, 'sawtooth'], leak: [80, 35, .18, 'sawtooth'], accept: [600, 800, .04, 'sine'], slow: [330, 95, .3, 'sine'], wave: [440, 660, .2, 'triangle'], end: [300, 750, .4, 'triangle'] }[type];
    if (!preset) return;
    try { const [from, to, duration, waveform] = preset; const oscillator = this.context.createOscillator(); const gain = this.context.createGain(); const now = this.context.currentTime; oscillator.type = waveform; oscillator.frequency.setValueAtTime(from, now); oscillator.frequency.exponentialRampToValueAtTime(to, now + duration); gain.gain.setValueAtTime(type === 'accept' ? .015 : .045, now); gain.gain.exponentialRampToValueAtTime(.001, now + duration); oscillator.connect(gain); gain.connect(this.context.destination); oscillator.start(now); oscillator.stop(now + duration); } catch { /* Unsupported audio must never interrupt a round. */ }
  }
}
