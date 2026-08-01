// @ts-check
'use strict';

const DB_NAME = 'flytab-plans';
const DB_VER  = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('aircraft_profiles'))
                db.createObjectStore('aircraft_profiles', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('flight_plans'))
                db.createObjectStore('flight_plans', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta'))
                db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

/**
 * Seed profile for N194JT, persisted into IndexedDB the first time the store is
 * read and re-applied by the migration check in getActive().
 *
 * SEED VALUES MUST MATCH `web/aircraft-config.json` `performance.*` — there is
 * currently NO automatic config→profile sync (verified 2026-07-31: the only
 * aircraft-config writer is app.js `_syncAircraftToPi()`, which writes
 * localStorage + CockpitConfig and never touches the `aircraft_profiles` object
 * store). Until that sync exists, changing a value here also requires changing
 * `aircraft-config.json`, and vice versa. `route-planner.js`'s `RV9A_FALLBACK`
 * is a third copy that must be kept in lockstep with this one.
 *
 * Fuel figures are MEASURED, not book values. All three are the p85 of EDM fuel
 * flow over 53 phase-labelled flight logs, selected by the recorder's `ml_phase`
 * column:
 *  - climb 15 gph    (n=9,642,  p85 15.1)
 *  - descent 6.9 gph (n=11,819, p85 6.9)
 *  - cruise 8.4 gph  — cruise rows binned by recorded %power, 65-69% band:
 *    n=7,879, median 8.10, p85 8.40.
 *  - p85 (not median) is deliberate: planning must over-estimate burn, because
 *    under-estimating burn over-states fuel remaining.
 *
 * CRUISE IS 8.4, NOT 8.1 — DO NOT "CORRECT" IT BACK to the `power_settings[]`
 * 61-65 band value. Dana's decision, 2026-07-31, direct instruction: "use 8.4
 * for the cruise gal/hr"; it supersedes commit 96d62f3, which had recorded the
 * opposite. `~/engine_analysis/build_power_curve.py:352` writes
 * `"gph": round(gph_med, 1)`, so every band `gph` in aircraft-config.json is a
 * MEDIAN — 8.1 was the median of the 65% cruise distribution, exactly the
 * statistic the "plan more consumption rather than less" principle excludes.
 * The band table still reads 8.1 on purpose: it is measured median data and
 * must not be edited to match this constant.
 */
const RV9A_DEFAULT = {
    id: 'rv9a-default',
    tailNumber: 'N194JT',
    model: 'RV-9A',
    cruise_ktas: 153,
    cruise_ias: 140,
    fuel_burn_gph: 8.4,       // p85 of 65% cruise — see header note; NOT the 8.1 band median
    fuel_capacity_gal: 36,
    reserve_gal: 10,          // must match aircraft-config.json performance.reserve_gal
    climb_rate_fpm: 1500,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 0.33,
    max_hp: 180,
    alt_power_loss_pct_per_kft: 3.0,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
    fuelPhases: {
        climb:   { gph: 15,  ias_kt: 120, rate_fpm: 1500, percent_power: 100,
                   mixture: 'FULL_RICH', rpm: 2700, mp: 28 },
        // 8.4 = p85 of the 65-69% cruise band (n=7,879; median 8.10, p85 8.40).
        // NOT the 8.1 `power_settings[]` band value, which is a MEDIAN.
        cruise:  { gph: 8.4, ias_kt: 140, percent_power: 65,
                   mixture: 'LOP', rpm: 2400, mp: 22 },
        // 6.9 = measured p85, NOT the old 4.0 book guess. 4.0 under-planned
        // descent burn by ~2.9 gph and therefore over-stated fuel remaining.
        descent: { gph: 6.9, ias_kt: 170, rate_fpm: 700, percent_power: 50,
                   mixture: 'LOP', rpm: 2400, mp: 14 },
    },
};

export class IdbProfileStore {
    async _store(name, mode = 'readwrite') {
        const db = await openDb();
        return db.transaction([name], mode).objectStore(name);
    }

    async get(id) {
        const s = await this._store('aircraft_profiles', 'readonly');
        return new Promise(r => { const q = s.get(id); q.onsuccess = () => r(q.result || null); });
    }

    async put(p) {
        if (!p.id) p.id = `prof-${Date.now()}`;
        const s = await this._store('aircraft_profiles');
        return new Promise(res => { const q = s.put(p); q.onsuccess = () => res(p.id); });
    }

    async list() {
        const s = await this._store('aircraft_profiles', 'readonly');
        return new Promise(r => { const q = s.getAll(); q.onsuccess = () => r(q.result || []); });
    }

    /** Return the active profile, seeding the RV-9A default if the store is empty. */
    async getActive() {
        const all = await this.list();
        if (all.length === 0) {
            await this.put(RV9A_DEFAULT);
            await this._setActiveId(RV9A_DEFAULT.id);
            return RV9A_DEFAULT;
        }
        // Migrate rv9a-default: overwrite stale profiles with correct values.
        //
        // EVERY fuel-planning field must be compared here. A tablet that has
        // already seeded `rv9a-default` never re-reads the literal above, so a
        // field missing from this list silently keeps its old value forever —
        // and for a burn rate or a reserve, "old value" means the app plans
        // LESS fuel than the current constants say and over-states fuel
        // remaining. `cruise.gph`, `climb.gph`, `fuel_burn_gph` and
        // `reserve_gal` were all unprotected until 2026-07-31 (found when
        // cruise moved 8.1 -> 8.4 and would not have reached seeded tablets).
        const rv9a = all.find(p => p.id === 'rv9a-default');
        if (rv9a && (rv9a.climb_rate_fpm !== RV9A_DEFAULT.climb_rate_fpm ||
                     rv9a.taxi_burn_gal  !== RV9A_DEFAULT.taxi_burn_gal  ||
                     rv9a.fuel_burn_gph  !== RV9A_DEFAULT.fuel_burn_gph  ||
                     rv9a.reserve_gal    !== RV9A_DEFAULT.reserve_gal    ||
                     rv9a.fuelPhases?.climb?.rate_fpm !== RV9A_DEFAULT.fuelPhases.climb.rate_fpm ||
                     rv9a.fuelPhases?.climb?.gph      !== RV9A_DEFAULT.fuelPhases.climb.gph ||
                     rv9a.fuelPhases?.cruise?.gph     !== RV9A_DEFAULT.fuelPhases.cruise.gph ||
                     rv9a.fuelPhases?.descent?.gph    !== RV9A_DEFAULT.fuelPhases.descent.gph)) {
            const migrated = { ...RV9A_DEFAULT, id: 'rv9a-default' };
            await this.put(migrated);
            const idx = all.indexOf(rv9a);
            all[idx] = migrated;
        }
        const meta = await this._getActiveId();
        if (meta && all.find(p => p.id === meta)) return all.find(p => p.id === meta);
        return all[0];
    }

    async _getActiveId() {
        const s = await this._store('meta', 'readonly');
        return new Promise(r => { const q = s.get('active_profile_id'); q.onsuccess = () => r(q.result?.value || null); });
    }
    async _setActiveId(id) {
        const s = await this._store('meta');
        return new Promise(r => { const q = s.put({ key: 'active_profile_id', value: id }); q.onsuccess = () => r(); });
    }
}
