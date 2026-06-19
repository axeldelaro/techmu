/* =====================================================================
   Arrangement.js — Moteur d'arrangement temps réel "Unicorn On K".

   Branché sur le Scheduler (mode arrangement), il décide À CHAQUE PAS ce
   qu'il faut déclencher selon la SECTION du morceau à cet instant :

     - COUPLET (posé)  : la musique mène. Kick half-time léger, ducking
                         minimal -> l'original reste au premier plan.
     - REFRAIN (drop)  : gros kicks "greazy" 4/4 + perc + fills/rolls/gaps,
                         basse accordée à la tonalité DE CETTE section.
     - BUILD           : riser + snare-roll accéléré -> impact sur le drop.
     - INTRO/OUTRO     : quasi a cappella, l'original respire.

   L'index de pas GLOBAL du Scheduler donne directement la mesure :
       bar = floor(stepGlobal / 16)   (16 pas = 1 mesure = 4 kicks)
   et cette numérotation est alignée sur le downbeat détecté, donc sur le
   tableau `sections` renvoyé par l'analyse.
   ===================================================================== */

export class Arrangement {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine
   * @param {object} structure - { downbeat, beat, barLen, sections:string[], barSub:number[] }
   */
  constructor(engine, structure) {
    this.engine = engine;
    this.s = structure;
    this.sections = structure.sections || [];
    this.barSub = structure.barSub || [];
    this.barLen = structure.barLen;

    // Position de phrase (nb de mesures consécutives de même type, base 0).
    this.pp = new Array(this.sections.length).fill(0);
    for (let b = 0; b < this.sections.length; b++) {
      this.pp[b] = (b > 0 && this.sections[b] === this.sections[b - 1]) ? this.pp[b - 1] + 1 : 0;
    }
    // Drive de distorsion par type de section.
    this.drive = { chorus: 16, build: 9, verse: 7, intro: 4, outro: 4, trans: 8 };
  }

  /**
   * Appelé par le Scheduler à chaque pas (1/16) programmé.
   * @param {number} stepGlobal - index de pas absolu (0,1,2,…)
   * @param {number} time - heure absolue de déclenchement (s)
   */
  tick(stepGlobal, time) {
    const bar = Math.floor(stepGlobal / 16);
    if (bar >= this.sections.length) return; // fin du morceau : plus de kicks

    const stepInBar = stepGlobal % 16;
    const q = Math.floor(stepInBar / 4);  // temps (0..3)
    const six = stepInBar % 4;            // double-croche dans le temps (0..3)
    const type = this.sections[bar];
    const f = this.barSub[bar] || 55;
    const pp = this.pp[bar];
    const eng = this.engine;
    const dr = this.drive[type] || 8;
    const R = Math.random();

    switch (type) {
      case 'chorus': {
        const gapBar = (pp % 8 === 7);   // mesure "gap" : on saute le 1er kick
        const fillBar = (pp % 4 === 3);  // dernière mesure de phrase -> roll

        if (fillBar && q === 3) {
          // ROLL 16e montant sur le dernier temps (fill).
          eng.kick.trigger(time, 0.85, { tune: f * Math.pow(2, six / 12), decay: 0.16, drive: dr });
          if (six === 0) eng.duck(time, 0.5);
        } else if (six === 0) {
          if (!(gapBar && q === 0)) {
            eng.kick.trigger(time, 0.95 + R * 0.05, { tune: f, decay: 0.5, drive: dr });
            eng.duck(time, 0.5);                 // refrain : ducking modéré (voix présente)
          }
        }
        // Percussion industrielle.
        if (six === 2) eng.playHat(time, 0.12);                 // offbeats (les "et")
        if (six === 0 && (q === 1 || q === 3)) eng.playClap(time, 0.2);
        if (q === 1 && six === 2 && R < 0.12) eng.kick.trigger(time, 0.4, { tune: f, decay: 0.2, drive: dr });
        // Impact sur la toute première mesure d'un refrain.
        if (pp === 0 && stepInBar === 0) eng.playImpact(time);
        break;
      }

      case 'verse': {
        // POSÉ : kick half-time discret, ducking minimal -> musique en avant.
        if (six === 0 && (q === 0 || q === 2)) {
          eng.kick.trigger(time, q === 0 ? 0.72 : 0.6, { tune: f, decay: 0.5, drive: dr });
          eng.duck(time, 0.18);
        }
        if (six === 2 && q % 2 === 1 && R < 0.5) eng.playHat(time, 0.08);
        break;
      }

      case 'build': {
        if (six === 0 && (q === 0 || q === 2)) {
          eng.kick.trigger(time, 0.7, { tune: f, decay: 0.45, drive: dr });
          eng.duck(time, 0.3);
        }
        if (pp === 0 && stepInBar === 0) eng.playRiser(time, 2 * this.barLen);
        // Dernière mesure avant le refrain -> snare-roll accéléré.
        if (this.sections[bar + 1] === 'chorus') {
          eng.playHat(time, 0.1 + 0.14 * (stepInBar / 15));
          if (six === 0) eng.playClap(time, 0.12);
        }
        break;
      }

      case 'trans': {
        // Transition : groove half-time léger.
        if (six === 0 && q % 2 === 0) { eng.kick.trigger(time, 0.7, { tune: f, decay: 0.45, drive: dr }); eng.duck(time, 0.28); }
        if (six === 2 && R < 0.4) eng.playHat(time, 0.08);
        break;
      }

      default: { // intro / outro : l'original respire (quasi a cappella)
        if (six === 0 && q === 0 && R < 0.2) eng.playHat(time, 0.06);
        break;
      }
    }
  }
}
