/* =====================================================================
   OfflineRenderer.js — Export RAPIDE (bounce hors-ligne).

   Au lieu d'enregistrer en temps réel (MediaRecorder), on reconstruit le
   graphe audio dans un OfflineAudioContext et on le rend PLUS VITE que le
   temps réel : un morceau de 3 min s'exporte en ~1-2 s.

   Le rendu honore TOUS les réglages courants (knobs kick, sidechain, FX,
   volume) puisqu'on réutilise le même StateManager + HardcoreKick, et le
   même moteur d'Arrangement que la lecture live -> l'export sonne EXACTEMENT
   comme ce que tu entends.
   ===================================================================== */

import { HardcoreKick } from './instruments/HardcoreKick.js';
import { SubBass } from './instruments/SubBass.js';
import { Arrangement } from './Arrangement.js';
import { clamp } from './utils.js';

export class OfflineRenderer {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine
   * @param {import('./StateManager.js').StateManager} state
   * @param {import('./Scheduler.js').Scheduler} scheduler
   */
  constructor(engine, state, scheduler) {
    this.engine = engine;
    this.state = state;
    this.scheduler = scheduler;
  }

  /**
   * Rend la configuration courante et déclenche le téléchargement.
   * @param {('mp3'|'wav')} [format]
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<void>}
   */
  async render(format = 'mp3', onProgress) {
    const buffer = this.engine.sampleBuffer;
    const structure = this.scheduler.arrangement ? this.scheduler.arrangement.s : null;
    const blob = await this.renderToBlob(buffer, structure, format, onProgress);
    this._download(blob, `uptempo-export.${blob.type.includes('mpeg') ? 'mp3' : 'wav'}`);
  }

  /**
   * Rend un buffer + une structure d'arrangement en Blob (sans téléchargement).
   * Réutilisé par l'export simple ET le traitement en lot. Applique les
   * réglages de son COURANTS (kick/bass/fx) à chaque rendu.
   * @param {AudioBuffer} buffer
   * @param {object|null} structure - structure d'arrangement (ou null = pattern)
   * @param {('mp3'|'wav')} [format]
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<Blob>}
   */
  async renderToBlob(buffer, structure, format = 'mp3', onProgress) {
    if (format === 'mp3' && typeof lamejs === 'undefined') format = 'wav';
    const sr = this.engine.ctx.sampleRate;
    const downbeat = structure ? structure.downbeat : 0;

    let dur;
    if (structure && buffer) dur = (buffer.duration - downbeat) + 1.0;
    else if (buffer) dur = buffer.duration + 0.5;
    else dur = (60 / this.state.get('transport.bpm')) * 4 * 16;
    dur = Math.max(2, dur);

    onProgress?.(5);
    const octx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const facade = this._buildGraph(octx, buffer);

    if (buffer) {
      const s = this.state.get('sample');
      const src = octx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = s.playbackRate;
      src.detune.value = s.detune;
      src.loop = structure ? false : s.loop;
      src.connect(facade.sampleDuck);
      src.start(0, structure ? Math.max(0, downbeat) : 0);
    }

    onProgress?.(15);
    this._scheduleAll(facade, octx, dur, structure);
    onProgress?.(30);

    // Progression PENDANT le rendu via suspend()/resume() : évite l'impression
    // de blocage à 30% sur les longs morceaux et confirme l'avancement réel.
    const total = octx.length / sr;
    const SLICES = 15;
    for (let i = 1; i < SLICES; i++) {
      const at = total * i / SLICES;
      octx.suspend(at).then(() => {
        onProgress?.(30 + Math.round((i / SLICES) * 30));
        octx.resume();
      }).catch(() => {});
    }

    const rendered = await octx.startRendering();
    facade.kick.dispose(); facade.subBass.dispose();
    onProgress?.(60);

    if (format === 'mp3') return this._encodeMp3(rendered, (p) => onProgress?.(60 + Math.round(p * 0.4)));
    onProgress?.(100);
    return this._encodeWav(rendered);
  }

