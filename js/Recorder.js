/* =====================================================================
   Recorder.js — Export audio (Bouncing) en temps réel.
   (Version modifiée : Capture PCM brute WAV exclusivement)
   ===================================================================== */

export class Recorder {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.recording = false;
    this._pcmL = [];
    this._pcmR = [];
  }

  /**
   * Démarre l'enregistrement.
   */
  start() {
    if (this.recording) return;
    this.recording = true;
    const ctx = this.engine.ctx;

    this._pcmL = []; this._pcmR = [];
    this._proc = ctx.createScriptProcessor(4096, 2, 2);
    this._proc.onaudioprocess = (e) => {
      if (!this.recording) return;
      this._pcmL.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this._pcmR.push(new Float32Array(e.inputBuffer.getChannelData(1)));
    };
    this.engine.recordTap.connect(this._proc);
    
    // Le ScriptProcessor doit être connecté à une destination pour tourner.
    this._silent = ctx.createGain();
    this._silent.gain.value = 0;
    this._proc.connect(this._silent).connect(ctx.destination);
  }

  /**
   * Stoppe et déclenche le téléchargement du fichier.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.recording) return;
    this.recording = false;

    if (this._proc) {
      this.engine.recordTap.disconnect(this._proc);
      this._proc.disconnect();
      this._silent.disconnect();
      const blob = this._encodeWav(this._pcmL, this._pcmR, this.engine.ctx.sampleRate);
      this._download(blob, 'uptempo-export.wav');
      this._proc = null;
    }
  }

  /** Déclenche le téléchargement d'un Blob. */
  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Encode des blocs PCM float en WAV 16-bit stéréo entrelacé.
   * @param {Float32Array[]} chunksL
   * @param {Float32Array[]} chunksR
   * @param {number} sampleRate
   * @returns {Blob}
   */
  _encodeWav(chunksL, chunksR, sampleRate) {
    const merge = (chunks) => {
      const len = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    };
    const L = merge(chunksL), R = merge(chunksR);
    const frames = L.length;
    const blockAlign = 4; // 2 canaux * 2 octets
    const dataSize = frames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    // En-tête RIFF/WAVE.
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);        // taille du sous-chunk fmt
    view.setUint16(20, 1, true);         // PCM
    view.setUint16(22, 2, true);         // canaux
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);        // bits par échantillon
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    // Échantillons entrelacés L/R, conversion float -> int16.
    let off = 44;
    for (let i = 0; i < frames; i++) {
      const l = Math.max(-1, Math.min(1, L[i]));
      const r = Math.max(-1, Math.min(1, R[i]));
      view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
      view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }
}
