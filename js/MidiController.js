/* =====================================================================
   MidiController.js — Web MIDI API.
   Écoute les contrôleurs entrants (navigator.requestMIDIAccess) et mappe
   les messages Control Change (CC) aux knobs virtuels via un mode
   "MIDI Learn".
   ===================================================================== */

export class MidiController {
  /**
   * @param {(status:string)=>void} onStatus - mise à jour de l'indicateur UI
   */
  constructor(onStatus) {
    this.onStatus = onStatus;
    /** @type {Map<number, (val01:number)=>void>} cc -> setter normalisé */
    this.bindings = new Map();
    /** Cible en attente d'apprentissage : { setter } */
    this._learnTarget = null;
    this.access = null;
  }

  /** Demande l'accès MIDI et attache les écouteurs. */
  async init() {
    if (!navigator.requestMIDIAccess) {
      this.onStatus?.('MIDI: non supporté');
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this._bindInputs();
      this.access.onstatechange = () => this._bindInputs();
      const count = this.access.inputs.size;
      this.onStatus?.(count ? `MIDI: ${count} entrée(s)` : 'MIDI: aucun device');
    } catch (e) {
      this.onStatus?.('MIDI: refusé');
    }
  }

  _bindInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (msg) => this._onMessage(msg);
    }
  }

  /**
   * Démarre l'apprentissage : le prochain CC reçu sera lié à `setter`.
   * @param {(val01:number)=>void} setter
   */
  learn(setter) { this._learnTarget = setter; }

  /** Annule un apprentissage en cours. */
  cancelLearn() { this._learnTarget = null; }

  /**
   * Décodage du message MIDI brut.
   * @param {MIDIMessageEvent} msg
   */
  _onMessage(msg) {
    const [status, data1, data2] = msg.data;
    const command = status & 0xf0;

    // 0xB0 = Control Change.
    if (command === 0xb0) {
      const cc = data1;
      const val01 = data2 / 127; // normalisé 0..1

      if (this._learnTarget) {
        this.bindings.set(cc, this._learnTarget);
        this._learnTarget = null;
        this.onStatus?.(`MIDI: CC${cc} mappé`);
        return;
      }
      const setter = this.bindings.get(cc);
      if (setter) setter(val01);
    }
  }
}