  /**
   * Construit le graphe master + chaîne sample dans `octx`, à l'identique
   * du moteur live, et renvoie une façade compatible avec l'Arrangement.
   */
  _buildGraph(octx, buffer) {
    const state = this.state;
    const fx = state.get('fx');

    const busInput = octx.createGain();

    // DJ filter (bypass si désactivé).
    const djFilter = octx.createBiquadFilter();
    if (fx.djFilterOn) this._applyDjFilter(djFilter, fx.djFilter, octx.sampleRate);
    else { djFilter.type = 'lowpass'; djFilter.frequency.value = 20000; djFilter.Q.value = 0.0001; }

    const gaterGain = octx.createGain();
    const masterGain = octx.createGain(); masterGain.gain.value = fx.masterLevel;

    // EQ master 2 bandes (mêmes réglages qu'en live).
    const eqLow = octx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 180; eqLow.gain.value = fx.eqLow || 0;
    const eqHigh = octx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000; eqHigh.gain.value = fx.eqHigh || 0;

    // Limiter de mastering (mêmes réglages qu'en live).
    const limiter = octx.createDynamicsCompressor();
    limiter.threshold.value = -1.0; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.05;

    busInput.connect(djFilter); djFilter.connect(gaterGain); gaterGain.connect(masterGain);
    masterGain.connect(eqLow); eqLow.connect(eqHigh); eqHigh.connect(limiter); limiter.connect(octx.destination);

    // Chaîne sample : duck -> compresseur glue -> gain -> bus.
    const sampleDuck = octx.createGain();
    const scComp = octx.createDynamicsCompressor();
    scComp.threshold.value = -16; scComp.ratio.value = 4; scComp.attack.value = 0.004;
    scComp.release.value = 0.16; scComp.knee.value = 6;
    const sampleGain = octx.createGain(); sampleGain.gain.value = state.get('sample.level');
    sampleDuck.connect(scComp); scComp.connect(sampleGain); sampleGain.connect(busInput);

    // Instruments (lisent l'état -> tes réglages s'appliquent).
    const kick = new HardcoreKick(octx, busInput, state);
    const subBass = new SubBass(octx, busInput, state);

    // Façade exposant l'API attendue par l'Arrangement / le pattern.
    const facade = {
      ctx: octx, busInput, sampleDuck, gaterGain, kick, subBass, sampleBuffer: buffer, state,
      playSlice: (time, offset, dur, rate = 1, amp = 0.7) => {
        if (!buffer) return;
        const off = clamp(offset, 0, Math.max(0, buffer.duration - dur));
        const src = octx.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
        const g = octx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(amp, time + 0.003);
        g.gain.setValueAtTime(amp, time + dur * 0.85);
        g.gain.linearRampToValueAtTime(0.0001, time + dur);
        src.connect(g).connect(busInput);
        src.start(time, off, dur + 0.02); src.stop(time + dur + 0.03);
      },
      duck: (time, amount) => {
        const f = state.get('fx'); if (!f.sidechainOn) return;
        const amt = amount != null ? amount : f.sidechainAmount;
        const g = sampleDuck.gain, floor = clamp(1 - amt, 0.0001, 1);
        g.setValueAtTime(1, time);
        g.linearRampToValueAtTime(floor, time + 0.005);
        g.linearRampToValueAtTime(1, time + f.sidechainRelease);
      },
      gate: (time, stepDur) => {
        const g = gaterGain.gain;
        g.setValueAtTime(1, time);
        g.linearRampToValueAtTime(0.0001, time + 0.003);
        g.linearRampToValueAtTime(1, time + stepDur * 0.5);
      },
      // Perc/FX synthétiques identiques au moteur live.
      playHat: (time, amp = 0.12) => this._noiseVoice(octx, busInput, kick.noiseBuffer, time, 0.04, 'highpass', 7000, 0.7, amp, 0.06),
      playClap: (time, amp = 0.22) => {
        for (let k = 0; k < 3; k++) this._noiseVoice(octx, busInput, kick.noiseBuffer, time + k * 0.008, 0.07, 'bandpass', 1700, 1.2, amp, 0.09);
      },
      playImpact: (time) => {
        const osc = octx.createOscillator(); osc.type = 'sine';
        const g = octx.createGain();
        osc.frequency.setValueAtTime(80, time); osc.frequency.exponentialRampToValueAtTime(35, time + 0.2);
        g.gain.setValueAtTime(0.9, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.4);
        osc.connect(g).connect(busInput); osc.start(time); osc.stop(time + 0.45);
        this._noiseVoice(octx, busInput, kick.noiseBuffer, time, 0.35, 'bandpass', 3500, 0.8, 0.35, 0.4);
      },
      playRiser: (time, durR) => {
        const src = octx.createBufferSource(); src.buffer = kick.noiseBuffer; src.loop = true;
        const bp = octx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.5;
        bp.frequency.setValueAtTime(500, time); bp.frequency.exponentialRampToValueAtTime(8000, time + durR);
        const g = octx.createGain();
        g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(0.28, time + durR);
        g.gain.linearRampToValueAtTime(0.0001, time + durR + 0.05);
        src.connect(bp).connect(g).connect(busInput); src.start(time); src.stop(time + durR + 0.1);
      },
      playReverseSwell: (time, dur, amp = 0.22) => {
        const src = octx.createBufferSource(); src.buffer = kick.noiseBuffer; src.loop = true;
        const bp = octx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 0.6;
        const g = octx.createGain();
        g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(amp, time + dur);
        g.gain.linearRampToValueAtTime(0.0001, time + dur + 0.02);
        src.connect(bp).connect(g).connect(busInput); src.start(time); src.stop(time + dur + 0.05);
      },
      playSweepDown: (time, dur, amp = 0.2) => {
        const src = octx.createBufferSource(); src.buffer = kick.noiseBuffer; src.loop = true;
        const bp = octx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(8000, time); bp.frequency.exponentialRampToValueAtTime(200, time + dur);
        const g = octx.createGain();
        g.gain.setValueAtTime(amp, time); g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
        src.connect(bp).connect(g).connect(busInput); src.start(time); src.stop(time + dur + 0.05);
      }
    };
    return facade;
  }

