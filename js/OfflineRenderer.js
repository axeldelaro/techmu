/* =====================================================================
   OfflineRenderer.js — Export RAPIDE (bounce hors-ligne).
   Version optimisée : Export WAV asynchrone par blocs (chunks) pour
   éviter les gels CPU sur mobile.
   ===================================================================== */

import { HardcoreKick } from './instruments/HardcoreKick.js';
import { SubBass } from './instruments/SubBass.js';
import { Arrangement } from './Arrangement.js';
import { clamp } from './utils.js';

export class OfflineRenderer {
  constructor(engine, state, scheduler) {
    this.engine = engine;
    this.state = state;
    this.scheduler = scheduler;
  }

  async render(onProgress) {
    const buffer = this.engine.sampleBuffer;
    const structure = this.scheduler.arrangement ? this.scheduler.arrangement.s : null;
    const blob = await this.renderToBlob(buffer, structure, onProgress);
    this._download(blob, `uptempo-export.wav`);
  }

  async renderToBlob(buffer, structure, onProgress) {
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

    let fake = 30;
    // La barre monte jusqu'à 85% pendant le calcul du son
    const ticker = setInterval(() => { fake = Math.min(85, fake + 1); onProgress?.(fake); }, 200);
    let rendered;
    try {
      rendered = await Promise.race([
        octx.startRendering(),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('Rendu trop long (timeout 90s). Réduis la densité ou prends un morceau plus court.')),
          90000))
      ]);
    } finally {
      clearInterval(ticker);
      facade.kick.dispose(); facade.subBass.dispose();
    }
    
    // Le son est calculé, on passe à l'encodage WAV optimisé
    onProgress?.(90);
    const blob = await this._encodeWavAsync(rendered, onProgress);
    onProgress?.(100);
    return blob;
  }

  _buildGraph(octx, buffer) {
    const state = this.state;
    const fx = state.get('fx');
    const busInput = octx.createGain();

    const djFilter = octx.createBiquadFilter();
    if (fx.djFilterOn) this._applyDjFilter(djFilter, fx.djFilter, octx.sampleRate);
    else { djFilter.type = 'lowpass'; djFilter.frequency.value = 20000; djFilter.Q.value = 0.0001; }

    const gaterGain = octx.createGain();
    const masterGain = octx.createGain(); masterGain.gain.value = fx.masterLevel;

    const eqLow = octx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 180; eqLow.gain.value = fx.eqLow || 0;
    const eqHigh = octx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000; eqHigh.gain.value = fx.eqHigh || 0;

    const limiter = octx.createDynamicsCompressor();
    limiter.threshold.value = -1.0; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.05;

    busInput.connect(djFilter); djFilter.connect(gaterGain); gaterGain.connect(masterGain);
    masterGain.connect(eqLow); eqLow.connect(eqHigh); eqHigh.connect(limiter); limiter.connect(octx.destination);

    const sampleDuck = octx.createGain();
    const scComp = octx.createDynamicsCompressor();
    scComp.threshold.value = -16; scComp.ratio.value = 4; scComp.attack.value = 0.004;
    scComp.release.value = 0.16; scComp.knee.value = 6;
    const sampleGain = octx.createGain(); sampleGain.gain.value = state.get('sample.level');
    sampleDuck.connect(scComp); scComp.connect(sampleGain); sampleGain.connect(busInput);

    const kick = new HardcoreKick(octx, busInput, state);
    const subBass = new SubBass(octx, busInput, state);

    const facade = {
      ctx: octx, busInput, sampleDuck, gaterGain, kick, subBass, sampleBuffer: buffer, state,
      playSlice: (time, offset, dur, rate = 1, amp = 0.7) => {
        if (!buffer) return;
        const off = clamp(offset, 0, Math.max(0, buffer.duration - dur));
        const src = octx.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
        const g = octx.createGain();
        g.gain.setValueAtTime(0.0001, time); g.gain.linearRampToValueAtTime(amp, time + 0.003);
        g.gain.setValueAtTime(amp, time + dur * 0.85); g.gain.linearRampToValueAtTime(0.0001, time + dur);
        src.connect(g).connect(busInput); src.start(time, off, dur + 0.02); src.stop(time + dur + 0.03);
      },
      duck: (time, amount) => {
        const f = state.get('fx'); if (!f.sidechainOn) return;
        const amt = amount != null ? amount : f.sidechainAmount;
        const g = sampleDuck.gain, floor = clamp(1 - amt, 0.0001, 1);
        g.setValueAtTime(1, time); g.linearRampToValueAtTime(floor, time + 0.005);
        g.linearRampToValueAtTime(1, time + f.sidechainRelease);
      },
      gate: (time, stepDur) => {
        const g = gaterGain.gain;
        g.setValueAtTime(1, time); g.linearRampToValueAtTime(0.0001, time + 0.003); g.linearRampToValueAtTime(1, time + stepDur * 0.5);
      },
      playHat: (time, amp = 0.12) => this._noiseVoice(octx, busInput, kick.noiseBuffer, time, 0.04, 'highpass', 7000, 0.7, amp, 0.06),
      playClap: (time, amp = 0.22) => { for (let k = 0; k < 3; k++) this._noiseVoice(octx, busInput, kick.noiseBuffer, time + k * 0.008, 0.07, 'bandpass', 1700, 1.2, amp, 0.09); },
      playImpact: (time) => {
        const osc = octx.createOscillator(); osc.type = 'sine'; const g = octx.createGain();
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
        g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(0.28, time + durR); g.gain.linearRampToValueAtTime(0.0001, time + durR + 0.05);
        src.connect(bp).connect(g).connect(busInput); src.start(time); src.stop(time + durR + 0.1);
      },
      playReverseSwell: (time, dur, amp = 0.22) => {
        const src = octx.createBufferSource(); src.buffer = kick.noiseBuffer; src.loop = true;
        const bp = octx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 0.6;
        const g = octx.createGain();
        g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(amp, time + dur); g.gain.linearRampToValueAtTime(0.0001, time + dur + 0.02);
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

  _noiseVoice(octx, dest, noiseBuf, time, decay, type, freq, Q, amp, stop) {
    const src = octx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const filt = octx.createBiquadFilter(); filt.type = type; filt.frequency.value = freq; filt.Q.value = Q;
    const g = octx.createGain();
    g.gain.setValueAtTime(amp, time); g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    src.connect(filt).connect(g).connect(dest); src.start(time); src.stop(time + stop);
  }

  _applyDjFilter(node, pos, sr) {
    if (pos < 0.49) { node.type = 'lowpass'; node.frequency.value = 200 + Math.pow(pos / 0.49, 2) * 17800; node.Q.value = 2; }
    else if (pos > 0.51) { node.type = 'highpass'; node.frequency.value = 100 + Math.pow((pos - 0.51) / 0.49, 2) * 7900; node.Q.value = 2; }
    else { node.type = 'lowpass'; node.frequency.value = 20000; node.Q.value = 0.0001; }
  }

  _scheduleAll(facade, octx, dur, structure) {
    const bpm = structure && structure.kbpm ? structure.kbpm : this.state.get('transport.bpm');
    const secs16 = (60 / bpm) / 4;
    if (structure) {
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

  /**
   * Encode le Buffer WAV en blocs asynchrones pour ne pas freezer le mobile.
   */
  async _encodeWavAsync(buffer, onProgress) {
    // Rend la main au navigateur pour qu'il puisse peindre le "90%" à l'écran
    await new Promise(r => setTimeout(r, 50));

    const ch = Math.min(2, buffer.numberOfChannels);
    const L = buffer.getChannelData(0);
    const R = ch > 1 ? buffer.getChannelData(1) : L;
    const frames = buffer.length;
    const blockAlign = 4; // 2 canaux * 2 octets
    const dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);

    const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); w(8, 'WAVE'); w(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, dataSize, true);

    // Vue haute performance
    const pcm16 = new Int16Array(ab, 44);
    const CHUNK = 250000; // Traite par blocs d'environ 5 secondes

    for (let i = 0; i < frames; i += CHUNK) {
      const end = Math.min(i + CHUNK, frames);
      for (let j = i; j < end; j++) {
        const l = L[j], r = R[j];
        // Écrêtage et conversion rapide
        pcm16[j * 2] = l < 0 ? Math.max(-1, l) * 0x8000 : Math.min(1, l) * 0x7fff;
        pcm16[j * 2 + 1] = r < 0 ? Math.max(-1, r) * 0x8000 : Math.min(1, r) * 0x7fff;
      }
      
      // La progression passe de 90% à 100%
      const prog = 90 + Math.floor((end / frames) * 10);
      onProgress?.(prog);
      
      // Laisse le processeur "respirer" pour éviter que le navigateur plante la page
      await new Promise(r => setTimeout(r, 0));
    }

    return new Blob([ab], { type: 'audio/wav' });
  }

  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
