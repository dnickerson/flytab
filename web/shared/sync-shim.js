/**
 * FlyTab — SyncManager shim
 * Provides PI_BASE for modules that reference SyncManager.PI_BASE.
 * In FlyTab, this points at the home server (configurable) instead of flypi.local.
 * Modules gradually migrate away from SyncManager; this shim prevents errors.
 */
const SyncManager = {
    get PI_BASE() {
        const hs = (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.homeServer) || {};
        // Derive base URL from tileBase (strip /tiles suffix)
        if (hs.tileBase) return hs.tileBase.replace(/\/tiles\/?$/, '');
        return 'http://192.168.1.77:8090';
    }
};
