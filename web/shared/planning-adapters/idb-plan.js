// @ts-check
'use strict';

const DB_NAME = 'flytab-plans';
const DB_VER  = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('flight_plans'))
                db.createObjectStore('flight_plans', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('aircraft_profiles'))
                db.createObjectStore('aircraft_profiles', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta'))
                db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

export class IdbPlanStore {
    async _store(mode = 'readwrite') {
        const db = await openDb();
        return db.transaction(['flight_plans'], mode).objectStore('flight_plans');
    }

    async get(id) {
        const s = await this._store('readonly');
        return new Promise(r => { const q = s.get(id); q.onsuccess = () => r(q.result || null); });
    }

    async put(plan) {
        if (!plan.id) plan.id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const s = await this._store();
        return new Promise((res, rej) => { const q = s.put(plan); q.onsuccess = () => res(plan.id); q.onerror = () => rej(q.error); });
    }

    async list() {
        const s = await this._store('readonly');
        return new Promise(r => { const q = s.getAll(); q.onsuccess = () => r(q.result || []); });
    }

    async delete(id) {
        const s = await this._store();
        return new Promise(r => { s.delete(id).onsuccess = () => r(); });
    }
}
