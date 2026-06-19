/* =====================================================================
   Knob.js — Potentiomètre rotatif réutilisable, drag & drop souris/tactile.
   Mappe une plage [min..max] (linéaire ou exponentielle) sur ±135°.
   Émet la valeur via callback ; supporte le MIDI Learn (clic droit).
   ===================================================================== */

import { clamp, el } from './utils.js';

export class Knob {
  /**
   * @param {object} opts
   * @param {string} opts.label
   * @param {number} opts.min
   * @param {number} opts.max
   * @param {number} opts.value
   * @param {boolean} [opts.exp]   - mapping exponentiel (utile pour les Hz)
   * @param {string}  [opts.unit]
   * @param {string}  [opts.variant] - classe de couleur ('acid'|'fx')
   * @param {(v:number)=>void} opts.onChange
   * @param {(setter:(v01:number)=>void)=>void} [opts.onLearn] - active le MIDI learn
   */
  constructor(opts) {
    this.opts = Object.assign({ exp: false, unit: '', variant: '' }, opts);
    this.value = opts.value;
    this._buildDom();
    this._bindDrag();
    this._render();
  }

  _buildDom() {
    this.root = el('div', `knob ${this.opts.variant}`);
    this.dial = el('div', 'knob-dial');
    this.labelEl = el('div', 'knob-label', this.opts.label);
    this.valEl = el('div', 'knob-val');
    this.root.append(this.dial, this.valEl, this.labelEl);
  }

  /** Convertit une valeur réelle en position normalisée 0..1. */
  _toNorm(v) {
    const { min, max, exp } = this.opts;
    if (exp) {
      const lmin = Math.log(min), lmax = Math.log(max);
      return (Math.log(clamp(v, min, max)) - lmin) / (lmax - lmin);
    }
    return (v - min) / (max - min);
  }

  /** Convertit une position normalisée 0..1 en valeur réelle. */
  _fromNorm(n) {
    const { min, max, exp } = this.opts;
    n = clamp(n, 0, 1);
    if (exp) {
      const lmin = Math.log(min), lmax = Math.log(max);
      return Math.exp(lmin + (lmax - lmin) * n);
    }
    return min + (max - min) * n;
  }

  _render() {
    const n = this._toNorm(this.value);
    const ang = -135 + n * 270; // plage de rotation ±135°
    this.dial.style.setProperty('--ang', ang + 'deg');
    const v = this.value;
    const disp = Math.abs(v) >= 100 ? v.toFixed(0) : (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));
    this.valEl.textContent = disp + this.opts.unit;
  }

  /** Fixe la valeur (depuis l'état / MIDI) sans re-déclencher onChange. */
  setValue(v, silent = false) {
    this.value = clamp(v, this.opts.min, this.opts.max);
    this._render();
    if (!silent) this.opts.onChange(this.value);
  }

  /** Fixe via position normalisée (utilisé par le MIDI Learn). */
  setNorm(n) { this.setValue(this._fromNorm(n)); }

  _bindDrag() {
    let startY = 0, startNorm = 0, dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = startY - y;             // vers le haut = augmente
      const sensitivity = e.shiftKey ? 600 : 180; // Shift = réglage fin
      const n = clamp(startNorm + dy / sensitivity, 0, 1);
      this.setValue(this._fromNorm(n));
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    const onDown = (e) => {
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startNorm = this._toNorm(this.value);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    };

    this.root.addEventListener('mousedown', onDown);
    this.root.addEventListener('touchstart', onDown, { passive: false });

    // Molette pour ajustement fin.
    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = this._toNorm(this.value) + (e.deltaY < 0 ? 0.02 : -0.02);
      this.setValue(this._fromNorm(n));
    }, { passive: false });

    // Clic droit = MIDI Learn.
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.opts.onLearn) return;
      this.root.classList.add('midi-learn');
      this.opts.onLearn((v01) => this.setNorm(v01));
      setTimeout(() => this.root.classList.remove('midi-learn'), 4000);
    });
  }
}
