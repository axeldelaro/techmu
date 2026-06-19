/* =====================================================================
   BatchProcessor.js — Traitement EN LOT de plusieurs morceaux.
   (Version modifiée : Export WAV exclusif)
   ===================================================================== */

import { el } from './utils.js';
import { buildSegments } from './SectionModel.js';

export class BatchProcessor {
  /**
   * @param {object} deps - { engine, state, smartAnalyzer, offlineRenderer, listEl, onStatus }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.running = false;
  }

  _row(name) {
    const row = el('div', 'batch-row');
    const n = el('span', 'batch-name', name);
    const s = el('span', 'batch-stat', 'en attente…');
    row.append(n, s);
    this.listEl.appendChild(row);
    return {
      status: (t) => { s.textContent = t; },
      progress: (p) => { s.textContent = `rendu ${p}%`; }
    };
  }

  /**
   * Traite une liste de fichiers séquentiellement.
   * @param {FileList|File[]} files
   */
  async run(files) {
    if (this.running) return;
    this.running = true;
    this.listEl.innerHTML = '';
    const arr = Array.from(files);
    let done = 0;

    for (const file of arr) {
      const row = this._row(file.name);
      try {
        row.status('décodage…');
        const buf = await this.engine.decodeFile(file);

        row.status('analyse (BPM / structure)…');
        const a = await this.smartAnalyzer.analyzeBuffer(buf);
        let structure = a.structure;
        if (structure && structure.sections && structure.sections.length) buildSegments(structure);
        else structure = null;

        row.status('rendu…');
        const blob = await this.offlineRenderer.renderToBlob(buf, structure, (p) => row.progress(p));

        const base = file.name.replace(/\.[^.]+$/, '');
        this.offlineRenderer._download(blob, `${base}-uptempo.wav`);
        row.status(`✅ terminé (.wav)`);
        done++;
      } catch (e) {
        row.status('❌ ' + (e.message || e));
      }
      this.onStatus?.(`Lot : ${done}/${arr.length} traité(s)…`);
      // Laisse le navigateur déclencher le téléchargement avant le suivant.
      await new Promise((r) => setTimeout(r, 500));
    }

    this.running = false;
    this.onStatus?.(`Lot terminé : ${done}/${arr.length} morceau(x) exporté(s).`);
  }
}
