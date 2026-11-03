/**
 * FlyTab — Airport notes
 *
 * The pilot's own notes for an airport (e.g. a private strip's prescribed
 * arrival / departure), shown as MY NOTES at the bottom of the airport panel's INFO tab. One UTF-8 text
 * file per airport, Documents/FlyTab/notes/<ID>.txt, read and written through the
 * on-tablet file server (TileServer: GET / PUT / DELETE /notes/<ID>.txt), so the
 * notes survive Clear Data and reinstall. Flight Upload copies them home.
 *
 * Data safety rules (a pilot's note must never be lost):
 *  - The ID is checked (^[A-Z0-9]{2,7}$ after upper-casing) before any URL is built.
 *  - The box is read-only until the note was read (200) or confirmed absent (404).
 *    Any other answer -- 503 storage-permission (TileServer cannot read shared
 *    storage, e.g. "All files access" lost on reinstall), another error, or no
 *    answer -- locks it with a message: an empty box can never be saved over a
 *    note that is only hidden.
 *  - Reads and writes for one airport run one at a time (AirportNotes._enqueue);
 *    a write sends the latest text when it starts, so the latest text wins.
 *  - A failed write shows an error and keeps the text; it is retried on the next
 *    change, tab tap or close. If it fails after the panel closed, a toast
 *    says so and the text comes back when the airport is reopened (_unsaved).
 *  - Text goes into the page only as textarea.value / textContent.
 */

class AirportNotes {
    static BASE = 'http://localhost:9090/notes';
    static ID_RE = /^[A-Z0-9]{2,7}$/;
    /** id -> tail of that airport's queue of reads / writes */
    static _chains = new Map();
    /** id -> text whose save failed after its panel closed (offered again on reopen) */
    static _unsaved = new Map();

    /** The airport ID used for the file name, or null when notes are not possible for it. */
    static normId(raw) {
        if (typeof raw !== 'string') return null;
        const id = raw.toUpperCase();
        return AirportNotes.ID_RE.test(id) ? id : null;
    }

    static _url(id) {
        return `${AirportNotes.BASE}/${id}.txt`;
    }

    /** Run fn after every earlier read / write of this airport has finished. */
    static _enqueue(id, fn) {
        const prev = AirportNotes._chains.get(id) || Promise.resolve();
        const run = prev.then(fn);
        const tail = run.catch(() => {});
        AirportNotes._chains.set(id, tail);
        tail.then(() => { if (AirportNotes._chains.get(id) === tail) AirportNotes._chains.delete(id); });
        return run;
    }

    static async _bodyText(r) {
        try { return String(await r.text()).slice(0, 200); } catch (_) { return ''; }
    }

    /**
     * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
     * ok only for 200 (the note) and 404 (no note: '').
     */
    static read(rawId) {
        const id = AirportNotes.normId(rawId);
        if (!id) return Promise.resolve({ ok: false, error: 'Notes not available for this airport.' });
        return AirportNotes._enqueue(id, async () => {
            let r;
            try {
                r = await fetch(AirportNotes._url(id), { cache: 'no-store' });
            } catch (_) {
                return { ok: false, error: "Notes can't be read — FlyTab's file server is not answering. Reopen this airport to try again." };
            }
            if (r.status === 404) return { ok: true, text: '' };
            if (r.ok) {
                try {
                    return { ok: true, text: String(await r.text()) };
                } catch (_) {
                    return { ok: false, error: "Notes can't be read — the file could not be loaded." };
                }
            }
            const body = await AirportNotes._bodyText(r);
            if (r.status === 503 && body.includes('storage-permission')) {
                return { ok: false, error: "Notes can't be read — storage permission needed. Restart FlyTab, tap OK on Storage Access Required and allow management of all files, then reopen this airport." };
            }
            return { ok: false, error: `Notes can't be read (HTTP ${r.status}${body ? ': ' + body : ''}).` };
        });
    }

    /**
     * Save text as the airport's note; blank text deletes the file.
     * @param {string} rawId
     * @param {string|function(): string} text  a function is called when the write starts (latest text)
     * @returns {Promise<{ok: true, text: string} | {ok: false, error: string, text: string}>}
     */
    static write(rawId, text) {
        const id = AirportNotes.normId(rawId);
        if (!id) return Promise.resolve({ ok: false, error: 'Notes not available for this airport.', text: '' });
        return AirportNotes._enqueue(id, async () => {
            const t = String(typeof text === 'function' ? text() : text);
            const del = t.trim() === '';
            try {
                const r = await fetch(AirportNotes._url(id), del
                    ? { method: 'DELETE' }
                    : { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: t });
                if (r.ok || (del && r.status === 404)) return { ok: true, text: t };
                const body = await AirportNotes._bodyText(r);
                if (r.status === 503 && body.includes('storage-permission')) {
                    return { ok: false, text: t, error: 'Not saved — storage permission needed.' };
                }
                return { ok: false, text: t, error: `Not saved (HTTP ${r.status}${body ? ': ' + body : ''}).` };
            } catch (_) {
                return { ok: false, text: t, error: "Not saved — FlyTab's file server is not answering." };
            }
        });
    }
}

