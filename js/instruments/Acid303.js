/* =====================================================================
   Acid303.js — Émulateur TB-303 basique.
   OscillatorNode (saw/square) -> BiquadFilter (lowpass, Q élevé).
   L'enveloppe de filtre (Env Mod) module la coupure à chaque note pour
   produire le "squelch" acide. Gestion de l'accent et du glide (slide).
   ===================================================================== */

import { midiToFreq } from '../utils.js';

export class Acid303 {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   * @param {import('../StateManager.js').StateManager} state
   */
  constructor(ctx, destination, state) {
    this.ctx = ctx;
    this.state = state;

    // --- Chaîne mono-voix persistante (typique d'un synthé monophonique 303) ---
    this.osc = ctx.createOscillator();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.vca = ctx.createGain();      // amplificateur contrôlé par enveloppe
    this.vca.gain.value = 0.0001;
    this.out = ctx.createGain();

    this.osc.connect(this.filter).connect(this.vca).connect(this.out).connect(destination);

    const a = state.get('acid');
    this.osc.type = a.wave;
    this.osc.frequency.value = midiToFreq(a.rootMidi);
    this.osc.start();

    this._applyParams();
    state.on('acid', () => this._applyParams());
  }

  _applyParams() {
    const a = this.state.get('acid');
    this.osc.type = a.wave;
    this.filter.Q.value = a.resonance;
    this.out.gain.setTargetAtTime(a.level, this.ctx.currentTime, 0.01);
  }

  /**
   * Joue une note à l'instant `time`.
   * @param {number} time      - heure absolue (s)
   * @param {number} semitone  - offset en demi-tons depuis la root
   * @param {boolean} accent   - renforce volume + résonance + env
   * @param {boolean} slide    - active le portamento depuis la note précédente
   */
  trigger(time, semitone, accent, slide) {
    const a = this.state.get('acid');
    const ctx = this.ctx;
    const freq = midiToFreq(a.rootMidi + semitone);

    // --- Pitch + glide ---
    // Le slide effectue une rampe de fréquence (portamento) plutôt qu'un saut.
    if (slide) {
      this.osc.frequency.linearRampToValueAtTime(freq, time + a.glide);
    } else {
      this.osc.frequency.setValueAtTime(freq, time);
    }

    // --- Enveloppe de filtre (le cœur du son acid) ---
    // La coupure saute à cutoff + envMod puis décroît exponentiellement
    // vers cutoff. L'accent augmente la profondeur de modulation.
    const accMul = accent ? 1 + a.accentAmt : 1;
    const peak = a.cutoff + a.envMod * accMul;
    const f = this.filter.frequency;
    f.cancelScheduledValues(time);
    f.setValueAtTime(Math.min(peak, ctx.sampleRate / 2 - 1000), time);
    f.exponentialRampToValueAtTime(Math.max(a.cutoff, 30), time + a.envDecay);

    // Résonance renforcée sur les accents pour un squelch plus mordant.
    this.filter.Q.setValueAtTime(a.resonance * (accent ? 1.25 : 1), time);

    // --- Enveloppe d'amplitude (VCA) ---
    const peakAmp = accent ? 1.0 : 0.7;
    const g = this.vca.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0.0001, time);
    g.linearRampToValueAtTime(peakAmp, time + 0.005);
    g.exponentialRampToValueAtTime(0.0001, time + a.envDecay + 0.05);
  }
}
