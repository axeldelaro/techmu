/* =====================================================================
   StateManager.js — Source de vérité unique (Single Source of Truth).
   Détient tout l'état sérialisable de la machine : paramètres des
   instruments, patterns du séquenceur, FX. Publie des évènements de
   changement (pattern observateur) consommés par l'AudioEngine et l'UI.
   Persistance JSON via localStorage.
   ===================================================================== */

const STORAGE_KEY = 'uptempo-web-daw-state-v10';

/** État par défaut de la machine. */
function defaultState() {
  return {
    transport: { bpm: 180, swing: 0.0, playing: false },

    // 16 pas par piste. kick/acid: bool ; acid stocke aussi note + accent ; gater coupe le master.
    sequencer: {
      kick:  new Array(16).fill(false),
      acid:  new Array(16).fill(false),
      gater: new Array(16).fill(false),
      acidNotes:   new Array(16).fill(0),   // offset demi-tons depuis la root
      acidAccents: new Array(16).fill(false)
    },

    kick: {
      tune: 50,          // Hz fondamentale du body
      clickAmount: 0.6,  // niveau du layer click
      clickPitch: 2200,  // Hz de départ du transient
      decay: 0.45,       // s décroissance body
      noise: 0.25,       // niveau noise layer
      drive: 0.55,       // 0..1 -> intensité waveshaper
      curve: 'hardclip', // hardclip | foldback | softsat
      eqFreq: 1200,      // Hz EQ post-distorsion (mediums baveux)
      eqGain: 6,         // dB
      level: 0.9,
      tonal: true,       // kick "tonal" (la hauteur suit un riff dans le refrain)
      scale: 'minorPent' // gamme du riff tonal
    },

    // Layer de BASSE dédié (sub) — joué par l'arrangement, accordé par section.
    bass: {
      on: true,
      level: 0.5,
      decay: 0.16,       // s
      octave: 0,         // décalage d'octave global
      glide: 0.0,        // s portamento entre notes
      drive: 0.3,        // saturation douce
      mode: 'offbeat'    // offbeat | sustain | root
    },

    acid: {
      wave: 'sawtooth',
      rootMidi: 33,      // A1
      cutoff: 600,       // Hz fréquence de coupure de base
      resonance: 18,     // Q (résonance élevée typique 303)
      envMod: 2500,      // Hz amplitude de l'enveloppe de filtre
      envDecay: 0.25,    // s
      accentAmt: 0.6,
      level: 0.7,
      glide: 0.06        // s portamento (slide)
    },

    fx: {
      djFilter: 0.5,     // 0 = LP extrême, 0.5 = bypass, 1 = HP extrême
      djFilterOn: false,
      sidechainOn: true,
      sidechainAmount: 0.8, // profondeur du ducking (0..1)
      sidechainRelease: 0.18,
      stutterRate: 60,   // ms taille de la tranche stutter (build-up)
      masterLevel: 0.85,
      eqLow: 0,          // dB low-shelf master
      eqHigh: 0          // dB high-shelf master
    },

    sample: {
      playbackRate: 1.0,
      detune: 0,
      loop: true,
      level: 0.8
    }
  };
}

export class StateManager {
  constructor() {
    this.state = defaultState();
    /** @type {Map<string, Set<Function>>} */
    this._subs = new Map();
  }

  /** Abonne un callback à une clé de chemin ('kick.drive', 'sequencer', '*'…). */
  on(path, cb) {
    if (!this._subs.has(path)) this._subs.set(path, new Set());
    this._subs.get(path).add(cb);
    return () => this._subs.get(path).delete(cb);
  }

  /** Notifie les abonnés du chemin exact + abonnés joker '*'. */
  _emit(path, value) {
    if (this._subs.has(path)) this._subs.get(path).forEach((cb) => cb(value, path));
    if (this._subs.has('*')) this._subs.get('*').forEach((cb) => cb(value, path));
  }

  /** Lit une valeur via chemin pointé ('kick.drive'). */
  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.state);
  }

  /** Écrit une valeur via chemin pointé et émet l'évènement de changement. */
  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], this.state);
    target[last] = value;
    this._emit(path, value);
    // Émet aussi sur le parent immédiat pour les abonnés "section" (ex: 'kick').
    if (keys.length) this._emit(keys.join('.'), this.get(keys.join('.')));
  }

  /** Toggle d'un pas du séquenceur. */
  toggleStep(track, index) {
    const arr = this.state.sequencer[track];
    arr[index] = !arr[index];
    this._emit('sequencer', this.state.sequencer);
    return arr[index];
  }

  /** Sérialise l'état complet vers localStorage. */
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    return true;
  }

  /** Recharge l'état depuis localStorage (merge profond défensif). */
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      this.state = this._merge(defaultState(), parsed);
      this._emit('*', this.state);
      return true;
    } catch (e) {
      console.warn('State load failed', e);
      return false;
    }
  }

  /** Merge récursif: garantit la présence de toutes les clés par défaut. */
  _merge(base, override) {
    if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base;
    if (typeof base === 'object' && base !== null) {
      const out = {};
      for (const k of Object.keys(base)) {
        out[k] = k in (override || {}) ? this._merge(base[k], override[k]) : base[k];
      }
      return out;
    }
    return override === undefined ? base : override;
  }
}
