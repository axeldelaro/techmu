# UptempoWebDAW

Station de travail audio numérique (MAO) **100 % navigateur**, dédiée au Live
Remix et à la production de **HardTechno / Industrial / Uptempo Hardcore**.
Aucune dépendance externe — **Vanilla JS (ES6+)**, Web Audio API, Web Workers,
Web MIDI API, MediaRecorder.

## Lancer

Les modules ES6 et les workers nécessitent un serveur HTTP (pas d'`file://`).

```bash
# au choix
python3 -m http.server 8000
# ou
npx serve .
```

Puis ouvrez <http://localhost:8000>, cliquez **« Initialiser le moteur audio »**
(obligatoire — politique *User Gesture* des navigateurs).

## Architecture (MVC / modulaire)

| Module | Rôle |
|---|---|
| `StateManager` | Source de vérité unique, observateurs, save/load JSON (localStorage) |
| `AudioEngine` | Graphe master, limiter de mastering, sample player, sidechain, DJ filter, stutter, décodage worker |
| `Scheduler` | Séquenceur **sample-accurate** (lookahead + Web Worker horloge), swing, mode arrangement |
| `HardcoreKick` | Synthèse de kick multi-layer + distorsion WaveShaper multi-courbes + EQ (overrides par hit) |
| `SmartAnalyzer` | Analyse DSP (Web Worker) : BPM, downbeat, fondamentale **+ structure couplet/refrain + tonalité par section** |
| `Arrangement` | Moteur d'arrangement temps réel **style Unicorn On K** : couplets posés / refrains qui explosent, original au premier plan |
| `FX` (dans Engine) | DJ filter morphable LP/HP, sidechain ducking, beatmasher |
| `Visualizer` | Oscilloscope + spectrogramme + VU-mètres RMS/Peak (`AnalyserNode`) |
| `MidiController` | Web MIDI — mapping CC → knobs (MIDI Learn par clic droit) |
| `Recorder` | Export audio temps réel — WebM (MediaRecorder) ou WAV 16-bit |
| `OfflineRenderer` | **Export rapide** : bounce hors-ligne (`OfflineAudioContext`) plus rapide que le temps réel, honore tous les réglages |
| `UIController` | Vue/Contrôleur — knobs, séquenceur, transport, câblage DOM |

## Prise en main rapide

- **Transport** : `Espace` = Play/Stop. Réglez le BPM et le Swing.
- **1-Click Auto-Remix** : importez un morceau puis cliquez — l'IA détecte
  BPM / downbeat / tonalité et pose un kick HardTechno/Uptempo calé et pompé
  par-dessus. Sans sample, le bouton lance quand même un pattern 4/4.
- **Séquenceur** : clic sur les pas (pistes **KICK** et **GATER**).
- **Knobs** : glisser verticalement (souris/tactile), `Shift` = réglage fin,
  molette pour ajuster. **Clic droit** sur un knob = *MIDI Learn*.
- **Build-up** : maintenir le bouton pour le stutter/beatmasher.
- **EXPORT RAPIDE** : bounce hors-ligne en `.wav` (rendu plus rapide que le
  temps réel, sans rejouer le morceau) — applique tous tes réglages courants.
- **REC** : enregistrement temps réel — clic = WebM ; `Shift+clic` = WAV.
- **SAVE/LOAD** : persistance de l'état complet dans le navigateur.
