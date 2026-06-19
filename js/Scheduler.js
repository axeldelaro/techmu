/* =====================================================================
   Scheduler.js — Séquenceur à ordonnancement "sample-accurate".

   PRINCIPE DU LOOKAHEAD SCHEDULER (d'après A. Wittenstein / C. Wilson) :
   -----------------------------------------------------------------------
   On NE déclenche PAS les notes avec setTimeout/setInterval (gigue de
   l'event loop = désync). À la place :

     1) Un Web Worker sert d'horloge stable : il poste un "tick" toutes
        les `lookaheadMs` (~25 ms), indépendamment du rendu de l'UI.

     2) À chaque tick, on regarde la fenêtre [now, now + scheduleAhead].
        Tant que la prochaine note tombe dans cette fenêtre, on la
        programme à son heure EXACTE via les méthodes *AtTime() de la
        Web Audio API (qui, elles, sont échantillon-précises).

   Conséquence : même si l'UI rame ou qu'un tick arrive en retard, les
   notes ont déjà été programmées sur l'horloge audio -> aucune dérive.

   Le SWING décale les pas impairs (les "et" de la croche) d'une fraction
   de la durée d'un pas pour créer le groove.
   ===================================================================== */

export class Scheduler {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine
   * @param {import('./StateManager.js').StateManager} state
   */
  constructor(engine, state) {
    this.engine = engine;
    this.state = state;

    this.lookaheadMs = 25;     // période du worker (horloge)
    this.scheduleAhead = 0.12; // s : fenêtre d'anticipation

    this.current16th = 0;      // index du pas courant (0..15)
    this.nextNoteTime = 0;     // heure (s) du prochain pas à programmer
    this.isRunning = false;

    /** callback UI : (stepIndex, time) -> void (mise en surbrillance du playhead). */
    this.onStep = null;

    this._initWorker();
  }

  /** Crée le worker-horloge à partir d'un Blob (aucun fichier externe requis). */
  _initWorker() {
    const code = `
      let timer = null;
      let interval = 25;
      self.onmessage = (e) => {
        if (e.data === 'start') {
          if (timer) return;
          timer = setInterval(() => self.postMessage('tick'), interval);
        } else if (e.data === 'stop') {
          clearInterval(timer); timer = null;
        } else if (e.data && e.data.interval) {
          interval = e.data.interval;
          if (timer) { clearInterval(timer); timer = setInterval(() => self.postMessage('tick'), interval); }
        }
      };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (e) => { if (e.data === 'tick') this._scheduler(); };
    this.worker.postMessage({ interval: this.lookaheadMs });
  }

  /** Durée d'un pas (1/16 de mesure) en secondes, selon le BPM courant. */
  _secondsPer16th() {
    const bpm = this.state.get('transport.bpm');
    return (60 / bpm) / 4; // une noire = 60/bpm ; un 1/16 = /4
  }

  /**
   * Avance `nextNoteTime` au pas suivant en appliquant le swing.
   * Le swing retarde les pas impairs d'une fraction du pas.
   */
  _advance() {
    const secs16 = this._secondsPer16th();
    const swing = this.state.get('transport.swing'); // 0..0.5
    // Décalage appliqué au pas impair qui SUIT : on ajoute du temps avant lui.
    this.nextNoteTime += secs16;
    this.current16th = (this.current16th + 1) % 16;
  }

  /** Calcule l'heure programmée d'un pas en tenant compte du swing. */
  _swungTime(baseTime, stepIndex) {
    const swing = this.state.get('transport.swing');
    // Les pas impairs (1,3,5…) sont poussés en avant.
    if (stepIndex % 2 === 1) return baseTime + this._secondsPer16th() * swing;
    return baseTime;
  }

  /** Programme tous les évènements du pas `step` à l'heure `time`. */
  _scheduleStep(step, time) {
    const seq = this.state.get('sequencer');
    const swungTime = this._swungTime(time, step);

    // --- Kick ---
    if (seq.kick[step]) {
      this.engine.kick.trigger(swungTime, 1);
      // Le kick déclenche le ducking sidechain (signal fantôme).
      this.engine.duck(swungTime);
    }
    // --- Acid ---
    if (seq.acid[step]) {
      const note = seq.acidNotes[step] || 0;
      const accent = !!seq.acidAccents[step];
      // Slide si le pas suivant est aussi actif (legato 303).
      const slide = !!seq.acid[(step + 1) % 16];
      this.engine.acid.trigger(swungTime, note, accent, slide);
    }
    // --- Gater (coupure master) ---
    if (seq.gater[step]) {
      this.engine.gate(swungTime, this._secondsPer16th());
    }

    // Notifie l'UI pour le playhead (peut être en retard sans impact audio).
    if (this.onStep) this.onStep(step, swungTime);
  }

  /**
   * Boucle d'ordonnancement appelée à chaque tick du worker.
   * Programme à l'avance toutes les notes tombant dans la fenêtre.
   */
  _scheduler() {
    const now = this.engine.ctx.currentTime;
    while (this.nextNoteTime < now + this.scheduleAhead) {
      this._scheduleStep(this.current16th, this.nextNoteTime);
      this._advance();
    }
  }

  /** Démarre la lecture. */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.current16th = 0;
    // Petite marge pour ne pas programmer dans le passé.
    this.nextNoteTime = this.engine.ctx.currentTime + 0.05;
    this.worker.postMessage('start');
    this.state.set('transport.playing', true);
  }

  /** Arrête la lecture. */
  stop() {
    this.isRunning = false;
    this.worker.postMessage('stop');
    this.state.set('transport.playing', false);
  }
}
