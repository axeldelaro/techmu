/* =====================================================================
   SubBass.js — Layer de basse dédié, 2 couches, accordé par section.

   - SUB  : sinus pur (le poids, le bas du spectre).
   - GROWL: oscillateur saw -> distorsion -> bandpass médiums : rend la
     basse AUDIBLE sur petits haut-parleurs (téléphone/laptop) et lui donne
     le caractère "greazy".
   Enveloppe punchy (chute de pitch à l'attaque = "thump"), contrôle de
   tone (passe-bas global), et SIDECHAIN interne : la basse plonge sous
   chaque kick pour un bas du spectre net.
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

    // --- Deux oscillateurs persistants (synthé monophonique) ---
    this.oscSub = ctx.createOscillator(); this.oscSub.type = 'sine';
    this.oscGrowl = ctx.createOscillator(); this.oscGrowl.type = 'sawtooth';

    this.subAmp = ctx.createGain();        // niveau du layer sub
    this.growlShaper = ctx.createWaveShaper(); this.growlShaper.oversample = '2x';
    this.growlBP = ctx.createBiquadFilter(); this.growlBP.type = 'bandpass';
    this.growlBP.frequency.value = 350; this.growlBP.Q.value = 0.8;
    this.growlAmp = ctx.createGain();      // niveau du layer growl

    this.vca = ctx.createGain(); this.vca.gain.value = 0.0001;   // enveloppe d'amplitude
    this.toneLP = ctx.createBiquadFilter(); this.toneLP.type = 'lowpass'; this.toneLP.Q.value = 0.7;
    this.duckGain = ctx.createGain(); this.duckGain.gain.value = 1; // sidechain interne
    this.level = ctx.createGain();         // volume global

    // Câblage : (sub + growl) -> vca -> tone -> duck -> level -> out
    this.oscSub.connect(this.subAmp).connect(this.vca);
    this.oscGrowl.connect(this.growlShaper).connect(this.growlBP).connect(this.growlAmp).connect(this.vca);
    this.vca.connect(this.toneLP).connect(this.duckGain).connect(this.level).connect(destination);

    this.oscSub.frequency.value = 55; this.oscGrowl.frequency.value = 55;
    this.oscSub.start(); this.oscGrowl.start();

    this._applyParams();
    this._unsub = state.on('bass', () => this._applyParams());
  }

  /** Courbe de saturation (tanh) du layer growl selon le drive. */
  _curve(drive) {
    const n = 1024, c = new Float32Array(n), k = 2 + drive * 10;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  _applyParams() {
    const b = this.state.get('bass');
    const t = this.ctx.currentTime;
    this.growlShaper.curve = this._curve(b.drive);
    this.subAmp.gain.setTargetAtTime(1.0, t, 0.02);
    this.growlAmp.gain.setTargetAtTime(b.growl, t, 0.02);
    this.toneLP.frequency.setTargetAtTime(clamp(b.tone, 80, 4000), t, 0.02);
    this.level.gain.setTargetAtTime(b.on ? b.level : 0.0001, t, 0.02);
  }

  /**
   * Joue une note de basse.
   * @param {number} time
   * @param {number} freq - Hz (déjà accordé à la section)
   * @param {number} [dur]
   * @param {number} [vel]
   */
  trigger(time, freq, dur, vel = 1) {
    const b = this.state.get('bass');
    if (!b.on) return;
    const f = clamp(freq * Math.pow(2, b.octave), 20, 400);
    const d = dur || b.decay;

    // Pitch : glide OU chute de pitch à l'attaque (punch/thump).
    const fs = this.oscSub.frequency, fg = this.oscGrowl.frequency;
    fs.cancelScheduledValues(time); fg.cancelScheduledValues(time);
    if (b.glide > 0) {
      fs.linearRampToValueAtTime(f, time + b.glide);
      fg.linearRampToValueAtTime(f, time + b.glide);
    } else {
      const top = f * (1 + b.punch * 0.6);     // démarre plus haut -> "thump"
      fs.setValueAtTime(top, time); fs.exponentialRampToValueAtTime(f, time + 0.02);
      fg.setValueAtTime(top, time); fg.exponentialRampToValueAtTime(f, time + 0.02);
    }

    // Enveloppe d'amplitude : attaque rapide, decay exponentiel.
    const g = this.vca.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0.0001, time);
    g.linearRampToValueAtTime(vel, time + 0.004);
    g.exponentialRampToValueAtTime(0.0001, time + d);
  }

  /**
   * Sidechain interne : plonge la basse brièvement (sous un kick) puis
   * remonte -> garde le bas du spectre net quand basse et kick se croisent.
   */
  duck(time) {
    if (!this.state.get('bass').sidechain) return;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(0.3, time + 0.004);
    g.linearRampToValueAtTime(1, time + 0.09);
  }

  dispose() { if (this._unsub) { this._unsub(); this._unsub = null; } }
}
