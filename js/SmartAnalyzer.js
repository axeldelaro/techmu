/* =====================================================================
   SmartAnalyzer.js — v11 "Cerveau Auto-Remix & Analyse Intelligente".

   IA locale (zéro API) qui analyse le buffer audio brut pour automatiser
   la synchronisation rythmique et harmonique :
     - Détection BPM par autocorrélation sur l'enveloppe d'énergie filtrée.
     - Alignement de phase (downbeat / premier transitoire majeur).
     - Détection de la note fondamentale par FFT + Harmonic Product Spectrum.

   Tout le DSP lourd tourne dans un Web Worker (Blob inline) -> le thread
   principal n'est jamais bloqué. Le Worker renvoie un JSON :
     { bpm, offsetMs, fundamental, confidence }.

   INTÉGRATION :
     - Injectée dans main.js (voir bootstrap) et reliée à AudioEngine.
     - Le bouton "1-Click Auto-Remix" (index.html / UIController) appelle
       analyzeAndRemix().
   ===================================================================== */

import { midiToFreq } from './utils.js';
import { Arrangement } from './Arrangement.js';

/* ---------------------------------------------------------------------
   CODE DU WORKER DSP (chaîne de caractères -> Blob -> Worker).
   Tout est en JS pur, sans dépendance. Les seuils/sensibilités sont
   regroupés dans l'objet CFG en tête pour un réglage facile.
   --------------------------------------------------------------------- */
