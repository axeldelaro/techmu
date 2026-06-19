/* =====================================================================
   UIController.js — Couche Vue/Contrôleur.
   Construit les knobs, la grille du séquenceur, câble les boutons du
   transport et les contrôles, synchronise l'UI <-> StateManager, et
   relaie le playhead du Scheduler.
   ===================================================================== */

import { $, $$, el, NOTE_NAMES } from './utils.js';
import { Knob } from './Knob.js';

export class UIController {
  /**
   * @param {object} deps - { state, engine, scheduler, visualizer, midi, recorder }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.knobs = [];      // pour la synchro globale (load/MIDI)
    this.seqCells = {};   // track -> [cellEls]
  }

  /** Point d'entrée : construit toute l'UI une fois l'audio prêt. */
  build() {
    this._buildMasterKnobs();
    this._buildKickKnobs();
    this._buildAcidKnobs();
    this._buildFxKnobs();
    this._buildSequencer();
    this._buildAcidRootSelect();
    this._bindTransport();
    this._bindImport();
    this._bindSelectsAndChecks();
    this._bindSaveLoad();
    this._bindRecord();
    this._bindBuildup();
    this._bindAutoRemix();
    this._bindKeyboard();

    // Playhead du séquenceur (mise à jour depuis l'horloge audio).
    this.scheduler.onStep = (step) => this._highlightStep(step);

    // Re-synchro complète de l'UI après un load d'état.
    this.state.on('*', () => this.syncAll());
  }

  /* ---------------- Knobs ---------------- */

  _addKnob(container, cfg) {
    const knob = new Knob({
      ...cfg,
      onChange: (v) => this.state.set(cfg.path, v),
      onLearn: (setter) => this.midi.learn(setter)
    });
    knob.path = cfg.path;
    this.knobs.push(knob);
    container.appendChild(knob.root);
    return knob;
  }

  _buildMasterKnobs() {
    const c = $('#knobs-master');
    this._addKnob(c, { label: 'Pitch/Rate', path: 'sample.playbackRate', min: 0.25, max: 2.5, value: 1, exp: true });
    this._addKnob(c, { label: 'Detune', path: 'sample.detune', min: -1200, max: 1200, value: 0, unit: 'c' });
    this._addKnob(c, { label: 'Sample Vol', path: 'sample.level', min: 0, max: 1, value: 0.8 });
  }

  _buildKickKnobs() {
    const c = $('#knobs-kick');
    this._addKnob(c, { label: 'Tune', path: 'kick.tune', min: 30, max: 120, value: 50, exp: true, unit: 'Hz' });
    this._addKnob(c, { label: 'Click', path: 'kick.clickAmount', min: 0, max: 1, value: 0.6 });
    this._addKnob(c, { label: 'Click Pch', path: 'kick.clickPitch', min: 500, max: 6000, value: 2200, exp: true, unit: 'Hz' });
    this._addKnob(c, { label: 'Decay', path: 'kick.decay', min: 0.05, max: 1.2, value: 0.45, unit: 's' });
    this._addKnob(c, { label: 'Noise', path: 'kick.noise', min: 0, max: 1, value: 0.25 });
    this._addKnob(c, { label: 'Drive', path: 'kick.drive', min: 0, max: 1, value: 0.55 });
    this._addKnob(c, { label: 'EQ Freq', path: 'kick.eqFreq', min: 200, max: 6000, value: 1200, exp: true, unit: 'Hz' });
    this._addKnob(c, { label: 'EQ Gain', path: 'kick.eqGain', min: -12, max: 18, value: 6, unit: 'dB' });
    this._addKnob(c, { label: 'Level', path: 'kick.level', min: 0, max: 1, value: 0.9 });
  }

