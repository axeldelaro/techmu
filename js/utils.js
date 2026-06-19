/* =====================================================================
   utils.js — Helpers partagés (clamp, conversions, DOM).
   ===================================================================== */

/** Borne une valeur entre min et max. */
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Interpolation linéaire. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Mappe x de [a..b] vers [c..d]. */
export const mapRange = (x, a, b, c, d) => c + (d - c) * ((x - a) / (b - a));

/** Conversion dB -> gain linéaire. */
export const dbToGain = (db) => Math.pow(10, db / 20);

/**
 * Numéro de note MIDI -> fréquence (Hz), A4 (MIDI 69) = 440 Hz.
 * @param {number} midi
 * @returns {number}
 */
export const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** Noms des notes pour le menu déroulant (octaves 1-3, registre basse). */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Raccourci querySelector. */
export const $ = (sel, root = document) => root.querySelector(sel);
/** Raccourci querySelectorAll -> Array. */
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Crée un élément avec classe et contenu optionnels. */
export function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}
