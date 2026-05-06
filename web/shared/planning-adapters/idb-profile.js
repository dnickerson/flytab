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

const RV9A_DEFAULT = {
    id: 'rv9a-default',
    tailNumber: 'N194JT',
    model: 'RV-9A',
    cruise_ktas: 155,
    fuel_burn_gph: 8.0,
    fuel_capacity_gal: 36,
    reserve_gal: 10,
    climb_rate_fpm: 750,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
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