  _buildAcidKnobs() {
    const c = $('#knobs-acid');
    const v = 'acid';
    this._addKnob(c, { variant: v, label: 'Cutoff', path: 'acid.cutoff', min: 80, max: 6000, value: 600, exp: true, unit: 'Hz' });
    this._addKnob(c, { variant: v, label: 'Reso', path: 'acid.resonance', min: 1, max: 30, value: 18 });
    this._addKnob(c, { variant: v, label: 'Env Mod', path: 'acid.envMod', min: 0, max: 6000, value: 2500, exp: true, unit: 'Hz' });
    this._addKnob(c, { variant: v, label: 'Env Dec', path: 'acid.envDecay', min: 0.03, max: 0.8, value: 0.25, unit: 's' });
    this._addKnob(c, { variant: v, label: 'Accent', path: 'acid.accentAmt', min: 0, max: 1, value: 0.6 });
    this._addKnob(c, { variant: v, label: 'Glide', path: 'acid.glide', min: 0, max: 0.3, value: 0.06, unit: 's' });
    this._addKnob(c, { variant: v, label: 'Level', path: 'acid.level', min: 0, max: 1, value: 0.7 });
  }

  _buildFxKnobs() {
    const c = $('#knobs-fx');
    const v = 'fx';
    this._addKnob(c, { variant: v, label: 'DJ Filter', path: 'fx.djFilter', min: 0, max: 1, value: 0.5 });
    this._addKnob(c, { variant: v, label: 'SC Amount', path: 'fx.sidechainAmount', min: 0, max: 1, value: 0.8 });
    this._addKnob(c, { variant: v, label: 'SC Release', path: 'fx.sidechainRelease', min: 0.03, max: 0.5, value: 0.18, unit: 's' });
    this._addKnob(c, { variant: v, label: 'Stutter', path: 'fx.stutterRate', min: 20, max: 200, value: 60, unit: 'ms' });
    this._addKnob(c, { variant: v, label: 'Master', path: 'fx.masterLevel', min: 0, max: 1, value: 0.85 });
  }

  /* ---------------- Sequencer ---------------- */

  _buildSequencer() {
    const host = $('#sequencer');
    host.innerHTML = '';
    const tracks = [
      { id: 'kick', name: 'KICK', cls: '' },
      { id: 'acid', name: 'ACID', cls: 'acid' },
      { id: 'gater', name: 'GATER', cls: 'gater' }
    ];
    for (const tr of tracks) {
      const row = el('div', 'seq-track');
      row.appendChild(el('div', 'seq-name', tr.name));
      const cells = [];
      for (let i = 0; i < 16; i++) {
        const cell = el('div', `seq-cell ${tr.cls}`);
        cell.dataset.track = tr.id;
        cell.dataset.index = i;
        this._bindCell(cell, tr.id, i);
        row.appendChild(cell);
        cells.push(cell);
      }
      this.seqCells[tr.id] = cells;
      host.appendChild(row);
    }
    this._syncSequencer();
  }

  /**
   * Interactions cellule :
   *  - clic gauche : active/désactive le pas.
   *  - shift+clic (acid) : bascule l'accent.
   *  - molette (acid) : transpose la note du pas (±12 demi-tons).
   */
  _bindCell(cell, track, index) {
    cell.addEventListener('click', (e) => {
      if (track === 'acid' && e.shiftKey) {
        const seq = this.state.get('sequencer');
        seq.acidAccents[index] = !seq.acidAccents[index];
        this.state.set('sequencer.acidAccents', seq.acidAccents);
      } else {
        this.state.toggleStep(track, index);
      }
      this._syncSequencer();
    });

    if (track === 'acid') {
      cell.addEventListener('wheel', (e) => {
        e.preventDefault();
        const seq = this.state.get('sequencer');
        const cur = seq.acidNotes[index] || 0;
        seq.acidNotes[index] = Math.max(-12, Math.min(24, cur + (e.deltaY < 0 ? 1 : -1)));
        this.state.set('sequencer.acidNotes', seq.acidNotes);
        this._syncSequencer();
      }, { passive: false });
    }
  }

  /** Reflète l'état du séquenceur dans le DOM. */
  _syncSequencer() {
    const seq = this.state.get('sequencer');
    for (const track of ['kick', 'acid', 'gater']) {
      this.seqCells[track].forEach((cell, i) => {
        cell.classList.toggle('on', !!seq[track][i]);
        if (track === 'acid') {
          cell.classList.toggle('accent', !!seq.acidAccents[i]);
          const n = seq.acidNotes[i] || 0;
          cell.title = `${NOTE_NAMES[((n % 12) + 12) % 12]} (${n >= 0 ? '+' : ''}${n})`;
        }
      });
    }
  }

