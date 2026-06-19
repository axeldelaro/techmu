/* =====================================================================
   SectionEditor.js — Éditeur d'arrangement PAR SECTION (timeline + panneau).

   Affiche les segments détectés (couplets/refrains/…) sur une timeline
   proportionnelle au temps. Sélectionner un segment ouvre un panneau pour
   régler : type, basse (Hz), intensité, drive, ducking, fondus (in/out),
   et étendre/réduire/scinder/fusionner. Chaque édition recompile le modèle
   et met à jour le moteur d'Arrangement -> répercussion live ET à l'export.
   ===================================================================== */

import { $, el } from './utils.js';
import { compile, resizeSegment, defaultsFor, typeLabel, hzToNote } from './SectionModel.js';

export class SectionEditor {
  /**
   * @param {object} deps - { state, scheduler }
   */
  constructor(deps) {
    this.scheduler = deps.scheduler;
    this.timeline = $('#arrange-timeline');
    this.panel = $('#arrange-editor');
    this.st = null;
    this.selected = -1;
  }

  /** Charge une structure analysée (avec segments) et dessine la timeline. */
  load(structure) {
    this.st = structure;
    this.selected = -1;
    this.panel.hidden = true;
    this.renderTimeline();
  }

  /** Arrangement courant (pour rebuild après édition). */
  _arr() { return this.scheduler.arrangement; }

  /** Applique les changements : recompile + rebuild du moteur + redraw. */
  _apply() {
    compile(this.st);
    const arr = this._arr();
    if (arr) arr.rebuild();
    this.renderTimeline();
    this.renderPanel();
  }

  /** Dessine la bande de segments (largeur ∝ nombre de mesures). */
  renderTimeline() {
    if (!this.st) return;
    const tl = this.timeline;
    tl.innerHTML = '';
    const total = this.st.totalBars || 1;
    this.st.segments.forEach((seg, i) => {
      const bars = seg.end - seg.start;
      const block = el('div', `seg t-${seg.type}${i === this.selected ? ' sel' : ''}`);
      block.style.flex = `${bars} 0 0`;
      block.dataset.i = i;
      block.title = `${typeLabel(seg.type)} · mes. ${seg.start}-${seg.end} · ${hzToNote(seg.sub)}`;
      block.textContent = bars >= 3 ? typeLabel(seg.type) : '';
      if (seg.fadeIn > 0) block.appendChild(el('div', 'seg-fade'));
      if (seg.fadeOut > 0) block.appendChild(el('div', 'seg-fade out'));
      block.addEventListener('click', () => { this.selected = i; this.renderTimeline(); this.renderPanel(); });
      tl.appendChild(block);
    });
  }

  /** Surbrillance de la section en cours de lecture (appelé par l'UI). */
  highlightBar(bar) {
    if (!this.st) return;
    const segs = this.st.segments;
    let active = -1;
    for (let i = 0; i < segs.length; i++) if (bar >= segs[i].start && bar < segs[i].end) { active = i; break; }
    Array.from(this.timeline.children).forEach((c, i) => c.classList?.toggle('playing', i === active));
  }

