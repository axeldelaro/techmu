/* =====================================================================
   HardcoreKick.js — Synthèse de kick "destructeur" 100% mathématique
   (aucun sample). Multi-layering (Click + Body/Sub + Noise) -> Drive
   (WaveShaper multi-courbes) -> EQ paramétrique post-distorsion.
   Chaque déclenchement reconstruit un graphe de nœuds éphémères,
   programmés de façon sample-accurate sur l'horloge de l'AudioContext.
   ===================================================================== */

import { clamp } from '../utils.js';

export class HardcoreKick {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination - entrée du bus master
   * @param {import('../StateManager.js').StateManager} state
   */
  constructor(ctx, destination, state) {
    this.ctx = ctx;
    this.state = state;

    // Cache des courbes de distorsion (recalculées si "drive" change).
    this._curveCache = new Map();

    // Bruit blanc pré-généré (réutilisé, lecture en boucle tranchée).
    this.noiseBuffer = this._makeNoiseBuffer();

    // --- Chaîne fixe partagée par tous les hits : Drive -> WaveShaper -> EQ -> Level ---
    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x'; // réduit l'aliasing de la distorsion
    this.eq = ctx.createBiquadFilter();
    this.eq.type = 'peaking';
    this.levelGain = ctx.createGain();

    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.eq);
    this.eq.connect(this.levelGain);
    this.levelGain.connect(destination);

    this._applyParams();
    // Réagit aux changements de la section kick.
    this.state.on('kick', () => this._applyParams());
  }

  /** Applique les paramètres d'état sur la chaîne fixe. */
  _applyParams() {
    const k = this.state.get('kick');
    const t = this.ctx.currentTime;
    // Drive: pré-gain qui écrase le signal dans la courbe.
    this.driveGain.gain.setTargetAtTime(1 + k.drive * 24, t, 0.01);
    this.shaper.curve = this._getCurve(k.curve);
    this.eq.frequency.setTargetAtTime(k.eqFreq, t, 0.01);
    this.eq.gain.setTargetAtTime(k.eqGain, t, 0.01);
    this.eq.Q.value = 1.1;
    this.levelGain.gain.setTargetAtTime(k.level, t, 0.01);
  }

  /** Génère 2s de bruit blanc mono, réutilisé pour le layer industriel. */
  _makeNoiseBuffer() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Retourne (et met en cache) une courbe de transfert pour le WaveShaperNode.
   * La courbe mappe l'amplitude d'entrée [-1..1] vers une sortie [-1..1].
   *
   * @param {('hardclip'|'foldback'|'softsat')} type
   * @returns {Float32Array} table de 2048 points
   */
  _getCurve(type) {
    if (this._curveCache.has(type)) return this._curveCache.get(type);
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // x parcourt linéairement [-1 .. +1]
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = this._shape(type, x);
    }
    this._curveCache.set(type, curve);
    return curve;
  }

  /**
   * Fonction de transfert de distorsion.
   *  - hardclip : écrêtage brutal symétrique (carré -> harmoniques riches).
   *  - foldback : repliement du signal au-delà du seuil (métallique, ring-ish).
   *  - softsat  : saturation douce type tanh (chaleur analogique).
   * @param {string} type
   * @param {number} x  amplitude d'entrée [-1..1]
   * @returns {number}  amplitude de sortie [-1..1]
   */
  _shape(type, x) {
    switch (type) {
      case 'hardclip': {
        const th = 0.35;            // seuil bas = beaucoup d'écrêtage
        return clamp(x / th, -1, 1);
      }
      case 'foldback': {
        const th = 0.5;
        let y = x;
        // Replie tant que |y| dépasse le seuil (jusqu'à 4 plis pour stabilité).
        for (let g = 0; g < 4 && Math.abs(y) > th; g++) {
          y = Math.abs(Math.abs((y - th) % (4 * th)) - 2 * th) - th;
        }
        return clamp(y / th, -1, 1);
      }
      case 'softsat':
      default: {
        const k = 5;                // raideur de la saturation
        return Math.tanh(k * x) / Math.tanh(k);
      }
    }
  }

  /**
   * Déclenche un kick à l'instant `time` (horloge AudioContext).
   * @param {number} time  - heure absolue de déclenchement (s)
   * @param {number} [vel] - vélocité 0..1
   * @param {object} [opts] - overrides par hit (arrangement Auto-Remix) :
   *   opts.tune  (Hz)   -> fondamentale du body pour CE kick
   *   opts.decay (s)    -> longueur de la queue (rumble) pour CE kick
   *   opts.drive (1..n) -> pré-gain de distorsion programmé pour CE kick
   */
  trigger(time, vel = 1, opts = null) {
    const k = this.state.get('kick');
    const ctx = this.ctx;
    const tune = opts && opts.tune ? opts.tune : k.tune;
    const decay = opts && opts.decay ? opts.decay : k.decay;
    // Drive par hit (pour varier l'agressivité selon la section).
    if (opts && opts.drive) this.driveGain.gain.setValueAtTime(opts.drive, time);

    // ---------- LAYER 1 : CLICK / PUNCH (transient) ----------
    // Oscillateur très court avec chute de pitch quasi instantanée.
    const click = ctx.createOscillator();
    click.type = 'triangle';
    const clickGain = ctx.createGain();
    click.frequency.setValueAtTime(k.clickPitch, time);
    click.frequency.exponentialRampToValueAtTime(tune * 1.5, time + 0.008);
    clickGain.gain.setValueAtTime(k.clickAmount * vel, time);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);
    click.connect(clickGain).connect(this.driveGain);
    click.start(time);
    click.stop(time + 0.04);

    // ---------- LAYER 2 : BODY / SUB ----------
    // Sinus avec enveloppe de pitch descendante + ADSR d'amplitude.
    const body = ctx.createOscillator();
    body.type = 'sine';
    const bodyGain = ctx.createGain();
    const startPitch = Math.min(k.clickPitch * 0.5, 400);
    body.frequency.setValueAtTime(startPitch, time);
    // Chute de pitch -> "boom". Plus la chute est longue, plus c'est gras.
    body.frequency.exponentialRampToValueAtTime(tune, time + 0.06);
    // ADSR : attaque immédiate, decay réglable.
    bodyGain.gain.setValueAtTime(0.0001, time);
    bodyGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    body.connect(bodyGain).connect(this.driveGain);
    body.start(time);
    body.stop(time + decay + 0.05);

    // ---------- LAYER 3 : NOISE (texture industrielle) ----------
    if (k.noise > 0.001) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      noise.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 1800;
      nf.Q.value = 0.7;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(k.noise * vel, time);
      nGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      noise.connect(nf).connect(nGain).connect(this.driveGain);
      noise.start(time);
      noise.stop(time + 0.08);
    }
  }
}