  _highlightStep(step) {
    for (const track of ['kick', 'acid', 'gater']) {
      this.seqCells[track].forEach((cell, i) => cell.classList.toggle('playhead', i === step));
    }
    const led = $('#beat-led');
    led.classList.toggle('on', step % 4 === 0);
  }

  /* ---------------- Selects / Checks ---------------- */

  _buildAcidRootSelect() {
    const sel = $('#acid-root');
    // Notes de C1 (MIDI 24) à C3 (MIDI 48), registre basse.
    for (let m = 24; m <= 48; m++) {
      const name = NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
      const opt = el('option', null, name);
      opt.value = String(m);
      sel.appendChild(opt);
    }
    sel.value = String(this.state.get('acid.rootMidi'));
    sel.addEventListener('change', () => this.state.set('acid.rootMidi', parseInt(sel.value, 10)));
  }

  _bindSelectsAndChecks() {
    $('#kick-curve').addEventListener('change', (e) => this.state.set('kick.curve', e.target.value));
    $('#acid-wave').addEventListener('change', (e) => this.state.set('acid.wave', e.target.value));
    $('#sidechain-on').addEventListener('change', (e) => this.state.set('fx.sidechainOn', e.target.checked));
    $('#djfilter-on').addEventListener('change', (e) => this.state.set('fx.djFilterOn', e.target.checked));
    $('#track-loop').addEventListener('change', (e) => this.state.set('sample.loop', e.target.checked));
    $('#kick-audition').addEventListener('click', () => this.engine.kick.trigger(this.engine.ctx.currentTime + 0.02));
  }

  /* ---------------- Transport ---------------- */

  _bindTransport() {
    const playBtn = $('#btn-play');
    playBtn.addEventListener('click', () => this.togglePlay());
    $('#btn-stop').addEventListener('click', () => this.stop());

    const bpm = $('#bpm-input');
    bpm.value = this.state.get('transport.bpm');
    bpm.addEventListener('input', () => {
      const v = Math.max(60, Math.min(320, parseInt(bpm.value, 10) || 180));
      this.state.set('transport.bpm', v);
    });

    const swing = $('#swing-input');
    swing.addEventListener('input', () => {
      const v = parseFloat(swing.value);
      this.state.set('transport.swing', v);
      $('#swing-val').textContent = Math.round(v * 200) + '%';
    });
  }

  togglePlay() {
    if (this.scheduler.isRunning) this.stop();
    else this.play();
  }

  play() {
    this.scheduler.start();
    $('#btn-play').classList.add('active');
    $('#btn-play').textContent = '❚❚';
    $('#status-text').textContent = 'Lecture…';
  }

  stop() {
    this.scheduler.stop();
    $('#btn-play').classList.remove('active');
    $('#btn-play').textContent = '▶';
    $$('.seq-cell').forEach((c) => c.classList.remove('playhead'));
    $('#status-text').textContent = 'Stop.';
  }

  /* ---------------- Import ---------------- */

