/**
 * FlyTab — SFTP server host-key check, shared by Flight Upload and the SFTP app update.
 *
 * SftpPlugin verifies the server's host key before sending the password or any file
 * (HostKeyStore.java). When it stops an operation it resolves
 *   { ok:false, error, hostKey:{ status:'unknown'|'changed'|'damaged', host, port, keyType,
 *     shortType, fingerprint, keyBase64 (unknown only), knownFingerprints (changed only) } }
 *
 * run(op) handles that result in one place:
 *  - unknown: shows the fingerprint and asks the pilot. On Trust, stores exactly the key
 *    that was shown (keyBase64 + fingerprint carried back from the failed attempt, not
 *    fetched again) and runs op once more. On Cancel, nothing is sent and op is not retried.
 *  - changed: refuses, no prompt. A changed key can only be forgotten from
 *    Configuration → Flight Upload (forget()).
 *  - damaged: the trusted-key file can't be read; nothing is trusted (fail closed)
 *    until Forget server key resets it.
 * Results it already explained to the pilot carry hostKeyHandled:true, so callers
 * don't toast again. Exceptions from op (e.g. "File not found") pass through.
 *
 * The dialog is built with textContent (no innerHTML for host or key data).
 */
const SftpHostKey = {
    /**
     * @param {() => Promise<object>} op  an Sftp.upload / Sftp.download call
     * @param {{action?: string}} [opts]  'Upload' or 'Download' (for messages)
     */
    async run(op, { action = 'Upload' } = {}) {
        const first = await op();
        const hk = first?.hostKey;
        if (!hk || first.ok) return first;

        if (hk.status === 'damaged') {
            this._refuseDamaged(first, action);
            return { ...first, hostKeyHandled: true };
        }
        if (hk.status !== 'unknown') {
            this._refuseChanged(hk, action);
            return { ...first, hostKeyHandled: true };
        }

        const trusted = await this.confirm(this.trustLines(hk), { okLabel: 'Trust', title: 'Verify server key' });
        if (!trusted) {
            this._log(`Server key for ${this._hostLabel(hk)} not trusted (cancelled): ${hk.fingerprint} (${hk.keyType})`);
            this._toast(`${action} cancelled: server key not trusted.`);
            return { ...first, hostKeyHandled: true, cancelled: true };
        }
        try {
            await Capacitor.Plugins.Sftp.trustHostKey({
                host: hk.host,
                port: hk.port,
                keyType: hk.keyType,
                keyBase64: hk.keyBase64,
                fingerprint: hk.fingerprint,
            });
        } catch (err) {
            this._log(`Trusting server key for ${this._hostLabel(hk)} failed: ${err?.message || err}`);
            this._toast(`Could not save the server key: ${err?.message || err}`);
            return { ...first, hostKeyHandled: true };
        }
        this._log(`Trusted server key for ${this._hostLabel(hk)}: ${hk.fingerprint} (${hk.keyType})`);

        const second = await op();                 // the one retry
        const hk2 = second?.hostKey;
        if (hk2 && !second.ok) {
            if (hk2.status === 'changed') this._refuseChanged(hk2, action);
            else if (hk2.status === 'damaged') this._refuseDamaged(second, action);
            else {
                this._log(`Server presented another unknown key after trust: ${hk2.fingerprint} (${hk2.keyType})`);
                this._toast(`${action} stopped: the server presented a different key.`);
            }
            return { ...second, hostKeyHandled: true };
        }
        return second;
    },

    /** The first-connection prompt, one string per paragraph. */
    trustLines(hk) {
        const short = hk.shortType || 'TYPE';
        return [
            `First connection to ${this._hostLabel(hk)}.`,
            `Server key fingerprint: ${hk.fingerprint} (${short.toUpperCase()}).`,
            `Check it on the server with ssh-keygen -lf /etc/ssh/ssh_host_${short}_key.pub`,
            'Trust this server?',
        ];
    },

    /** Message for a changed key (also the refusal toast). */
    changedMessage(hk, action = 'Upload') {
        return `Server key for ${hk.host} has CHANGED — possible interception. ${action} stopped.`;
    },

    /**
     * Forget the trusted key for host:port after its own confirmation.
     * Only Configuration → Flight Upload calls this, never an error path.
     * @returns {Promise<boolean>} true if the plugin was called and succeeded
     */
    async forget(host, port) {
        port = port || 22;
        const label = port === 22 ? host : `${host}:${port}`;
        const ok = await this.confirm([
            `Forget the saved server key for ${label}?`,
            'The next upload or update will show the server key fingerprint again. Only do this if you know the server key was changed on purpose (e.g. the server was reinstalled).',
        ], { okLabel: 'Forget key', title: 'Forget server key' });
        if (!ok) return false;
        try {
            const r = await Capacitor.Plugins.Sftp.forgetHostKey({ host, port });
            this._log(`Forgot ${r?.removed ?? 0} server key(s) for ${label}`);
            this._toast(r?.reset ? 'Server key store reset. The next upload shows the server key fingerprint again.'
                : r?.removed ? `Server key for ${label} forgotten.` : `No saved server key for ${label}.`);
            return true;
        } catch (err) {
            this._toast(`Could not forget the server key: ${err?.message || err}`);
            return false;
        }
    },

    /**
     * Modal with OK / Cancel. Text goes in with textContent only.
     * @returns {Promise<boolean>}
     */
    confirm(lines, { okLabel = 'OK', cancelLabel = 'Cancel', title = '' } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'shk-overlay';
            const box = document.createElement('div');
            box.className = 'shk-box';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            if (title) {
                const t = document.createElement('div');
                t.className = 'shk-title';
                t.textContent = title;
                box.appendChild(t);
            }
            for (const line of lines) {
                const p = document.createElement('p');
                p.className = /SHA256:/.test(line) || /ssh-keygen/.test(line) ? 'shk-line shk-mono' : 'shk-line';
                p.textContent = line;
                box.appendChild(p);
            }
            const row = document.createElement('div');
            row.className = 'shk-actions';
            const cancel = document.createElement('button');
            cancel.className = 'shk-btn shk-cancel';
            cancel.textContent = cancelLabel;
            const ok = document.createElement('button');
            ok.className = 'shk-btn shk-ok';
            ok.textContent = okLabel;
            row.append(cancel, ok);
            box.appendChild(row);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            let done = false;
            const finish = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
            const tap = (el, fn) => (typeof wireTap === 'function' ? wireTap(el, fn) : el.addEventListener('click', fn));
            tap(cancel, () => finish(false));
            tap(ok, () => finish(true));
        });
    },

    _refuseChanged(hk, action) {
        const known = (hk.knownFingerprints || []).join(', ') || 'none';
        this._log(`Server key CHANGED for ${this._hostLabel(hk)}: presented ${hk.fingerprint} (${hk.keyType}); trusted: ${known}. ${action} refused.`);
        this._toast(this.changedMessage(hk, action));
    },

    _refuseDamaged(result, action) {
        this._log(`${action} refused: ${result.error}`);
        this._toast(`${action} stopped: ${result.error}.`);
    },

    _hostLabel(hk) {
        return hk.port && hk.port !== 22 ? `${hk.host}:${hk.port}` : `${hk.host}`;
    },

    _log(m) {
        if (typeof DiagLog !== 'undefined') DiagLog.log('sftp', m);
    },

    /** showToast() renders the message as text. No null actions arg: it would throw. */
    _toast(m) {
        window.app?.showToast(String(m));
    },
};

if (typeof window !== 'undefined') window.SftpHostKey = SftpHostKey;
