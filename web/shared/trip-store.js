'use strict';

const TripStore = (() => {
    const DB_NAME = 'flypi-flights';
    const DB_VERSION = 5;
    const STORE = 'trips';

    let _db = null;
    let _ready = null;

    function _open() {
        if (_ready) return _ready;
        _ready = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('created_at', 'created_at', { unique: false });
                }
            };
            req.onsuccess = () => { _db = req.result; resolve(_db); };
            req.onerror = () => reject(req.error);
        });
        return _ready;
    }

    async function save(trip) {
        const db = await _open();
        trip.updated_at = new Date().toISOString();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(trip);
            tx.oncomplete = () => resolve(trip);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function list() {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const index = tx.objectStore(STORE).index('created_at');
            const req = index.getAll();
            req.onsuccess = () => resolve((req.result || []).reverse());
            req.onerror = () => reject(req.error);
        });
    }

    async function get(id) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function del(id) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function rename(id, name) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.get(id);
            req.onsuccess = () => {
                const trip = req.result;
                if (!trip) { reject(new Error('Trip not found')); return; }
                trip.name = name;
                trip.updated_at = new Date().toISOString();
                store.put(trip);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    return { save, list, get, delete: del, rename };
})();