  _bindImport() {
    const dz = $('#dropzone');
    const input = $('#file-input');
    $('#file-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => input.files[0] && this._handleFile(input.files[0]));

    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) this._handleFile(f);
    });

    $('#track-play').addEventListener('click', () => this.engine.playSample());
    $('#track-stop').addEventListener('click', () => this.engine.stopSample());
  }

  async _handleFile(file) {
    const prog = $('#decode-progress');
    prog.hidden = false; prog.value = 0;
    $('#file-name').textContent = 'Décodage : ' + file.name;
    $('#status-text').textContent = 'Décodage du sample (Web Worker)…';
    try {
      const buf = await this.engine.loadFile(file, (p) => { prog.value = p; });
      $('#file-name').textContent = `${file.name} · ${buf.duration.toFixed(1)}s`;
      $('#status-text').textContent = 'Sample prêt.';
    } catch (e) {
      $('#file-name').textContent = 'Échec du décodage';
      $('#status-text').textContent = 'Erreur : ' + e.message;
    } finally {
      setTimeout(() => { prog.hidden = true; }, 600);
    }
  }

  /* ---------------- Save / Load ---------------- */

  _bindSaveLoad() {
    $('#btn-save').addEventListener('click', () => {
      this.state.save();
      $('#status-text').textContent = 'État sauvegardé (localStorage).';
    });
    $('#btn-load').addEventListener('click', () => {
      if (this.state.load()) {
        this.syncAll();
        $('#status-text').textContent = 'État rechargé.';
      } else {
        $('#status-text').textContent = 'Aucune sauvegarde trouvée.';
      }
    });
  }

  /* ---------------- Record / Export ---------------- */

  _bindRecord() {
    const btn = $('#btn-rec');
    btn.addEventListener('click', async (e) => {
      if (!this.recorder.recording) {
        // WAV si l'utilisateur maintient Shift, sinon WebM.
        const fmt = e.shiftKey ? 'wav' : 'webm';
        this.recorder.start(fmt);
        btn.classList.add('active');
        btn.textContent = '● STOP';
        $('#status-text').textContent = `Enregistrement (${fmt})… (Shift+clic = WAV)`;
      } else {
        btn.textContent = '… export';
        await this.recorder.stop();
        btn.classList.remove('active');
        btn.textContent = '● REC';
        $('#status-text').textContent = 'Export terminé (téléchargement).';
      }
    });
  }

  /* ---------------- Build-up (Stutter) ---------------- */

  _bindBuildup() {
    const btn = $('#btn-buildup');
    const start = () => { this.engine.startStutter(); btn.classList.add('active'); };
    const end = () => { this.engine.stopStutter(); btn.classList.remove('active'); };
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
    ['mouseup', 'mouseleave', 'touchend'].forEach((ev) => btn.addEventListener(ev, end));
  }

  /* ---------------- 1-Click Auto-Remix (v11) ---------------- */

  _bindAutoRemix() {
    const btn = $('#btn-autoremix');
    btn.addEventListener('click', async () => {
      if (!this.engine.sampleBuffer) {
        $('#status-text').textContent = 'Importez d\'abord un sample à remixer.';
        return;
      }
      btn.classList.add('busy');
      btn.textContent = '⏳ ANALYSE…';
      $('#analysis-readout').textContent = 'IA: analyse DSP en cours (Web Worker)…';
      $('#status-text').textContent = 'Auto-Remix : détection BPM / phase / harmonie…';
      try {
        const a = await this.smartAnalyzer.analyzeAndRemix({ autoplay: true });
        const noteName = this._hzToNote(a.fundamental);
        $('#analysis-readout').textContent =
          `IA ▸ BPM ${a.bpm} · downbeat ${Math.round(a.offsetMs)}ms · ` +
          `fond. ${a.fundamental.toFixed(1)}Hz (${noteName}) · ratio ×${this.state.get('sample.playbackRate')}`;
        $('#status-text').textContent = 'Auto-Remix appliqué et calé. ▶ Lecture synchronisée.';
        // L'analyseur a déjà démarré la lecture synchronisée : reflète le transport.
        $('#btn-play').classList.add('active');
        $('#btn-play').textContent = '❚❚';
      } catch (e) {
        $('#analysis-readout').textContent = 'IA: échec — ' + e.message;
        $('#status-text').textContent = 'Auto-Remix : erreur d\'analyse.';
      } finally {
        btn.classList.remove('busy');
        btn.textContent = '⚡ 1-CLICK AUTO-REMIX';
      }
    });
  }

  /** Convertit une fréquence (Hz) en nom de note pour l'affichage. */
  _hzToNote(hz) {
    if (!hz || hz <= 0) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /* ---------------- Clavier ---------------- */

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
    });
  }

  /* ---------------- Synchro globale ---------------- */

  /** Recale toute l'UI sur l'état courant (après load / MIDI). */
  syncAll() {
    for (const k of this.knobs) k.setValue(this.state.get(k.path), true);
    $('#bpm-input').value = this.state.get('transport.bpm');
    $('#swing-input').value = this.state.get('transport.swing');
    $('#swing-val').textContent = Math.round(this.state.get('transport.swing') * 200) + '%';
    $('#kick-curve').value = this.state.get('kick.curve');
    $('#acid-wave').value = this.state.get('acid.wave');
    $('#acid-root').value = String(this.state.get('acid.rootMidi'));
    $('#sidechain-on').checked = this.state.get('fx.sidechainOn');
    $('#djfilter-on').checked = this.state.get('fx.djFilterOn');
    $('#track-loop').checked = this.state.get('sample.loop');
    this._syncSequencer();
  }
}
