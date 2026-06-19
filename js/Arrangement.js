/* =====================================================================
   Arrangement.js — Moteur d'arrangement temps réel "Unicorn On K".

   Branché sur le Scheduler (mode arrangement), il décide À CHAQUE PAS ce
   qu'il faut déclencher selon la SECTION du morceau à cet instant :

     - COUPLET (posé)  : la musique mène. Kick half-time léger, ducking
                         minimal -> l'original reste au premier plan.
     - REFRAIN (drop)  : gros kicks "greazy" + perc, AVEC ORIGINALITÉ :
                         * kick "tonal" (la hauteur suit un riff mélodique),
                         * styles de pattern qui ÉVOLUENT par refrain
                           (straight -> rolling -> triplet -> climax),
                         * fills/rolls/gaps/ghosts/double-time.
     - BUILD           : riser + VOCAL CHOPS (stutter du morceau) accélérés
                         -> impact sur le drop.
     - INTRO/OUTRO     : quasi a cappella, l'original respire.

   L'index de pas GLOBAL du Scheduler donne la mesure :
       bar = floor(stepGlobal / 16)   (16 pas = 1 mesure = 4 kicks)
   aligné sur le downbeat -> indexe directement `sections`.
   ===================================================================== */

export class Arrangement {
  /**
   * @param {object} engine - moteur live ou façade offline (mêmes méthodes)
   * @param {object} structure - { downbeat, beat, barLen, sections:string[], barSub:number[] }
   */
  constructor(engine, structure) {
    this.engine = engine;
    this.state = engine.state || null;   // pour kick tonal/gamme + mode de basse
    this.s = structure;
    this.sections = structure.sections || [];
    this.barSub = structure.barSub || [];
    this.barLen = structure.barLen;
    this.beat = structure.beat;
    this.downbeat = structure.downbeat || 0;

    this.driveDef = { chorus: 16, build: 9, verse: 7, intro: 4, outro: 4, trans: 8 };
    this.duckDef = { chorus: 0.5, build: 0.3, verse: 0.18, trans: 0.28, intro: 0.05, outro: 0.05 };
    this.intenDef = { chorus: 1, build: 0.6, verse: 0.45, trans: 0.5, intro: 0.12, outro: 0.12 };
    this.rebuild();

    // Gammes disponibles pour le kick "tonal" / la basse (degrés en demi-tons).
    this.scales = {
      minorPent: [0, 3, 5, 7, 10, 12],
      minor: [0, 2, 3, 5, 7, 8, 10, 12],
      phrygian: [0, 1, 3, 5, 7, 8, 10, 12],
      major: [0, 2, 4, 5, 7, 9, 11, 12]
    };
    // Riffs mélodiques (degrés de gamme par temps) selon le style de refrain.
    this.melodies = [
      [0, 0, 0, 0],   // style 0 : kick fixe (classique)
      [0, 0, 2, 1],   // style 1 : léger mouvement
      [0, 2, 3, 4],   // style 2 : riff montant
      [0, 3, 4, 5]    // style 3+ : riff large (climax)
    ];
  }

  /**
   * Recalcule positions de phrase et numéros de refrain depuis l'état
   * courant des sections (appelé après chaque édition de l'arrangement).
   */
  rebuild() {
    this.sections = this.s.sections;
    this.barSub = this.s.barSub;
    const n = this.sections.length;
    this.pp = new Array(n).fill(0);
    for (let b = 0; b < n; b++)
      this.pp[b] = (b > 0 && this.sections[b] === this.sections[b - 1]) ? this.pp[b - 1] + 1 : 0;
    this.chorusNum = new Array(n).fill(0);
    let cn = -1;
    for (let b = 0; b < n; b++) {
      if (this.sections[b] === 'chorus' && (b === 0 || this.sections[b - 1] !== 'chorus')) cn++;
      this.chorusNum[b] = Math.max(0, cn);
    }
  }

  /** Lecture d'un override par mesure avec repli sur le défaut du type. */
  _ov(arrName, bar, type, defTable) {
    const a = this.s[arrName];
    return (a && a[bar] != null) ? a[bar] : (defTable ? defTable[type] : 1);
  }