const WORKER_SRC = `
self.onmessage = (e) => {
  const { pcm, sampleRate } = e.data;
  try {
    const result = analyze(pcm, sampleRate);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};

/* ===== Paramètres réglables (sensibilités & seuils de détection) ===== */
const CFG = {
  lpCutoffHz: 150,      // coupure du passe-bas (isole kicks/basses)
  envRate: 800,         // Hz : résolution de l'enveloppe d'énergie (précision BPM)
  bpmMin: 80,           // borne basse de recherche
  bpmMax: 200,          // borne haute de recherche
  analyzeSeconds: 60,   // durée max analysée pour le BPM (perf)
  onsetThreshold: 0.30, // fraction du max pour le downbeat (0..1)
  fftSize: 32768,       // taille de la fenêtre FFT (puissance de 2)
  fundMinHz: 40,        // plage de recherche harmonique
  fundMaxHz: 400,
  hpsHarmonics: 4       // nombre d'harmoniques pour le Harmonic Product Spectrum
};

/* =====================================================================
   1) FILTRE PASSE-BAS — one-pole (RC) appliqué échantillon par échantillon.
   y[n] = y[n-1] + alpha * (x[n] - y[n-1])
   alpha dérive du cutoff : alpha = dt / (RC + dt), RC = 1/(2*pi*fc).
   But : ne garder que le bas du spectre (kicks/basses) où l'info
   rythmique fondamentale est la plus propre.
   ===================================================================== */
function lowpass(input, sampleRate, cutoff) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y = y + alpha * (input[i] - y);
    out[i] = y;
  }
  return out;
}

/* =====================================================================
   2) ENVELOPPE D'ÉNERGIE — on découpe le signal filtré en "hops" et on
   somme l'énergie (x^2) de chaque fenêtre. Cela transforme la forme
   d'onde en une courbe d'énergie basse résolution sur laquelle les
   battements ressortent comme des bosses régulières.
   ===================================================================== */
function energyEnvelope(filtered, sampleRate, envRate) {
  const hop = Math.max(1, Math.round(sampleRate / envRate));
  const len = Math.floor(filtered.length / hop);
  const env = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) {
      const v = filtered[base + j];
      sum += v * v;
    }
    env[i] = sum;
  }
  return { env, hop };
}

/* =====================================================================
   3) DÉTECTION BPM — AUTOCORRÉLATION de l'enveloppe d'énergie.

   On retire la composante continue (moyenne) pour ne corréler que les
   variations. Pour chaque BPM candidat on calcule le décalage (lag) en
   échantillons d'enveloppe puis la corrélation :
       R(lag) = somme( env[i] * env[i+lag] )
   Le BPM dont le lag maximise R est le tempo de la piste. On balaie en
   pas de 0.25 BPM (interpolation du lag) pour une précision +/-1 BPM,
   et on corrige les erreurs d'octave (ex: 90 détecté pour 180).
   ===================================================================== */
function detectBPM(env, envRate) {
  // Centrage : soustrait la moyenne (supprime le DC).
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= env.length;
  const x = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) x[i] = Math.max(0, env[i] - mean);

  let bestBpm = 0, bestScore = -Infinity;
  // Balayage fin des BPM candidats.
  for (let bpm = CFG.bpmMin; bpm <= CFG.bpmMax; bpm += 0.25) {
    const lagF = (60 / bpm) * envRate;       // lag en échantillons d'enveloppe (réel)
    const lag = Math.round(lagF);
    if (lag < 1 || lag >= x.length) continue;
    let sum = 0;
    const n = x.length - lag;
    // Corrélation à ce lag (énergie alignée sur une période de battement).
    for (let i = 0; i < n; i++) sum += x[i] * x[i + lag];
    // Normalisation douce par le nombre de termes.
    const score = sum / n;
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }

  // Correction d'octave : pour la musique électronique rapide, on préfère
  // ramener le tempo dans la fenêtre "dancefloor" 150-200 si un multiple existe.
  let bpm = bestBpm;
  while (bpm < 150 && bpm * 2 <= CFG.bpmMax) bpm *= 2;
  while (bpm > CFG.bpmMax) bpm /= 2;

  return { bpm: Math.round(bpm), raw: bestBpm, confidence: bestScore };
}

/* =====================================================================
   4) ALIGNEMENT DE PHASE — premier transitoire majeur (downbeat).

   Sur le signal filtré (basses), on cherche le premier échantillon dont
   l'amplitude dépasse un seuil dynamique = onsetThreshold * max global.
   On exige aussi une pente montante (énergie qui croît) pour éviter les
   faux positifs sur du bruit. L'index trouvé donne l'offset en ms qui
   servira à décaler le séquenceur -> phase parfaite, plus d'effet "galop".
   ===================================================================== */
function detectDownbeat(filtered, sampleRate) {
  // Max global de la première portion (pour le seuil dynamique).
  const scan = Math.min(filtered.length, sampleRate * 10);
  let max = 0;
  for (let i = 0; i < scan; i++) {
    const a = Math.abs(filtered[i]);
    if (a > max) max = a;
  }
  const threshold = max * CFG.onsetThreshold;

  // Fenêtre glissante courte pour mesurer la montée d'énergie.
  const win = Math.round(sampleRate * 0.005); // 5 ms
  let prevEnergy = 0;
  for (let i = 0; i < scan - win; i += win) {
    let e = 0;
    for (let j = 0; j < win; j++) e += Math.abs(filtered[i + j]);
    e /= win;
    if (e > threshold && e > prevEnergy * 1.2) {
      // Affine : recule jusqu'au vrai début de la montée.
      let start = i;
      while (start > 0 && Math.abs(filtered[start]) > threshold * 0.5) start--;
      return (start / sampleRate) * 1000; // ms
    }
    prevEnergy = e;
  }
  return 0;
}

/* =====================================================================
   5) FFT RADIX-2 (Cooley-Tukey itérative, in-place) — JS pur.
   Entrées : tableaux réels (re) et imaginaires (im) de taille 2^k.
   Étapes : (a) inversion de bits, (b) papillons sur log2(N) étages.
   ===================================================================== */
function fft(re, im) {
  const n = re.length;
  // (a) Permutation par inversion de bits.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // (b) Papillons : fusion de blocs de taille croissante.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;          // signe négatif = FFT directe
    const wpr = Math.cos(ang), wpi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const a = i + k, b = i + k + (len >> 1);
        const tr = wr * re[b] - wi * im[b];  // twiddle * échantillon impair
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
        const tmp = wr;                      // rotation du twiddle factor
        wr = wr * wpr - wi * wpi;
        wi = tmp * wpi + wi * wpr;
      }
    }
  }
}

/* =====================================================================
   6) DÉTECTION HARMONIQUE — fondamentale via FFT + Harmonic Product
   Spectrum (HPS). On fenêtre (Hann) une portion à forte énergie, on
   calcule le spectre de magnitude, puis on multiplie le spectre par ses
   versions décimées (h=2,3,4...). Les harmoniques d'une même note se
   superposent sur la fondamentale -> son pic ressort nettement, même si
   le fondamental réel est faible (basses, distorsion).
   ===================================================================== */
function detectFundamental(mono, sampleRate) {
  const N = CFG.fftSize;
  if (mono.length < N) return 0;

  // Choisit la fenêtre la plus énergique (évite l'intro/le silence).
  let bestStart = 0, bestE = -1;
  const stride = Math.floor(N / 2);
  for (let s = 0; s + N <= mono.length; s += stride) {
    let e = 0;
    for (let i = 0; i < N; i += 64) e += mono[s + i] * mono[s + i];
    if (e > bestE) { bestE = e; bestStart = s; }
  }

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Fenêtre de Hann : réduit les fuites spectrales.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re[i] = mono[bestStart + i] * w;
  }
  fft(re, im);

  // Spectre de magnitude (demi-spectre utile).
  const half = N >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);

  // Harmonic Product Spectrum.
  const hps = mag.slice(0, Math.floor(half / CFG.hpsHarmonics));
  for (let h = 2; h <= CFG.hpsHarmonics; h++) {
    for (let i = 0; i < hps.length; i++) hps[i] *= mag[i * h];
  }

  // Recherche du pic dans la plage [fundMinHz..fundMaxHz].
  const binHz = sampleRate / N;
  const minBin = Math.max(1, Math.floor(CFG.fundMinHz / binHz));
  const maxBin = Math.min(hps.length - 1, Math.ceil(CFG.fundMaxHz / binHz));
  let peakBin = minBin, peak = -1;
  for (let i = minBin; i <= maxBin; i++) {
    if (hps[i] > peak) { peak = hps[i]; peakBin = i; }
  }

  // Interpolation parabolique pour affiner la fréquence du pic.
  let bin = peakBin;
  if (peakBin > 0 && peakBin < hps.length - 1) {
    const a = hps[peakBin - 1], b = hps[peakBin], c = hps[peakBin + 1];
    const denom = (a - 2 * b + c);
    if (denom !== 0) bin = peakBin + 0.5 * (a - c) / denom;
  }
  return bin * binHz;
}

/* =====================================================================
   7) DÉTECTION DE STRUCTURE (couplet / refrain) — style "Unicorn On K".

   Le refrain d'un morceau a + d'énergie ET + de brillance (aigus :
   cymbales, guitares saturées) que le couplet. On extrait par fenêtres
   de 250 ms : RMS (énergie) et HF (énergie des hautes fréquences via la
   dérivée du signal). Un "score de refrain" = énergie × brillance permet
   de classer chaque mesure (seuils par percentiles), puis on lisse et on
   étiquette les sections : intro / couplet / build / refrain / outro.
   ===================================================================== */
function smoothArr(arr, w) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < arr.length) { s += arr[j]; c++; } }
    out[i] = s / c;
  }
  return out;
}

function detectStructure(pcm, sampleRate, bpm, offsetMs, fundamental) {
  // Tempo uptempo cible (multiple du BPM détecté) -> grille des mesures.
  let kbpm = bpm, mul = 1;
  while (kbpm < 170) { kbpm = bpm * (++mul); }
  if (kbpm > 215) kbpm = bpm * (mul - 1);
  if (kbpm < 150) kbpm = bpm * 2;
  const beat = 60 / kbpm, barLen = beat * 4;
  const downbeat = (offsetMs || 0) / 1000;
  const totalBars = Math.max(1, Math.floor((pcm.length / sampleRate - downbeat) / barLen));

  // Features par 250 ms.
  const HOP = Math.round(sampleRate * 0.25);
  const rms = [], hf = []; let prev = 0;
  for (let i = 0; i + HOP <= pcm.length; i += HOP) {
    let e = 0, h = 0;
    for (let j = 0; j < HOP; j++) { const m = pcm[i + j]; e += m * m; const d = m - prev; prev = m; h += d * d; }
    rms.push(Math.sqrt(e / HOP)); hf.push(Math.sqrt(h / HOP));
  }
  const R = smoothArr(rms, 4), H = smoothArr(hf, 4);
  let rmax = 1e-9, hmax = 1e-9;
  for (let i = 0; i < R.length; i++) { if (R[i] > rmax) rmax = R[i]; if (H[i] > hmax) hmax = H[i]; }
  const score = new Float32Array(R.length);
  for (let i = 0; i < R.length; i++) score[i] = (R[i] / rmax) * (0.4 + 0.6 * H[i] / hmax);

  // Seuils par percentiles.
  const sortedS = Array.from(score).sort((a, b) => a - b);
  const pct = (p) => sortedS[Math.min(sortedS.length - 1, Math.max(0, Math.floor(p * sortedS.length)))];
  const HI = pct(0.60), LO = pct(0.42);
  const frameClass = (t) => {
    const k = Math.min(score.length - 1, Math.max(0, Math.floor(t / 0.25)));
    return score[k] > HI ? 2 : score[k] < LO ? 0 : 1;
  };

  // Classe par mesure (majorité sur les 4 temps).
  const barClass = new Array(totalBars);
  for (let b = 0; b < totalBars; b++) {
    const t0 = downbeat + b * barLen; const cnt = [0, 0, 0];
    for (let f = 0; f < 4; f++) cnt[frameClass(t0 + f * beat)]++;
    barClass[b] = cnt[2] >= 2 ? 2 : cnt[0] >= 3 ? 0 : 1;
  }
  // Lissage : absorbe les mesures isolées.
  for (let pass = 0; pass < 3; pass++)
    for (let b = 1; b < totalBars - 1; b++)
      if (barClass[b] !== barClass[b - 1] && barClass[b] !== barClass[b + 1] && barClass[b - 1] === barClass[b + 1])
        barClass[b] = barClass[b - 1];

  // Étiquettes.
  const sections = barClass.map(c => c === 2 ? 'chorus' : c === 0 ? 'verse' : 'trans');
  let firstChorus = sections.indexOf('chorus'); if (firstChorus < 0) firstChorus = totalBars;
  for (let b = 0; b < firstChorus; b++) sections[b] = 'intro';
  for (let b = totalBars - 1; b >= 0 && sections[b] !== 'chorus'; b--) sections[b] = 'outro';
  // Build = jusqu'à 2 mesures avant un refrain.
  for (let b = 1; b < totalBars; b++)
    if (sections[b] === 'chorus' && sections[b - 1] !== 'chorus') {
      if (sections[b - 1] !== 'chorus') sections[b - 1] = 'build';
      if (b - 2 >= 0 && sections[b - 2] !== 'chorus') sections[b - 2] = 'build';
    }

  // Tonalité PAR SECTION : la basse suit le refrain (autocorrélation du
  // signal passe-bas de la section), repliée dans la plage sub 38..90 Hz.
  const barSub = new Float32Array(totalBars);
  let b = 0;
  while (b < totalBars) {
    let e = b; while (e < totalBars && sections[e] === sections[b]) e++;
    let f;
    if (sections[b] === 'chorus' || sections[b] === 'verse') {
      const s0 = Math.floor((downbeat + b * barLen) * sampleRate);
      const s1 = Math.min(pcm.length, s0 + sampleRate * 4);
      f = sectionPitch(pcm, sampleRate, s0, s1);
    } else f = fundamental;
    if (!f || !isFinite(f)) f = fundamental || 73;
    while (f > 90) f /= 2; while (f < 38) f *= 2;
    for (let k = b; k < e; k++) barSub[k] = f;
    b = e;
  }

  return { kbpm: Math.round(kbpm), beat, barLen, downbeat, totalBars, sections, barSub: Array.from(barSub) };
}

/** Pitch d'une plage par autocorrélation sur le signal passe-bas. */
function sectionPitch(pcm, sampleRate, s0, s1) {
  s0 = Math.max(0, s0); s1 = Math.min(pcm.length, s1);
  if (s1 - s0 < sampleRate * 0.5) return 0;
  // Passe-bas one-pole 160 Hz sur la tranche.
  const len = s1 - s0; const x = new Float32Array(len);
  const dt = 1 / sampleRate, rc = 1 / (2 * Math.PI * 160), al = dt / (rc + dt); let y = 0;
  for (let i = 0; i < len; i++) { y += al * (pcm[s0 + i] - y); x[i] = y; }
  let best = 0, bestc = -1;
  for (let hz = 40; hz <= 180; hz += 1) {
    const lag = Math.round(sampleRate / hz); let c = 0;
    for (let i = 0; i + lag < len; i += 8) c += x[i] * x[i + lag];
    if (c > bestc) { bestc = c; best = hz; }
  }
  return best;
}

/* ===== Orchestration de l'analyse ===== */
function analyze(pcm, sampleRate) {
  // Limite la durée analysée pour le rythme (perf), garde tout pour la FFT.
  const maxSamples = Math.min(pcm.length, sampleRate * CFG.analyzeSeconds);
  const rhythmSlice = pcm.subarray(0, maxSamples);

  const filtered = lowpass(rhythmSlice, sampleRate, CFG.lpCutoffHz);
  const { env } = energyEnvelope(filtered, sampleRate, CFG.envRate);

  const { bpm, confidence } = detectBPM(env, CFG.envRate);
  const offsetMs = detectDownbeat(filtered, sampleRate);
  const fundamental = detectFundamental(pcm, sampleRate);

  // v12 : structure complète (couplets / refrains) + tonalité par section.
  const structure = detectStructure(pcm, sampleRate, bpm, offsetMs, fundamental);

  return { bpm, offsetMs, fundamental, confidence, structure };
}
`;

