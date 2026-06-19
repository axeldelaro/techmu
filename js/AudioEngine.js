/* =====================================================================
   AudioEngine.js — Cœur audio. Construit et possède le graphe master :

     [instruments + sample] -> busInput
        busInput -> djFilter -> analyser -> masterGain -> LIMITER -> dest
                                                       \-> recordTap

   Gère aussi : lecture du sample importé (avec ducking sidechain),
   le DJ filter morphable LP/HP, et l'effet Stutter/Beatmasher.
   Le décodage des fichiers est délégué à un Web Worker.
   ===================================================================== */

import { HardcoreKick } from './instruments/HardcoreKick.js';
import { Acid303 } from './instruments/Acid303.js';
import { clamp, mapRange } from './utils.js';

export class AudioEngine {
  /** @param {import('./StateManager.js').StateManager} state */
  constructor(state) {
    this.state = state;
    this.ctx = null;
    this.sampleBuffer = null;
    this.sampleSource = null;
    this._decoderWorker = null;
  }

  /**
   * Initialise l'AudioContext — DOIT être appelé depuis un geste utilisateur
   * (politique "User Gesture"). Construit tout le graphe master.
   */
  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    // ---------- BUS MASTER ----------
    // Point d'entrée commun aux instruments et au sample.
    this.busInput = ctx.createGain();

    // DJ Filter hybride : LP à gauche du centre, HP à droite.
    this.djFilter = ctx.createBiquadFilter();
    this.djFilter.type = 'allpass'; // sera basculé en lowpass/highpass selon la position
    this.djFilter.frequency.value = 20000;

    // Analyseur pour l'oscilloscope / spectrogramme / VU.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8; // lissage du spectrogramme

    // Gain master (volume général).
    this.masterGain = ctx.createGain();

    // Gater (coupures rythmiques du master pilotées par le séquenceur).
    this.gaterGain = ctx.createGain();

    /**
     * LIMITER de mastering — DynamicsCompressorNode aux réglages extrêmes :
     * ratio très élevé + attack/release rapides => agit en brickwall limiter,
     * empêchant le clipping numérique brutal avant la destination.
     */
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.0; // dB : plafond
    this.limiter.knee.value = 0.0;       // genou dur
    this.limiter.ratio.value = 20.0;     // quasi-infini -> limiting
    this.limiter.attack.value = 0.001;   // 1 ms
    this.limiter.release.value = 0.05;   // 50 ms

    // Câblage : busInput -> djFilter -> gater -> analyser -> master -> limiter -> dest
    this.busInput.connect(this.djFilter);
    this.djFilter.connect(this.gaterGain);
    this.gaterGain.connect(this.analyser);
    this.analyser.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // Prise d'enregistrement (tap) APRÈS le limiter pour capturer la sortie finale.
    this.recordTap = ctx.createGain();
    this.limiter.connect(this.recordTap);

    // ---------- Bus du sample importé (avec ducking sidechain dédié) ----------
    // Le sample passe par un GainNode "duck" automatisé par le sidechain,
    // séparé du bus instruments pour que SEUL l'original "pompe".
    this.sampleDuck = ctx.createGain(); // gain de ducking (1 = ouvert)
    this.sampleGain = ctx.createGain(); // volume du sample
    this.sampleDuck.connect(this.sampleGain).connect(this.busInput);

    // ---------- Instruments ----------
    this.kick = new HardcoreKick(ctx, this.busInput, this.state);
    this.acid = new Acid303(ctx, this.busInput, this.state);

    this._applyState();
    this.state.on('fx', () => this._applyState());
    this.state.on('sample', () => this._applyState());