  /** Hauteur (Hz) du kick "tonal" pour un temps donné d'un refrain. */
  _kickFreq(f, style, phraseBeat) {
    const k = this.state ? this.state.get('kick') : null;
    if (k && k.tonal === false) return f;        // kick tonal désactivé -> hauteur fixe
    const scale = (k && this.scales[k.scale]) || this.scales.minorPent;
    const mel = this.melodies[Math.min(style, this.melodies.length - 1)];
    const deg = scale[mel[phraseBeat % mel.length] % scale.length] || 0;
    let hz = f * Math.pow(2, deg / 12);
    while (hz > 130) hz /= 2;   // garde le kick dans le grave
    return hz;
  }

  /**
   * Appelé par le Scheduler à chaque pas (1/16) programmé.
   * @param {number} stepGlobal - index de pas absolu (0,1,2,…)
   * @param {number} time - heure absolue de déclenchement (s)
   */
  tick(stepGlobal, time) {
    const bar = Math.floor(stepGlobal / 16);
    if (bar >= this.sections.length) return;

    const stepInBar = stepGlobal % 16;
    const q = Math.floor(stepInBar / 4);   // temps (0..3)
    const six = stepInBar % 4;             // double-croche (0..3)
    const type = this.sections[bar];
    const f = this.barSub[bar] || 55;
    const pp = this.pp[bar];
    const eng = this.engine;

    // ---- Overrides PAR SECTION (éditeur) avec repli sur les défauts ----
    const dr = this._ov('drive', bar, type, this.driveDef);
    const inten = this._ov('intensity', bar, type, this.intenDef);
    const fade = this._ov('fade', bar, type, null);        // 0..1 (fondus)
    const duckBase = this._ov('duck', bar, type, this.duckDef);
    const duckAmt = duckBase * fade;                       // fondu -> moins de ducking aux bords
    const V = (v) => v * fade;                             // vélocité atténuée par le fondu
    if (fade < 0.04) return;                               // fondu total -> silence des kicks

    // Seed déterministe par section (variations stables d'un export à l'autre).
    const seed = (this.s.seed && this.s.seed[bar]) ? this.s.seed[bar] : 12345;
    let _r = (seed ^ (stepGlobal * 2654435761)) >>> 0;
    const Rnd = () => ((_r = (_r * 1664525 + 1013904223) >>> 0) / 4294967296);

    // ---- LAYER DE BASSE (sub) — accordé à la section, riff léger, sidechain ----
    if (eng.subBass) {
      const defOn = (type === 'chorus' || type === 'build' || type === 'trans');
      const bassOn = (this.s.bassOn && this.s.bassOn[bar] != null) ? !!this.s.bassOn[bar] : defOn;
      const mode = (this.state ? this.state.get('bass').mode : 'offbeat');
      if (bassOn && fade > 0.04) {
        const boct = (this.s.bassOct && this.s.bassOct[bar] != null) ? this.s.bassOct[bar] : 0;
        // Riff de basse : surtout la fondamentale, avec quinte/octave ponctuelles
        // (mouvement musical sans surcharger). Suit la position dans la phrase.
        const riff = [0, 0, 0, 7, 0, 0, 12, 7];
        const noteFreq = (idx) => f * Math.pow(2, boct + (riff[idx % riff.length] / 12));
        if (mode === 'sustain') { if (q === 0 && six === 0) eng.subBass.trigger(time, noteFreq(pp), this.barLen * 0.95, V(0.8)); }
        else if (mode === 'root') { if (six === 0) eng.subBass.trigger(time, noteFreq(q), this.beat * 0.6, V(0.9)); }
        else { if (six === 2) eng.subBass.trigger(time, noteFreq(q), this.beat * 0.5, V(0.95)); } // offbeat
      }
      // Sidechain de la basse : elle plonge sous chaque kick (modes root/sustain).
      if (mode !== 'offbeat' && six === 0 && eng.subBass.duck) eng.subBass.duck(time);
    }

    switch (type) {
      case 'chorus': {
        let style = Math.min(this.chorusNum[bar], 3);
        const ks = this.s.kickStyle && this.s.kickStyle[bar];
        if (ks && ks !== 'auto') {
          const map = { straight: 0, rolling: 1, triplet: 2, climax: 3 };
          if (map[ks] != null) style = map[ks];
        }
        const phraseBeat = (pp * 4 + q) % 4;
        const fk = this._kickFreq(f, style, phraseBeat);
        const gapBar = (pp % 8 === 7);
        const fillBar = (pp % 4 === 3);
        const halfTime = inten < 0.3;                       // intensité faible -> half-time

        if (fillBar && q === 3 && inten >= 0.4) {
          eng.kick.trigger(time, V(0.85), { tune: fk * Math.pow(2, six / 12), decay: 0.16, drive: dr });
          if (six === 0) eng.duck(time, duckAmt);
        } else if (six === 0) {
          const skip = (gapBar && q === 0) || (halfTime && (q === 1 || q === 3));
          if (!skip) {
            eng.kick.trigger(time, V(0.95 + Rnd() * 0.05), { tune: fk, decay: 0.5, drive: dr });
            eng.duck(time, duckAmt);
          }
        }

        // Variations de style, conditionnées par l'INTENSITÉ réglée.
        if (inten >= 0.5 && style >= 1 && six === 2 && (q === 1 || q === 3))
          eng.kick.trigger(time, V(0.55), { tune: fk, decay: 0.22, drive: dr });
        if (inten >= 0.6 && style >= 2 && q === 2 && six === 2 && Rnd() < 0.7)
          eng.kick.trigger(time, V(0.45), { tune: fk * 1.12, decay: 0.18, drive: dr });
        if (inten >= 0.8 && style >= 3 && q >= 2 && six % 2 === 0)
          eng.kick.trigger(time, V(0.6), { tune: fk, decay: 0.2, drive: dr });

        if (six === 2) eng.playHat(time, V(0.1 + style * 0.02) * (0.5 + inten * 0.5));
        if (six === 0 && (q === 1 || q === 3)) eng.playClap(time, V(0.2));
        if (inten >= 0.6 && style >= 2 && six === 0 && q === 2 && Rnd() < 0.5) eng.playHat(time, V(0.1));
        if (pp === 0 && stepInBar === 0 && fade > 0.5) eng.playImpact(time);
        // Downlifter en toute fin de refrain (transition vers la suite).
        if (this.sections[bar + 1] !== 'chorus' && pp >= 0 && stepInBar === 12 &&
            (bar + 1 >= this.sections.length || this.sections[bar + 1] !== 'chorus') && eng.playSweepDown)
          eng.playSweepDown(time, this.beat * 3, 0.18);
        break;
      }

      case 'verse': {
        const beats = inten >= 0.25 ? [0, 2] : [0];
        if (six === 0 && beats.includes(q)) {
          eng.kick.trigger(time, V(q === 0 ? 0.72 : 0.6), { tune: f, decay: 0.5, drive: dr });
          eng.duck(time, duckAmt);
        }
        if (six === 2 && q % 2 === 1 && Rnd() < 0.5 * inten + 0.2) eng.playHat(time, V(0.08));
        break;
      }

      case 'build': {
        if (six === 0 && (q === 0 || q === 2)) {
          eng.kick.trigger(time, V(0.7), { tune: f, decay: 0.45, drive: dr });
          eng.duck(time, duckAmt);
        }
        if (pp === 0 && stepInBar === 0) eng.playRiser(time, 2 * this.barLen);
        // Reverse swell (cymbale inversée) sur la mesure juste avant le drop.
        if (this.sections[bar + 1] === 'chorus' && stepInBar === 0 && eng.playReverseSwell)
          eng.playReverseSwell(time, this.barLen, 0.2);
        if (this.sections[bar + 1] === 'chorus') {
          const chopOffset = this.downbeat + bar * this.barLen;
          const gate = stepInBar < 8 ? 2 : 1;
          if (stepInBar % gate === 0 && eng.sampleBuffer) {
            const sliceDur = (this.beat / 4) * gate * 0.9;
            eng.playSlice(time, chopOffset, sliceDur, 1, 0.55);
          }
          eng.playHat(time, 0.1 + 0.14 * (stepInBar / 15));
        }
        break;
      }

      case 'trans': {
        if (six === 0 && q % 2 === 0) { eng.kick.trigger(time, V(0.7), { tune: f, decay: 0.45, drive: dr }); eng.duck(time, duckAmt); }
        if (six === 2 && Rnd() < 0.4) eng.playHat(time, V(0.08));
        break;
      }

      default: { // intro / outro
        if (six === 0 && q === 0 && Rnd() < 0.2) eng.playHat(time, V(0.06));
        break;
      }
    }
  }
}
