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
import { SubBass } from './instruments/SubBass.js';
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
    // EQ master 2 bandes (low-shelf + high-shelf) avant le limiter.
    this.eqLow = ctx.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 180;
    this.eqHigh = ctx.createBiquadFilter(); this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 4000;

    this.busInput.connect(this.djFilter);
    this.djFilter.connect(this.gaterGain);
    this.gaterGain.connect(this.analyser);
    this.analyser.connect(this.masterGain);
    this.masterGain.connect(this.eqLow);
    this.eqLow.connect(this.eqHigh);
    this.eqHigh.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // Prise d'enregistrement (tap) APRÈS le limiter pour capturer la sortie finale.
    this.recordTap = ctx.createGain();
    this.limiter.connect(this.recordTap);

    // ---------- Bus du sample importé (avec ducking sidechain dédié) ----------
    // Le sample passe par un GainNode "duck" automatisé par le sidechain,
    // séparé du bus instruments pour que SEUL l'original "pompe".
    // Chaîne : sampleDuck -> scComp (glue/sidechain) -> sampleGain -> busInput
    this.sampleDuck = ctx.createGain(); // gain de ducking (1 = ouvert)
    this.sampleGain = ctx.createGain(); // volume du sample

    // Compresseur sidechain dédié à la piste d'origine. Réglages "glue"
    // par défaut ; reconfiguré agressivement par l'Auto-Remix v11.
    this.scComp = ctx.createDynamicsCompressor();
    this.scComp.threshold.value = -24;
    this.scComp.knee.value = 6;
    this.scComp.ratio.value = 4;
    this.scComp.attack.value = 0.01;
    this.scComp.release.value = 0.18;

    this.sampleDuck.connect(this.scComp);
    this.scComp.connect(this.sampleGain).connect(this.busInput);

    // ---------- Instruments ----------
    this.kick = new HardcoreKick(ctx, this.busInput, this.state);
    this.subBass = new SubBass(ctx, this.busInput, this.state);

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
    if (this.eqLow) this.eqLow.gain.setTargetAtTime(fx.eqLow || 0, t, 0.02);
    if (this.eqHigh) this.eqHigh.gain.setTargetAtTime(fx.eqHigh || 0, t, 0.02);
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
    this.sampleBuffer = await this.decodeFile(file, onProgress);
    return this.sampleBuffer;
  }

  /**
   * Décode un fichier en AudioBuffer SANS l'enregistrer (non destructif).
   * Utilisé par le traitement en lot pour ne pas perturber la session.
   * @param {File} file
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<AudioBuffer>}
   */
  async decodeFile(file, onProgress) {
    onProgress?.(10);
    const arrayBuf = await file.arrayBuffer();
    onProgress?.(40);
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
    const buf = await this.ctx.decodeAudioData(transferred);
    onProgress?.(100);
    return buf;
  }

  /** Démarre la lecture du sample importé. */
  playSample() { this.playSampleAt(this.ctx.currentTime + 0.02, 0); }

  /**
   * Démarre la lecture du sample à une heure absolue précise, depuis un
   * offset interne (s). Utilisé par l'Auto-Remix v11 pour l'alignement de
   * phase : on lance la musique de telle sorte que son premier downbeat
   * tombe pile sur le pas 0 du séquenceur.
   * @param {number} when   - heure absolue AudioContext (s)
   * @param {number} offset - position de départ dans le buffer (s)
   */
  playSampleAt(when, offset = 0) {
    if (!this.sampleBuffer) return;
    this.stopSample();
    const s = this.state.get('sample');
    const src = this.ctx.createBufferSource();
    src.buffer = this.sampleBuffer;
    src.loop = s.loop;
    src.playbackRate.value = s.playbackRate;
    src.detune.value = s.detune;
    src.connect(this.sampleDuck);
    src.start(when, Math.max(0, offset));
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
   * @param {number} [amount] - profondeur 0..1 (override de fx.sidechainAmount).
   *   Permet à l'arrangement de ducker peu en couplet, plus en refrain,
   *   tout en gardant l'original bien présent (style Unicorn On K).
   */
  duck(time, amount) {
    const fx = this.state.get('fx');
    if (!fx.sidechainOn) return;
    const amt = amount != null ? amount : fx.sidechainAmount;
    const g = this.sampleDuck.gain;
    const floor = clamp(1 - amt, 0.0001, 1);
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(floor, time + 0.005);
    g.linearRampToValueAtTime(1, time + fx.sidechainRelease);
  }

  /* =================================================================
     PERCUSSION & FX synthétiques (arrangement Auto-Remix).
     Petits générateurs éphémères branchés sur le bus master.
     ================================================================= */
  /** Hi-hat : bruit court filtré passe-haut. */
  playHat(time, amp = 0.12) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    src.connect(hp).connect(g).connect(this.busInput);
    src.start(time); src.stop(time + 0.06);
  }
  /** Clap : 3 salves de bruit en bande passante. */
  playClap(time, amp = 0.22) {
    const ctx = this.ctx;
    for (let k = 0; k < 3; k++) {
      const t = time + k * 0.008;
      const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      src.connect(bp).connect(g).connect(this.busInput);
      src.start(t); src.stop(t + 0.09);
    }
  }
  /** Impact de drop : boom sub + crash de bruit. */
  playImpact(time) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(80, time);
    osc.frequency.exponentialRampToValueAtTime(35, time + 0.2);
    g.gain.setValueAtTime(0.9, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.4);
    osc.connect(g).connect(this.busInput);
    osc.start(time); osc.stop(time + 0.45);
    const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 0.8;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.35, time); ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    src.connect(bp).connect(ng).connect(this.busInput); src.start(time); src.stop(time + 0.4);
  }
  /**
   * Vocal/sample chop : rejoue une courte tranche du sample importé (stutter
   * "greazy" très Unicorn On K). `offset` = position dans le morceau (s).
   */
  playSlice(time, offset, dur, rate = 1, amp = 0.7) {
    if (!this.sampleBuffer) return;
    const ctx = this.ctx;
    const off = clamp(offset, 0, Math.max(0, this.sampleBuffer.duration - dur));
    const src = ctx.createBufferSource(); src.buffer = this.sampleBuffer; src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(amp, time + 0.003);
    g.gain.setValueAtTime(amp, time + dur * 0.85);
    g.gain.linearRampToValueAtTime(0.0001, time + dur);
    src.connect(g).connect(this.busInput);
    src.start(time, off, dur + 0.02);
    src.stop(time + dur + 0.03);
  }

  /** Reverse swell (cymbale inversée) : volume qui enfle puis coupe sec. */
  playReverseSwell(time, dur, amp = 0.22) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(amp, time + dur);   // enfle
    g.gain.linearRampToValueAtTime(0.0001, time + dur + 0.02); // coupe sec
    src.connect(bp).connect(g).connect(this.busInput);
    src.start(time); src.stop(time + dur + 0.05);
  }

  /** Downlifter : balayage de bruit vers le bas (fin de drop / chute). */
  playSweepDown(time, dur, amp = 0.2) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(8000, time);
    bp.frequency.exponentialRampToValueAtTime(200, time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(bp).connect(g).connect(this.busInput);
    src.start(time); src.stop(time + dur + 0.05);
  }

  /** Riser de build-up : bruit dont la bande monte + volume croissant. */
  playRiser(time, dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.kick.noiseBuffer; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(500, time);
    bp.frequency.exponentialRampToValueAtTime(8000, time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.28, time + dur);
    g.gain.linearRampToValueAtTime(0.0001, time + dur + 0.05);
    src.connect(bp).connect(g).connect(this.busInput);
    src.start(time); src.stop(time + dur + 0.1);
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

  /* =================================================================
     v11 — Configuration sidechain agressive (Auto-Remix).
     Règle le DynamicsCompressorNode de la piste d'origine en mode
     "pumping" extrême. Le déclenchement (gain reduction) est calé sur
     le Kick généré via l'enveloppe duck() programmée par le Scheduler —
     la Web Audio API n'exposant pas d'entrée sidechain externe, cette
     enveloppe fantôme synchronisée au kick EST le signal de déclenchement.
     ================================================================= */
  configureAutoSidechain() {
    const t = this.ctx.currentTime;
    // Style Unicorn On K : compresseur "glue" doux, PAS une pompe extrême.
    // L'original doit rester au premier plan ; la profondeur réelle du
    // ducking est gérée par l'arrangement (peu en couplet, plus en refrain).
    this.scComp.threshold.setValueAtTime(-16, t);
    this.scComp.ratio.setValueAtTime(4, t);
    this.scComp.attack.setValueAtTime(0.004, t);
    this.scComp.release.setValueAtTime(0.16, t);
    this.scComp.knee.setValueAtTime(6, t);
    this.state.set('fx.sidechainOn', true);
    this.state.set('fx.sidechainAmount', 0.4);   // ducking léger par défaut
    this.state.set('fx.sidechainRelease', 0.16);
    // L'original mène : volume haut, pas de pitch-shift.
    this.state.set('sample.level', 0.98);
    this.state.set('fx.masterLevel', 0.9);
  }

  /** Données temporelles (oscilloscope). */
  getWaveform(arr) { this.analyser.getByteTimeDomainData(arr); }
  /** Données fréquentielles (spectrogramme). */
  getSpectrum(arr) { this.analyser.getByteFrequencyData(arr); }
}