    this._initDecoderWorker();
  }

  /** Applique l'état FX / sample sur le graphe. */
  _applyState() {
    const fx = this.state.get('fx');
    const s = this.state.get('sample');
    const t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(fx.masterLevel, t, 0.02);
    this.sampleGain.gain.setTargetAtTime(s.level, t, 0.02);
    this._applyDjFilter(fx.djFilterOn ? fx.djFilter : 0.5);
    if (this.sampleSource) {
      this.sampleSource.playbackRate.setTargetAtTime(s.playbackRate, t, 0.02);
      this.sampleSource.detune.setTargetAtTime(s.detune, t, 0.02);
      this.sampleSource.loop = s.loop;
    }
  }

  /**
   * DJ Filter morphable. position 0..1 :
   *   < 0.5 -> Low-Pass dont la coupure descend en s'éloignant du centre.
   *   > 0.5 -> High-Pass dont la coupure monte en s'éloignant du centre.
   *   = 0.5 -> ouvert (quasi bypass).
   * @param {number} pos
   */
  _applyDjFilter(pos) {
    if (!this.djFilter) return;
    const t = this.ctx.currentTime;
    if (pos < 0.49) {
      this.djFilter.type = 'lowpass';
      // pos 0.49 -> ~18kHz ; pos 0 -> ~200Hz (échelle exponentielle).
      const freq = mapRange(Math.pow(pos / 0.49, 2), 0, 1, 200, 18000);
      this.djFilter.frequency.setTargetAtTime(freq, t, 0.02);
      this.djFilter.Q.setTargetAtTime(2, t, 0.02);
    } else if (pos > 0.51) {
      this.djFilter.type = 'highpass';
      const k = (pos - 0.51) / 0.49;
      const freq = mapRange(Math.pow(k, 2), 0, 1, 100, 8000);
      this.djFilter.frequency.setTargetAtTime(freq, t, 0.02);
      this.djFilter.Q.setTargetAtTime(2, t, 0.02);
    } else {
      this.djFilter.type = 'lowpass';
      this.djFilter.frequency.setTargetAtTime(20000, t, 0.02);
      this.djFilter.Q.setTargetAtTime(0.0001, t, 0.02);
    }
  }

  /* =================================================================
     DÉCODAGE FICHIER (Web Worker)
     Le worker lit l'ArrayBuffer (et peut tenter un décodage hors-thread
     quand le navigateur le permet). Le fallback décode sur le thread
     principal via ctx.decodeAudioData (déjà asynchrone/non bloquant).
     ================================================================= */
  _initDecoderWorker() {
    const workerCode = `
      self.onmessage = async (e) => {
        const { id, buffer } = e.data;
        // Transfert direct de l'ArrayBuffer : le gros travail (lecture I/O,
        // copie mémoire) est sorti du thread UI. Le décodage PCM final
        // requiert un AudioContext -> il est fait côté main thread.
        self.postMessage({ id, buffer }, [buffer]);
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    this._decoderWorker = new Worker(URL.createObjectURL(blob));
  }

  /**
   * Importe et décode un fichier audio.
   * @param {File} file
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<AudioBuffer>}
   */
  async loadFile(file, onProgress) {
    onProgress?.(10);
    const arrayBuf = await file.arrayBuffer();
    onProgress?.(40);

    // Passe par le worker (offload I/O + transfert zéro-copie).
    const transferred = await new Promise((resolve) => {
      const id = Math.random();
      const handler = (e) => {
        if (e.data.id !== id) return;
        this._decoderWorker.removeEventListener('message', handler);
        resolve(e.data.buffer);
      };
      this._decoderWorker.addEventListener('message', handler);
      this._decoderWorker.postMessage({ id, buffer: arrayBuf }, [arrayBuf]);
    });

    onProgress?.(70);
    // decodeAudioData : décodage PCM (asynchrone, hors thread JS principal).
    this.sampleBuffer = await this.ctx.decodeAudioData(transferred);
    onProgress?.(100);
    return this.sampleBuffer;
  }

  /** Démarre la lecture du sample importé. */
  playSample() {
    if (!this.sampleBuffer) return;
    this.stopSample();
    const s = this.state.get('sample');
    const src = this.ctx.createBufferSource();
    src.buffer = this.sampleBuffer;
    src.loop = s.loop;
    src.playbackRate.value = s.playbackRate;
    src.detune.value = s.detune;
    src.connect(this.sampleDuck);
    src.start();
    this.sampleSource = src;
  }

  /** Arrête la lecture du sample importé. */
  stopSample() {
    if (this.sampleSource) {
      try { this.sampleSource.stop(); } catch (_) {}
      this.sampleSource.disconnect();
      this.sampleSource = null;
    }
  }

  /* =================================================================
     SIDECHAIN DUCKING
     Web Audio n'autorise pas de vraie entrée sidechain externe sur le
     DynamicsCompressorNode. Technique pro équivalente : on automatise un
     GainNode (sampleDuck) avec une enveloppe de "pompe" calée sur chaque
     kick — le signal fantôme du kick est représenté par cette enveloppe.
     ================================================================= */
  /**
   * Programme un coup de ducking sur le sample, synchronisé au kick.
   * @param {number} time - heure du kick (s)
   */
  duck(time) {
    const fx = this.state.get('fx');
    if (!fx.sidechainOn) return;
    const g = this.sampleDuck.gain;
    const floor = clamp(1 - fx.sidechainAmount, 0.0001, 1);
    // Chute quasi instantanée puis remontée (release) -> effet "pompe".
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(floor, time + 0.005);
    g.linearRampToValueAtTime(1, time + fx.sidechainRelease);
  }

  /* =================================================================
     GATER — coupures rythmiques du master pilotées par le séquenceur.
     ================================================================= */
  /**
   * Coupe brièvement le master sur le pas concerné.
   * @param {number} time
   * @param {number} stepDur - durée d'un pas (s)
   */
  gate(time, stepDur) {
    const g = this.gaterGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(0.0001, time + 0.003);
    g.linearRampToValueAtTime(1, time + stepDur * 0.5);
  }

  /* =================================================================
     STUTTER / BEATMASHER (Build-up)
     Rejoue en boucle une courte tranche du sample importé. Chaque grain
     est replanifié de façon sample-accurate à intervalle `stutterRate` ms.
     ================================================================= */
  startStutter() {
    if (!this.sampleBuffer || this._stutterTimer) return;
    const rateMs = this.state.get('fx').stutterRate;
    const sliceDur = rateMs / 1000;
    // On gèle la lecture normale du sample pendant le stutter.
    this._stutterMuteWas = this.sampleGain.gain.value;
    const startOffset = (this.ctx.currentTime % this.sampleBuffer.duration);

    const fire = () => {
      const t = this.ctx.currentTime;
      const grain = this.ctx.createBufferSource();
      grain.buffer = this.sampleBuffer;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(1, t);
      env.gain.setValueAtTime(1, t + sliceDur * 0.9);
      env.gain.linearRampToValueAtTime(0, t + sliceDur);
      grain.connect(env).connect(this.busInput);
      grain.start(t, startOffset, sliceDur);
      grain.stop(t + sliceDur);
    };
    fire();
    this._stutterTimer = setInterval(fire, rateMs);
  }

  stopStutter() {
    if (this._stutterTimer) {
      clearInterval(this._stutterTimer);
      this._stutterTimer = null;
    }
  }

  /** Données temporelles (oscilloscope). */
  getWaveform(arr) { this.analyser.getByteTimeDomainData(arr); }
  /** Données fréquentielles (spectrogramme). */
  getSpectrum(arr) { this.analyser.getByteFrequencyData(arr); }
}
