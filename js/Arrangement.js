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
    this.s = structure;
    this.sections = structure.sections || [];
    this.barSub = structure.barSub || [];
    this.barLen = structure.barLen;
    this.beat = structure.beat;
    this.downbeat = structure.downbeat || 0;

    const n = this.sections.length;
    // Position de phrase (mesures consécutives de même type, base 0).
    this.pp = new Array(n).fill(0);
    for (let b = 0; b < n; b++)
      this.pp[b] = (b > 0 && this.sections[b] === this.sections[b - 1]) ? this.pp[b - 1] + 1 : 0;

    // Numéro de refrain (0,1,2,…) -> sert à FAIRE ÉVOLUER le style/intensité.
    this.chorusNum = new Array(n).fill(0);
    let cn = -1;
    for (let b = 0; b < n; b++) {
      if (this.sections[b] === 'chorus' && (b === 0 || this.sections[b - 1] !== 'chorus')) cn++;
      this.chorusNum[b] = Math.max(0, cn);
    }

    this.drive = { chorus: 16, build: 9, verse: 7, intro: 4, outro: 4, trans: 8 };

    // Gamme mineure pentatonique pour le kick "tonal" (degrés en demi-tons).
    this.scale = [0, 3, 5, 7, 10, 12];
    // Riffs mélodiques (degrés de gamme par temps) selon le style de refrain.
    this.melodies = [
      [0, 0, 0, 0],   // style 0 : kick fixe (classique)
      [0, 0, 2, 1],   // style 1 : léger mouvement
      [0, 2, 3, 4],   // style 2 : riff montant
      [0, 3, 4, 5]    // style 3+ : riff large (climax)
    ];
  }

  /** Hauteur (Hz) du kick "tonal" pour un temps donné d'un refrain. */
  _kickFreq(f, style, phraseBeat) {
    const mel = this.melodies[Math.min(style, this.melodies.length - 1)];
    const deg = this.scale[mel[phraseBeat % mel.length] % this.scale.length] || 0;
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
    const dr = this.drive[type] || 8;
    const Rnd = Math.random();

    switch (type) {
      case 'chorus': {
        const style = Math.min(this.chorusNum[bar], 3);   // évolue par refrain
        const phraseBeat = (pp * 4 + q) % 4;
        const fk = this._kickFreq(f, style, phraseBeat);
        const gapBar = (pp % 8 === 7);
        const fillBar = (pp % 4 === 3);

        if (fillBar && q === 3) {
          // ROLL 16e montant (fill de fin de phrase).
          eng.kick.trigger(time, 0.85, { tune: fk * Math.pow(2, six / 12), decay: 0.16, drive: dr });
          if (six === 0) eng.duck(time, 0.5);
        } else if (six === 0) {
          if (!(gapBar && q === 0)) {
            eng.kick.trigger(time, 0.95 + Rnd * 0.05, { tune: fk, decay: 0.5, drive: dr });
            eng.duck(time, 0.5);
          }
        }

        // ---- Variations de STYLE (originalité par refrain) ----
        if (style >= 1 && six === 2 && (q === 1 || q === 3)) {
          // rolling : kick offbeat (double-croche) sur certains temps
          eng.kick.trigger(time, 0.55, { tune: fk, decay: 0.22, drive: dr });
        }
        if (style >= 2 && q === 2 && six === 2 && Rnd < 0.7) {
          // triplet-ish ghost
          eng.kick.trigger(time, 0.45, { tune: fk * 1.12, decay: 0.18, drive: dr });
        }
        if (style >= 3 && q >= 2 && six % 2 === 0) {
          // climax : double-time sur la 2e moitié de mesure
          eng.kick.trigger(time, 0.6, { tune: fk, decay: 0.2, drive: dr });
        }

        // ---- Percussion (densité croissante avec le style) ----
        if (six === 2) eng.playHat(time, 0.1 + style * 0.02);
        if (six === 0 && (q === 1 || q === 3)) eng.playClap(time, 0.2);
        if (style >= 2 && six === 0 && q === 2 && Rnd < 0.5) eng.playHat(time, 0.1);
        if (pp === 0 && stepInBar === 0) eng.playImpact(time);
        break;
      }

      case 'verse': {
        // POSÉ : kick half-time discret, ducking minimal -> musique en avant.
        if (six === 0 && (q === 0 || q === 2)) {
          eng.kick.trigger(time, q === 0 ? 0.72 : 0.6, { tune: f, decay: 0.5, drive: dr });
          eng.duck(time, 0.18);
        }
        if (six === 2 && q % 2 === 1 && Rnd < 0.5) eng.playHat(time, 0.08);
        break;
      }

      case 'build': {
        if (six === 0 && (q === 0 || q === 2)) {
          eng.kick.trigger(time, 0.7, { tune: f, decay: 0.45, drive: dr });
          eng.duck(time, 0.3);
        }
        if (pp === 0 && stepInBar === 0) eng.playRiser(time, 2 * this.barLen);
        // Dernière mesure avant le refrain -> VOCAL CHOPS accélérés + roll.
        if (this.sections[bar + 1] === 'chorus') {
          // Tranche figée prise au début de la mesure (stutter du morceau).
          const chopOffset = this.downbeat + bar * this.barLen;
          const gate = stepInBar < 8 ? 2 : 1;            // accélère en 2e moitié
          if (stepInBar % gate === 0 && eng.sampleBuffer) {
            const sliceDur = (this.beat / 4) * gate * 0.9;
            eng.playSlice(time, chopOffset, sliceDur, 1, 0.55);
          }
          eng.playHat(time, 0.1 + 0.14 * (stepInBar / 15));
        }
        break;
      }

      case 'trans': {
        if (six === 0 && q % 2 === 0) { eng.kick.trigger(time, 0.7, { tune: f, decay: 0.45, drive: dr }); eng.duck(time, 0.28); }
        if (six === 2 && Rnd < 0.4) eng.playHat(time, 0.08);
        break;
      }

      default: { // intro / outro : l'original respire (quasi a cappella)
        if (six === 0 && q === 0 && Rnd < 0.2) eng.playHat(time, 0.06);
        break;
      }
    }
  }
}
