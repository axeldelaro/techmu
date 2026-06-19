/* =====================================================================
   SectionModel.js — Modèle d'arrangement ÉDITABLE par section.

   L'analyse renvoie une structure "par mesure" (sections[], barSub[]).
   Ici on la transforme en SEGMENTS éditables (un par couplet/refrain/…)
   avec des propriétés réglables (type, basse, intensité, drive, ducking,
   fondus). `compile()` reprojette les segments en tableaux PAR MESURE que
   le moteur d'Arrangement lit à chaque pas -> les réglages s'appliquent
   en live ET à l'export, sans réanalyser.
   ===================================================================== */

import { NOTE_NAMES } from './utils.js';

/** Valeurs par défaut d'un segment selon son type. */
export function defaultsFor(type) {
  switch (type) {
    case 'chorus': return { intensity: 1.0, drive: 16, duck: 0.5 };
    case 'verse':  return { intensity: 0.45, drive: 7, duck: 0.18 };
    case 'build':  return { intensity: 0.6, drive: 9, duck: 0.3 };
    case 'trans':  return { intensity: 0.5, drive: 8, duck: 0.28 };
    default:       return { intensity: 0.12, drive: 4, duck: 0.05 }; // intro / outro
  }
}

/** Libellé lisible d'un type de section. */
export function typeLabel(type) {
  return { chorus: 'Refrain', verse: 'Couplet', build: 'Build', trans: 'Transition', intro: 'Intro', outro: 'Outro' }[type] || type;
}

/** Hz -> nom de note (pour l'affichage du réglage de basse). */
export function hzToNote(hz) {
  if (!hz || hz <= 0) return '—';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/**
 * Construit la liste de segments éditables à partir des sections par mesure.
 * Conserve une copie immuable de la détection (sectionsAuto / barSubAuto)
 * pour pouvoir revenir à l'"Auto".
 * @param {object} st - structure renvoyée par l'analyse
 */
export function buildSegments(st) {
  st.sectionsAuto = st.sections.slice();
  st.barSubAuto = st.barSub.slice();

  const segs = [];
  let b = 0;
  while (b < st.sections.length) {
    let e = b;
    while (e < st.sections.length && st.sections[e] === st.sections[b]) e++;
    const type = st.sections[b];
    const d = defaultsFor(type);
    // Basse par défaut = médiane détectée sur le segment.
    const subs = st.barSub.slice(b, e).filter((x) => x > 0).sort((a, b) => a - b);
    const sub = subs.length ? subs[subs.length >> 1] : 55;
    segs.push({
      start: b, end: e, type,
      sub,                 // Hz (réglable)
      subAuto: true,       // suit la détection tant que non modifié
      intensity: d.intensity,
      drive: d.drive,
      duck: d.duck,
      fadeIn: 0,           // mesures de fondu d'entrée
      fadeOut: 0,          // mesures de fondu de sortie
      seed: (Math.random() * 1e9) | 0
    });
    b = e;
  }
  st.segments = segs;
  compile(st);
  return segs;
}

/**
 * Reprojette les segments en tableaux PAR MESURE consommés par l'Arrangement.
 * Remplit : sections[], barSub[], intensity[], drive[], duck[], fade[], seed[].
 * @param {object} st
 */
export function compile(st) {
  const n = st.totalBars;
  st.intensity = new Float32Array(n);
  st.drive = new Float32Array(n);
  st.duck = new Float32Array(n);
  st.fade = new Float32Array(n).fill(1);
  st.seed = new Int32Array(n);

  for (const seg of st.segments) {
    const L = seg.end - seg.start;
    for (let i = seg.start; i < seg.end; i++) {
      const idx = i - seg.start;
      st.sections[i] = seg.type;
      st.barSub[i] = seg.subAuto ? (st.barSubAuto[i] || seg.sub) : seg.sub;
      st.intensity[i] = seg.intensity;
      st.drive[i] = seg.drive;
      st.duck[i] = seg.duck;
      st.seed[i] = seg.seed;
      // Fondus d'entrée/sortie -> gain 0..1 appliqué aux kicks/perc/ducking.
      let g = 1;
      if (seg.fadeIn > 0 && idx < seg.fadeIn) g = Math.min(g, (idx + 1) / (seg.fadeIn + 1));
      if (seg.fadeOut > 0 && idx >= L - seg.fadeOut) g = Math.min(g, (L - idx) / (seg.fadeOut + 1));
      st.fade[i] = g;
    }
  }
}

/**
 * Étend/réduit la fin d'un segment de `delta` mesures, en poussant le
 * segment suivant. Supprime un segment réduit à zéro. Recompile.
 */
export function resizeSegment(st, index, edge, delta) {
  const segs = st.segments;
  const seg = segs[index];
  if (!seg) return;
  if (edge === 'end') {
    const next = segs[index + 1];
    let ne = seg.end + delta;
    ne = Math.max(seg.start + 1, Math.min(ne, st.totalBars));
    if (next) { next.start = ne; if (next.start >= next.end) segs.splice(index + 1, 1); }
    seg.end = ne;
  } else { // 'start'
    const prev = segs[index - 1];
    let ns = seg.start + delta;
    ns = Math.max(0, Math.min(ns, seg.end - 1));
    if (prev) { prev.end = ns; if (prev.start >= prev.end) { segs.splice(index - 1, 1); } }
    seg.start = ns;
  }
  // Recouds les trous éventuels.
  for (let i = 0; i < segs.length - 1; i++) segs[i + 1].start = segs[i].end;
  compile(st);
}
