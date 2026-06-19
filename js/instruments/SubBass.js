/* =====================================================================
   SubBass.js — Layer de basse dédié (sub) pour l'arrangement.

   Une voix de basse propre (sinus + saturation douce + passe-bas) qui suit
   la tonalité détectée PAR SECTION. Jouée par le moteur d'Arrangement
   (offbeats / sustain / root) elle remplit le bas du spectre sous les kicks
   et se règle indépendamment (niveau, decay, octave, glide, drive).
   ===================================================================== */

import { clamp } from '../utils.js';

export class SubBass {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   * @param {import('../StateManager.js').StateManager} state
   */
  constructor(ctx, destination, state) {
    this.ctx = ctx;
    this.state = state;

    // Chaîne fixe : osc -> VCA -> drive(waveshaper) -> lowpass -> level -> out
    this.vca = ctx.createGain(); this.vca.gain.value = 0.0001;
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = '2x';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 220; this.lp.Q.value = 0.7;
    this.level = ctx.createGain();

    this.osc = ctx.createOscillator(); this.osc.type = 'sine';
    this.osc.connect(this.vca); this.vca.connect(this.shaper);
    this.shaper.connect(this.lp); this.lp.connect(this.level); this.level.connect(destination);
    this.osc.frequency.value = 55; this.osc.start();

    this._applyParams();
    this._unsub = state.on('bass', () => this._applyParams());
  }

  /** Courbe de saturation douce (tanh) selon le drive. */
  _curve(drive) {
    const n = 1024, c = new Float32Array(n), k = 1 + drive * 6;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  _applyParams() {
    const b = this.state.get('bass');
    this.shaper.curve = this._curve(b.drive);
    this.level.gain.setTargetAtTime(b.on ? b.level : 0.0001, this.ctx.currentTime, 0.02);
  }

  /**
   * Joue une note de basse.
   * @param {number} time
   * @param {number} freq - Hz (déjà accordé à la section)
   * @param {number} [dur] - durée (s) ; défaut = decay de l'état
   * @param {number} [vel]
   */
  trigger(time, freq, dur, vel = 1) {
    const b = this.state.get('bass');
    if (!b.on) return;
    const f = clamp(freq * Math.pow(2, b.octave), 20, 400);
    const d = dur || b.decay;
    if (b.glide > 0) this.osc.frequency.linearRampToValueAtTime(f, time + b.glide);
    else this.osc.frequency.setValueAtTime(f, time);
    // Ouvre un peu le filtre selon la note pour garder de la définition.
    this.lp.frequency.setValueAtTime(clamp(f * 4, 120, 600), time);
    const g = this.vca.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0.0001, time);
    g.linearRampToValueAtTime(vel, time + 0.004);
    g.exponentialRampToValueAtTime(0.0001, time + d);
  }

  dispose() { if (this._unsub) { this._unsub(); this._unsub = null; } }
}
