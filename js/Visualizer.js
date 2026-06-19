/* =====================================================================
   Visualizer.js — Affichage analytique via AnalyserNode + requestAnimationFrame.
   Oscilloscope (waveform), Spectrogramme (barres), VU-mètres RMS + Peak.
   Boucle unique optimisée 60fps.
   ===================================================================== */

export class Visualizer {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine
   * @param {object} dom - { scope, spectrum, vuL, vuR, peakLed }
   */
  constructor(engine, dom) {
    this.engine = engine;
    this.dom = dom;
    this.scopeCtx = dom.scope.getContext('2d');
    this.specCtx = dom.spectrum.getContext('2d');

    const n = engine.analyser.frequencyBinCount;
    this.timeData = new Uint8Array(n);
    this.freqData = new Uint8Array(n);

    this._peakHold = 0;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop();
  }

  stop() { this._running = false; }

  _loop = () => {
    if (!this._running) return;
    this._drawScope();
    this._drawSpectrum();
    this._drawVU();
    requestAnimationFrame(this._loop);
  };

  /** Oscilloscope : voir l'écrasement (clipping) de l'onde du kick. */
  _drawScope() {
    const { scope } = this.dom;
    const ctx = this.scopeCtx;
    const w = scope.width, h = scope.height;
    this.engine.getWaveform(this.timeData);

    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff3b1f';
    ctx.beginPath();
    const slice = w / this.timeData.length;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i] / 128 - 1; // [-1..1]
      const y = (0.5 - v * 0.5) * h;
      const x = i * slice;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Lignes de clipping (repères -1 / +1).
    ctx.strokeStyle = 'rgba(255,210,59,.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(w, 2);
    ctx.moveTo(0, h - 2); ctx.lineTo(w, h - 2); ctx.stroke();
  }

  /** Spectrogramme : barres de fréquences (échelle log compressée). */
  _drawSpectrum() {
    const { spectrum } = this.dom;
    const ctx = this.specCtx;
    const w = spectrum.width, h = spectrum.height;
    this.engine.getSpectrum(this.freqData);

    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, w, h);

    const bars = 64;
    const step = Math.floor(this.freqData.length / bars);
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      // Moyenne d'un groupe de bins pour des barres lisibles.
      let sum = 0;
      for (let j = 0; j < step; j++) sum += this.freqData[i * step + j];
      const v = (sum / step) / 255;
      const bh = v * h;
      const hue = 12 + v * 48; // rouge -> jaune selon l'énergie
      ctx.fillStyle = `hsl(${hue}, 95%, ${30 + v * 30}%)`;
      ctx.fillRect(i * bw, h - bh, bw - 1, bh);
    }
  }

  /** VU-mètres RMS + détection de Peak (clip rouge). */
  _drawVU() {
    this.engine.getWaveform(this.timeData);
    // RMS sur la fenêtre temporelle.
    let sum = 0, peak = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i] / 128 - 1;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    const pct = Math.min(100, rms * 140);
    this.dom.vuL.style.height = pct + '%';
    this.dom.vuR.style.height = (pct * 0.96) + '%'; // légère asymétrie visuelle

    // Peak hold + LED clip.
    if (peak >= 0.99) {
      this._peakHold = 60; // frames de maintien
    }
    if (this._peakHold > 0) {
      this.dom.peakLed.classList.add('clip');
      this._peakHold--;
    } else {
      this.dom.peakLed.classList.remove('clip');
    }
  }
}
