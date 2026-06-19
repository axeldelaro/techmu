/* =====================================================================
   main.js — Bootstrap de l'application UptempoWebDAW.
   Respecte la politique "User Gesture" : l'AudioContext et tout le graphe
   ne sont créés qu'après le clic sur le bouton d'initialisation.
   Assemble les modules (MVC) : State / Engine / Scheduler / UI / Viz / MIDI / Recorder.
   ===================================================================== */

import { StateManager } from './StateManager.js';
import { AudioEngine } from './AudioEngine.js';
import { Scheduler } from './Scheduler.js';
import { Visualizer } from './Visualizer.js';
import { MidiController } from './MidiController.js';
import { Recorder } from './Recorder.js';
import { OfflineRenderer } from './OfflineRenderer.js';
import { SmartAnalyzer } from './SmartAnalyzer.js';
import { SectionEditor } from './SectionEditor.js';
import { BatchProcessor } from './BatchProcessor.js';
import { UIController } from './UIController.js';
import { $ } from './utils.js';

// Numéro de build : permet de vérifier qu'on charge bien la dernière version
// (si tu ne vois pas ce numéro dans la console, ton navigateur sert un CACHE).
const BUILD = 'v15-2025-fixboot-export';
console.log('%cUptempoWebDAW build ' + BUILD, 'color:#7CFC00;font-weight:bold');

const bootOverlay = $('#boot-overlay');
const bootBtn = $('#boot-btn');
const bootHint = document.querySelector('.boot-hint');
if (bootHint) bootHint.textContent = 'Build ' + BUILD + ' — si erreur, vide le cache (Ctrl+Shift+R).';

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  try {
    await _boot();
  } catch (err) {
    booted = false;
    console.error('Boot error:', err);
    // Affiche l'erreur à l'écran au lieu d'un bouton mort.
    const card = document.querySelector('.boot-card');
    if (card) {
      const msg = document.createElement('p');
      msg.style.cssText = 'color:#ff3b1f;font-size:.8rem;margin-top:14px;max-width:420px';
      msg.textContent = 'Erreur de démarrage : ' + (err && err.message || err) +
        ' — fais Ctrl+Shift+R (vider le cache).';
      card.appendChild(msg);
    }
  }
}

async function _boot() {
  // 1) État partagé (source de vérité).
  const state = new StateManager();

  // 2) Moteur audio — création de l'AudioContext DANS le geste utilisateur.
  const engine = new AudioEngine(state);
  await engine.init();

  // 3) Séquenceur sample-accurate (worker lookahead).
  const scheduler = new Scheduler(engine, state);

  // 4) Visualiseur (oscilloscope / spectre / VU).
  const visualizer = new Visualizer(engine, {
    scope: $('#scope'),
    spectrum: $('#spectrum'),
    vuL: $('#vu-l'),
    vuR: $('#vu-r'),
    peakLed: $('#peak-led')
  });

  // 5) MIDI (mapping CC -> knobs).
  const midi = new MidiController((status) => { $('#midi-status').textContent = status; });
  midi.init();

  // 6) Enregistreur / export.
  const recorder = new Recorder(engine);

  // 6b) Cerveau Auto-Remix (v11) — analyse DSP locale via Web Worker.
  const smartAnalyzer = new SmartAnalyzer(engine, state, scheduler);

  // 6c) Export rapide (bounce hors-ligne via OfflineAudioContext).
  const offlineRenderer = new OfflineRenderer(engine, state, scheduler);

  // 6d) Éditeur d'arrangement par section.
  const sectionEditor = new SectionEditor({ state, scheduler });

  // 6e) Traitement en lot.
  const batchProcessor = new BatchProcessor({
    engine, state, smartAnalyzer, offlineRenderer,
    listEl: document.getElementById('batch-list'),
    onStatus: (t) => { document.getElementById('status-text').textContent = t; }
  });

  // 7) Contrôleur d'interface : câble tout au DOM.
  const ui = new UIController({ state, engine, scheduler, visualizer, midi, recorder, smartAnalyzer, offlineRenderer, sectionEditor, batchProcessor });
  ui.build();

  // Démarre les visualisations.
  visualizer.start();

  // Masque l'overlay de démarrage.
  bootOverlay.classList.add('hidden');
  $('#status-text').textContent = 'Moteur audio initialisé. Importez un sample ou lancez le séquenceur.';

  // Expose pour le debug en console.
  window.UPTEMPO = { state, engine, scheduler, ui, visualizer, midi, recorder, smartAnalyzer, offlineRenderer, sectionEditor, batchProcessor };
}

bootBtn.addEventListener('click', boot);
// Sécurité : tout clic/touch initial peut aussi démarrer le contexte.
window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && !booted) boot(); });
