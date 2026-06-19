/* =====================================================================
   Recorder.js — Export audio (Bouncing) en temps réel.
   Capture PCM brute WAV avec encodage asynchrone sécurisé anti-crash.
   ===================================================================== */

export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.recording = false;
    this._pcmL = [];
    this._pcmR = [];
  }

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
    
    this._silent = ctx.createGain();
    this._silent.gain.value = 0;
    this._proc.connect(this._silent).connect(ctx.destination);
  }

  async stop() {
    if (!this.recording) return;
    this.recording = false;

    if (this._proc) {
      this.engine.recordTap.disconnect(this._proc);
      this._proc.disconnect();
      this._silent.disconnect();
      const blob = await this._encodeWavAsync(this._pcmL, this._pcmR, this.engine.ctx.sampleRate);
      this._download(blob, 'uptempo-export.wav');
      this._proc = null;
    }
  }

  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _encodeWavAsync(chunksL, chunksR, sampleRate) {
    // Yield pour laisser l'interface respirer
    await new Promise(r => setTimeout(r, 20));

    const merge = (chunks) => {
      const len = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    };
    
    const L = merge(chunksL), R = merge(chunksR);
    const frames = L.length;
    const blockAlign = 4;
    const dataSize = frames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, dataSize, true);

    const pcm16 = new Int16Array(buffer, 44);
    const CHUNK = 250000;

    for (let i = 0; i < frames; i += CHUNK) {
      const end = Math.min(i + CHUNK, frames);
      for (let j = i; j < end; j++) {
        const l = L[j], r = R[j];
        pcm16[j * 2] = l < 0 ? Math.max(-1, l) * 0x8000 : Math.min(1, l) * 0x7fff;
        pcm16[j * 2 + 1] = r < 0 ? Math.max(-1, r) * 0x8000 : Math.min(1, r) * 0x7fff;
      }
      await new Promise(r => setTimeout(r, 0));
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
  }
}
