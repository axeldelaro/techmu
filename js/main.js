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
import { UIController } from './UIController.js';
import { $ } from './utils.js';

const bootOverlay = $('#boot-overlay');
const bootBtn = $('#boot-btn');

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;

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

  // 7) Contrôleur d'interface : câble tout au DOM.
  const ui = new UIController({ state, engine, scheduler, visualizer, midi, recorder });
  ui.build();

  // Démarre les visualisations.
  visualizer.start();

  // Masque l'overlay de démarrage.
  bootOverlay.classList.add('hidden');
  $('#status-text').textContent = 'Moteur audio initialisé. Importez un sample ou lancez le séquenceur.';

  // Expose pour le debug en console.
  window.UPTEMPO = { state, engine, scheduler, ui, visualizer, midi, recorder };
}

bootBtn.addEventListener('click', boot);
// Sécurité : tout clic/touch initial peut aussi démarrer le contexte.
window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && !booted) boot(); });