export class SmartAnalyzer {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine
   * @param {import('./StateManager.js').StateManager} state
   * @param {import('./Scheduler.js').Scheduler} scheduler
   */
  constructor(engine, state, scheduler) {
    this.engine = engine;
    this.state = state;
    this.scheduler = scheduler;
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.lastAnalysis = null;
  }

  /**
   * Lance l'analyse DSP du buffer courant dans le Worker.
   * @returns {Promise<{bpm:number, offsetMs:number, fundamental:number, confidence:number}>}
   */
  analyze() {
    const buf = this.engine.sampleBuffer;
    if (!buf) return Promise.reject(new Error('Aucun sample chargé.'));

    // Downmix mono (moyenne des canaux) pour l'analyse.
    const ch0 = buf.getChannelData(0);
    const mono = new Float32Array(ch0.length);
    const channels = buf.numberOfChannels;
    if (channels > 1) {
      const ch1 = buf.getChannelData(1);
      for (let i = 0; i < mono.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      mono.set(ch0);
    }

    return new Promise((resolve, reject) => {
      const handler = (e) => {
        this.worker.removeEventListener('message', handler);
        if (e.data.ok) {
          this.lastAnalysis = e.data.result;
          resolve(e.data.result);
        } else {
          reject(new Error(e.data.error));
        }
      };
      this.worker.addEventListener('message', handler);
      // Transfert zéro-copie du PCM vers le Worker.
      this.worker.postMessage(
        { pcm: mono, sampleRate: buf.sampleRate },
        [mono.buffer]
      );
    });
  }

  /**
   * MACRO "1-CLICK AUTO-REMIX".
   * Analyse puis applique automatiquement toute la transformation.
   * @param {object} [opts]
   * @param {number} [opts.targetBpm] - BPM cible (défaut: transport courant)
   * @param {boolean} [opts.autoplay] - démarre la lecture synchronisée
   * @returns {Promise<object>} données d'analyse
   */
  async analyzeAndRemix(opts = {}) {
    const data = await this.analyze();
    this.applyAutoRemix(data, opts);
    return data;
  }

  /**
   * Applique le résultat d'analyse au moteur (intégration finale v11).
   * @param {{bpm:number, offsetMs:number, fundamental:number}} a
   * @param {object} [opts]
   */
  applyAutoRemix(a, opts = {}) {
    const state = this.state;
    const st = a.structure;

    /* ---- 1) TEMPO UPTEMPO (grille des kicks) ----
       kbpm calculé par l'analyse (multiple du BPM détecté). On NE pitch PAS
       le morceau (playbackRate=1) -> il reste reconnaissable ; le kick
       uptempo tourne par-dessus, calé sur le downbeat. */
    const target = st ? st.kbpm : Math.round((a.bpm || 90) * 2);
    state.set('transport.bpm', target);
    state.set('sample.playbackRate', 1.0);

    /* ---- 2) AUTO-TUNING du SUB-KICK (fondamentale globale, repli sub). */
    const fund = a.fundamental > 0 ? a.fundamental : 73;
    let subHz = midiToFreq(Math.round(69 + 12 * Math.log2(fund / 440)));
    while (subHz > 90) subHz /= 2;
    while (subHz < 38) subHz *= 2;
    state.set('kick.tune', +subHz.toFixed(1));

    /* ---- 3) SON DU KICK — gros, "greazy", rumble (decay long + drive). */
    state.set('kick.curve', 'hardclip');
    state.set('kick.drive', 0.85);
    state.set('kick.decay', 0.55);
    state.set('kick.eqGain', 8);
    state.set('kick.noise', 0.12);
    state.set('kick.level', 0.8);   // le kick reste SOUS la voix (original en avant)

    /* ---- 4) SIDECHAIN DOUX — l'original reste au premier plan. */
    this.engine.configureAutoSidechain();
    state.set('sample.loop', false); // lecture unique : l'arrangement suit la structure

    /* ---- 5) ARRANGEMENT STRUCTURÉ (style Unicorn On K) ----
       On branche le moteur d'arrangement sur le Scheduler : couplets posés,
       refrains qui explosent, basses accordées par section. */
    if (st && st.sections && st.sections.length) {
      this.arrangement = new Arrangement(this.engine, st);
      if (this.scheduler) this.scheduler.arrangement = this.arrangement;
    } else {
      // Repli : pas de structure -> pattern 4/4 simple.
      this.applyDefaultPattern();
      if (this.scheduler) this.scheduler.arrangement = null;
    }

    /* ---- 6) ALIGNEMENT DE PHASE + lecture synchronisée. */
    if (opts.autoplay !== false) {
      const ctx = this.engine.ctx;
      const startAt = ctx.currentTime + 0.12;
      const downbeatSec = (a.offsetMs || 0) / 1000;
      this.scheduler?.stop();
      this.engine.playSampleAt(startAt, downbeatSec);
      this.scheduler?.start(startAt);
    }
  }

  /**
   * Pattern HardTechno par défaut, sans sample : garantit que le bouton
   * Auto-Remix produit toujours du son (gros kicks 4/4 uptempo).
   */
  applyDefaultPattern() {
    const state = this.state;
    // Repasse en mode séquenceur classique (pas d'arrangement).
    this.arrangement = null;
    if (this.scheduler) this.scheduler.arrangement = null;
    state.set('transport.bpm', 190);
    const seq = JSON.parse(JSON.stringify(state.get('sequencer')));
    seq.kick = new Array(16).fill(false);
    for (let i = 0; i < 16; i += 4) seq.kick[i] = true;
    seq.kick[14] = true;
    seq.gater = new Array(16).fill(false);
    seq.acid = new Array(16).fill(false);
    state.set('sequencer', seq);
    state.set('kick.curve', 'hardclip');
    state.set('kick.drive', 0.85);
    state.set('kick.decay', 0.55);
    state.set('kick.tune', 55);
  }
}