  /** Panneau d'édition du segment sélectionné. */
  renderPanel() {
    const seg = this.st && this.st.segments[this.selected];
    if (!seg) { this.panel.hidden = true; return; }
    this.panel.hidden = false;

    const slider = (label, min, max, step, val, unit, onInput) => {
      const c = el('label', 'ae-ctrl');
      const valSpan = el('span', 'ae-val', (typeof val === 'number' ? val : 0) + (unit || ''));
      const head = el('span', null, label + ' : ');
      head.appendChild(valSpan);
      const inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      inp.addEventListener('input', () => { valSpan.textContent = inp.value + (unit || ''); onInput(parseFloat(inp.value)); });
      c.append(head, inp);
      return c;
    };

    this.panel.innerHTML = '';
    const dur = ((seg.end - seg.start) * this.st.barLen).toFixed(1);
    this.panel.appendChild(el('h3', null,
      `${typeLabel(seg.type)} #${this.selected + 1} — mesures ${seg.start}–${seg.end} (${dur}s)`));

    const grid = el('div', 'ae-grid');

    // Type / rôle de la section.
    const typeCtrl = el('label', 'ae-ctrl'); typeCtrl.appendChild(el('span', null, 'Rôle'));
    const sel = el('select');
    [['chorus', 'Refrain (drop)'], ['verse', 'Couplet (posé)'], ['build', 'Build-up'], ['trans', 'Transition'], ['intro', 'Calme (intro/outro)']]
      .forEach(([v, t]) => { const o = el('option', null, t); o.value = v; if (seg.type === v) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', () => {
      seg.type = sel.value;
      const d = defaultsFor(seg.type);                 // réinitialise les défauts du nouveau type
      seg.intensity = d.intensity; seg.drive = d.drive; seg.duck = d.duck;
      this.selected = this.selected; this._apply();
    });
    typeCtrl.appendChild(sel); grid.appendChild(typeCtrl);

    // Basse (Hz) + Auto.
    const bassCtrl = slider(`Basse (${hzToNote(seg.sub)})`, 35, 120, 1, Math.round(seg.sub), ' Hz', (v) => {
      seg.sub = v; seg.subAuto = false; compile(this.st); const a = this._arr(); if (a) a.rebuild();
      // maj du libellé note en live
      const head = bassCtrl.querySelector('span:first-child');
      if (head) head.firstChild.textContent = `Basse (${hzToNote(v)}) : `;
    });
    grid.appendChild(bassCtrl);
    const autoWrap = el('label', 'ae-chk');
    const autoChk = el('input'); autoChk.type = 'checkbox'; autoChk.checked = seg.subAuto;
    autoChk.addEventListener('change', () => { seg.subAuto = autoChk.checked; this._apply(); });
    autoWrap.append(autoChk, document.createTextNode('Basse auto (détectée)'));

    grid.appendChild(slider('Intensité', 0, 1, 0.05, +seg.intensity.toFixed(2), '', (v) => { seg.intensity = v; this._applyLight(); }));
    grid.appendChild(slider('Drive (disto)', 1, 24, 0.5, +seg.drive.toFixed(1), '', (v) => { seg.drive = v; this._applyLight(); }));
    grid.appendChild(slider('Ducking', 0, 0.9, 0.02, +seg.duck.toFixed(2), '', (v) => { seg.duck = v; this._applyLight(); }));
    grid.appendChild(slider('Fondu entrée', 0, 6, 1, seg.fadeIn, ' mes', (v) => { seg.fadeIn = v; this._apply(); }));
    grid.appendChild(slider('Fondu sortie', 0, 6, 1, seg.fadeOut, ' mes', (v) => { seg.fadeOut = v; this._apply(); }));

    this.panel.appendChild(grid);
    this.panel.appendChild(autoWrap);

    // Étendre / réduire / scinder / régénérer.
    const row = el('div', 'ae-row');
    const btn = (txt, fn) => { const b = el('button', 'mini-btn', txt); b.addEventListener('click', fn); return b; };
    row.append(
      btn('◀ étendre début', () => { resizeSegment(this.st, this.selected, 'start', -1); this._postResize(); }),
      btn('réduire début ▶', () => { resizeSegment(this.st, this.selected, 'start', +1); this._postResize(); }),
      btn('◀ réduire fin', () => { resizeSegment(this.st, this.selected, 'end', -1); this._postResize(); }),
      btn('étendre fin ▶', () => { resizeSegment(this.st, this.selected, 'end', +1); this._postResize(); }),
      btn('✂ scinder', () => this._split()),
      btn('⟳ régénérer', () => { seg.seed = (Math.random() * 1e9) | 0; this._apply(); })
    );
    this.panel.appendChild(row);
  }

  /** Recompile sans tout redessiner (réglages continus = fluide). */
  _applyLight() {
    compile(this.st);
    const a = this._arr(); if (a) a.rebuild();
    this.renderTimeline();
  }

  _postResize() {
    // L'index peut avoir changé si un segment a disparu : on resélectionne par bornes.
    this.selected = Math.min(this.selected, this.st.segments.length - 1);
    const a = this._arr(); if (a) a.rebuild();
    this.renderTimeline(); this.renderPanel();
  }

  /** Scinde le segment sélectionné en deux moitiés. */
  _split() {
    const seg = this.st.segments[this.selected];
    if (!seg || (seg.end - seg.start) < 2) return;
    const mid = Math.floor((seg.start + seg.end) / 2);
    const copy = Object.assign({}, seg, { start: mid, seed: (Math.random() * 1e9) | 0 });
    seg.end = mid;
    this.st.segments.splice(this.selected + 1, 0, copy);
    this._apply();
  }
}
