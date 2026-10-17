/**
 * FAA data currency on the tablet -- offline, from what the tablet itself
 * recorded at sync (round 2 review, 2026-10-17: in flight nothing said plates,
 * procedures or A/FD had expired; Data Status showed CURRENT, the status-bar
 * badge covered NASR only and read "0d" all of expiry day).
 *
 * Products: nasr (IndexedDB cycle info), cifp, plates, afd (device manifest
 * 'flytab_device_manifest', written by DataStatus at sync). FAA data changes
 * at 0901Z on the effective date, so that is when a product expires.
 */
const FaaCurrency = {
    LABELS: { nasr: 'NASR', cifp: 'CIFP', plates: 'PLATES', afd: 'A/FD' },
    EXPIRING_DAYS: 7,

    /** ms when data with this expiration date ("2026-10-29") stops being current. */
    expiresAt(expiration) {
        if (!expiration) return null;
        const t = Date.parse(String(expiration).includes('T') ? expiration : `${expiration}T09:01:00Z`);
        return Number.isFinite(t) ? t : null;
    },

    /** { state: current|expiring|expired|unknown, daysLeft, expiresAt } */
    status(expiration, now = Date.now()) {
        const expiresAt = this.expiresAt(expiration);
        if (expiresAt === null) return { state: 'unknown', daysLeft: null, expiresAt: null };
        const ms = expiresAt - now;
        if (ms <= 0) return { state: 'expired', daysLeft: Math.floor(ms / 86400000), expiresAt };
        const daysLeft = Math.floor(ms / 86400000);
        return { state: daysLeft < this.EXPIRING_DAYS ? 'expiring' : 'current', daysLeft, expiresAt };
    },

    /** The device manifest DataStatus writes at sync. */
    deviceManifest() {
        try { return JSON.parse(localStorage.getItem('flytab_device_manifest') || '{}') || {}; }
        catch { return {}; }
    },

    /**
     * Each product's currency: [{ key, label, cycle, expiration, state,
     * daysLeft, failedStates? }]. A/FD marked not current at sync is 'stale'.
     */
    products(device, nasrInfo, now = Date.now()) {
        device = device || {};
        const row = (key, cycle, expiration, extra = {}) => ({
            key, label: this.LABELS[key], cycle: cycle || null, expiration: expiration || null,
            ...this.status(expiration, now), ...extra,
        });
        const nasr = row('nasr', nasrInfo?.effective_date, nasrInfo?.expiration_date);
        const cifp = row('cifp', device.cifp?.cycle_code, device.cifp?.expiration_date);
        const plates = row('plates', device.plates?.cycle_code, device.plates?.expiration_date,
            { failedStates: device.plates?.failed_states || [] });
        const afd = row('afd', device.afd?.edition, device.afd?.expiration_date);
        if (device.afd?.stale && afd.state !== 'expired') afd.state = 'stale';
        if (plates.failedStates.length && plates.state !== 'expired') plates.state = 'stale';
        return [nasr, cifp, plates, afd];
    },

    RANK: { expired: 4, unknown: 3, stale: 2, expiring: 1, current: 0 },

    /** The status-bar badge: the most urgent product, else "FAA <days>d". */
    badge(products) {
        const worst = [...products].sort((a, b) => this.RANK[b.state] - this.RANK[a.state])[0];
        if (!worst) return { text: 'FAA ??', cls: 'nasr-expired' };
        switch (worst.state) {
            case 'expired': return { text: `${worst.label} EXP`, cls: 'nasr-expired' };
            case 'unknown': return { text: `${worst.label} ??`, cls: 'nasr-expired' };
            case 'stale': return { text: `${worst.label} OLD`, cls: 'nasr-aging' };
            case 'expiring': return { text: `${worst.label} ${worst.daysLeft}d`, cls: 'nasr-aging' };
            default: {
                const days = Math.min(...products.map((p) => p.daysLeft));
                return { text: `FAA ${days}d`, cls: 'nasr-fresh' };
            }
        }
    },

    /** "Cycle 261001 · expires 29 OCT 2026" / "EXPIRED 29 OCT 2026" -- for viewers. */
    describe(p) {
        const d = p.expiration ? new Date(this.expiresAt(p.expiration)).toISOString().slice(0, 10) : null;
        const when = d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase() : '?';
        const cyc = p.cycle ? `Cycle ${p.cycle} · ` : '';
        if (p.state === 'expired') return `${cyc}EXPIRED ${when}`;
        if (p.state === 'unknown') return `${p.label} currency unknown — sync in MORE → Data Status`;
        return `${cyc}expires ${when}`;
    },
};

if (typeof window !== 'undefined') window.FaaCurrency = FaaCurrency;