  /** Voix de bruit générique (hat/clap/impact). */
  _noiseVoice(octx, dest, noiseBuf, time, decay, type, freq, Q, amp, stop) {
    const src = octx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const filt = octx.createBiquadFilter(); filt.type = type; filt.frequency.value = freq; filt.Q.value = Q;
    const g = octx.createGain();
    g.gain.setValueAtTime(amp, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    src.connect(filt).connect(g).connect(dest);
    src.start(time); src.stop(time + stop);
  }

  _applyDjFilter(node, pos, sr) {
    if (pos < 0.49) { node.type = 'lowpass'; node.frequency.value = 200 + Math.pow(pos / 0.49, 2) * 17800; node.Q.value = 2; }
    else if (pos > 0.51) { node.type = 'highpass'; node.frequency.value = 100 + Math.pow((pos - 0.51) / 0.49, 2) * 7900; node.Q.value = 2; }
    else { node.type = 'lowpass'; node.frequency.value = 20000; node.Q.value = 0.0001; }
  }

  /**
   * Programme tous les évènements de 0 à `dur` sur la timeline offline,
   * via l'Arrangement (si actif) ou le pattern 16 pas classique.
   */
  _scheduleAll(facade, octx, dur, structure) {
    // Grille = tempo de CETTE structure (essentiel pour le traitement en lot,
    // chaque morceau ayant son propre kbpm), sinon le transport courant.
    const bpm = structure && structure.kbpm ? structure.kbpm : this.state.get('transport.bpm');
    const secs16 = (60 / bpm) / 4;

    if (structure) {
      // Nouvelle instance d'Arrangement reliée à la façade offline.
      const arrangement = new Arrangement(facade, structure);
      let t = 0, sg = 0;
      while (t < dur) { arrangement.tick(sg, t); t += secs16; sg++; }
    } else {
      const seq = this.state.get('sequencer');
      let t = 0, sg = 0;
      while (t < dur) {
        const step = sg % 16;
        if (seq.kick[step]) { facade.kick.trigger(t, 1); facade.duck(t); }
        if (seq.gater[step]) facade.gate(t, secs16);
        t += secs16; sg++;
      }
    }
  }

  /** Encode l'AudioBuffer rendu en MP3 (lamejs, 192 kbps stéréo). */
  _encodeMp3(buffer, onProgress) {
    const enc = new lamejs.Mp3Encoder(2, buffer.sampleRate, 192);
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const BLOCK = 1152;
    const li = new Int16Array(BLOCK), ri = new Int16Array(BLOCK);
    const data = [];
    const toI16 = (x) => { x = x < -1 ? -1 : x > 1 ? 1 : x; return x < 0 ? x * 0x8000 : x * 0x7fff; };
    for (let i = 0; i < buffer.length; i += BLOCK) {
      const n = Math.min(BLOCK, buffer.length - i);
      for (let j = 0; j < n; j++) { li[j] = toI16(L[i + j]); ri[j] = toI16(R[i + j]); }
      const chunk = enc.encodeBuffer(li.subarray(0, n), ri.subarray(0, n));
      if (chunk.length) data.push(new Uint8Array(chunk));
      if ((i & 0x3ffff) === 0) onProgress?.(i / buffer.length);
    }
    const end = enc.flush();
    if (end.length) data.push(new Uint8Array(end));
    onProgress?.(1);
    return new Blob(data, { type: 'audio/mpeg' });
  }

  /** Convertit l'AudioBuffer rendu en WAV 16-bit stéréo. */
  _encodeWav(buffer) {
    const ch = Math.min(2, buffer.numberOfChannels);
    const L = buffer.getChannelData(0);
    const R = ch > 1 ? buffer.getChannelData(1) : L;
    const frames = buffer.length;
    const blockAlign = 4, dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize); const view = new DataView(ab);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); w(8, 'WAVE'); w(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < frames; i++) {
      const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
      view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
      view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