/**
 * One airport's notes box: load, autosave (debounced), flush, detach.
 * States: 'loading' (read-only) -> 'ready' (editable) | 'locked' (read failed, read-only for good).
 */
class AirportNoteEditor {
    static DEBOUNCE_MS = 1000;
    /**
     * id -> the running save loop of an editor for that airport. A new box for the
     * same airport (panel replaced by the same airport, or reopened) waits for it
     * before reading: otherwise its read could be queued between two writes of the
     * old box, show stale text, and its next save would overwrite the newer note.
     */
    static _loops = new Map();

    /**
     * @param {string} id  a valid AirportNotes ID
     * @param {HTMLTextAreaElement} textarea
     * @param {HTMLElement} statusEl
     */
    constructor(id, textarea, statusEl) {
        this.id = id;
        this._ta = textarea;
        this._statusEl = statusEl;
        this._state = 'loading';
        this._saved = '';       // text known to be on disk
        this._desired = '';     // text in the box
        this._timer = null;
        this._saving = null;    // promise of the running save loop
        this._detached = false;

        this._ta.readOnly = true;
        this._onInput = () => {
            if (this._state !== 'ready') return;          // never before (or without) a good read
            this._desired = this._ta.value;
            clearTimeout(this._timer);
            this._timer = setTimeout(() => { this._timer = null; this._save(); }, AirportNoteEditor.DEBOUNCE_MS);
        };
        this._onBlur = () => { this.flush(); };
        this._onHidden = () => { if (document.visibilityState === 'hidden') this.flush(); };
        this._ta.addEventListener('input', this._onInput);
        this._ta.addEventListener('blur', this._onBlur);
        document.addEventListener('visibilitychange', this._onHidden);
    }

    get state() { return this._state; }

    _status(text, isError = false) {
        if (this._detached) return;
        this._statusEl.textContent = text;
        this._statusEl.classList.toggle('is-error', !!isError);
    }

    async load() {
        this._status('Loading…');
        // Let an earlier box's save loop for this airport finish first (its last
        // write, or its failure parked in _unsaved, must be what this box starts from).
        let loop;
        while ((loop = AirportNoteEditor._loops.get(this.id))) {
            await loop.catch(() => {});
            if (AirportNoteEditor._loops.get(this.id) === loop) AirportNoteEditor._loops.delete(this.id);
        }
        const res = await AirportNotes.read(this.id);
        if (this._state !== 'loading') return;
        if (!res.ok) {
            this._state = 'locked';
            this._ta.readOnly = true;
            this._ta.placeholder = '';
            this._status(res.error, true);
            return;
        }
        this._saved = res.text;
        // Text whose save failed after an earlier panel closed: offer it again (and save it).
        const pending = AirportNotes._unsaved.get(this.id);
        this._desired = (pending != null) ? pending : res.text;
        this._ta.value = this._desired;
        this._state = 'ready';
        if (this._detached) return;          // closed while loading: keep nothing editable
        this._ta.readOnly = false;
        if (this._desired !== this._saved) {
            this._status('Unsaved changes from earlier — saving…');
            this._save();
        } else {
            AirportNotes._unsaved.delete(this.id);
            this._status('');
        }
    }

    /** Save now if the box differs from what is on disk. Resolves when done (or failed). */
    flush() {
        clearTimeout(this._timer);
        this._timer = null;
        return this._save();
    }

    /** The panel is going away (closed / replaced): save what is pending, stop listening. */
    detach() {
        const p = this.flush();
        this._detached = true;
        this._ta.removeEventListener('input', this._onInput);
        this._ta.removeEventListener('blur', this._onBlur);
        document.removeEventListener('visibilitychange', this._onHidden);
        return p;
    }

    _save() {
        if (this._state !== 'ready') return Promise.resolve();
        if (this._saving) return this._saving;              // the running loop picks up the latest text
        if (this._desired === this._saved) return Promise.resolve();
        const loop = (async () => {
            try {
                while (this._desired !== this._saved) {
                    this._status('Saving…');
                    const res = await AirportNotes.write(this.id, () => this._desired);
                    if (!res.ok) {
                        this._failed(res.error);
                        return;
                    }
                    this._saved = res.text;
                }
                AirportNotes._unsaved.delete(this.id);
                this._status('Saved');
            } finally {
                this._saving = null;
                if (AirportNoteEditor._loops.get(this.id) === loop) AirportNoteEditor._loops.delete(this.id);
            }
        })();
        this._saving = loop;
        AirportNoteEditor._loops.set(this.id, loop);
        return loop;
    }

    _failed(error) {
        if (!this._detached) {
            this._status(`${error} Your text is kept here; it will be saved on the next change or when you close.`, true);
            return;
        }
        // The panel is gone: keep the text for the next open of this airport, and say so.
        AirportNotes._unsaved.set(this.id, this._desired);
        try {
            window.app?.showToast?.(`Note for ${this.id} NOT saved: ${error} Reopen ${this.id} → INFO → MY NOTES to retry.`, null, 8000);
        } catch (_) { /* never throw out of a save */ }
    }
}
