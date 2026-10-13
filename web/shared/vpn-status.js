/**
 * FlyTab — VPN status for the checklist (native VpnStatus plugin, VpnStatusPlugin.java).
 *
 * 2026-10-13: ExpressVPN on the cockpit tablet re-pointed its tunnel every ~47.5 s
 * on the Stratux Wi-Fi and broke every Stratux connection each time. Android
 * won't let FlyTab stop another app's VPN, so the checklist shows whether a VPN
 * is up and opens the VPN app for the pilot.
 *
 * Android says THAT a VPN is up, not which app owns it, so every VPN item reads
 * "A VPN IS ON" while any VPN is connected.
 */
const VpnStatus = {
    /** Packages the checklist may query/open. Must match VpnStatusLogic.isAllowed()
     *  and the <queries> list in AndroidManifest.xml. */
    ALLOWED_APPS: ['com.expressvpn.vpn', 'com.tailscale.ipn'],

    _plugin() {
        return (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.VpnStatus) || null;
    },

    /** { vpnActive, installed, enabled }, or null if it can't be checked. */
    async query(pkg) {
        const plugin = this._plugin();
        if (!plugin || !this.ALLOWED_APPS.includes(pkg)) return null;
        try { return await plugin.status({ package: pkg }); }
        catch { return null; }
    },

    /** Open the VPN app so the pilot can disconnect it. True if it launched. */
    async open(pkg) {
        const plugin = this._plugin();
        if (!plugin || !this.ALLOWED_APPS.includes(pkg)) return false;
        try { await plugin.openApp({ package: pkg }); return true; }
        catch { return false; }
    },

    /**
     * What the checklist item shows. state: 'bad' | 'ok' | 'unknown'.
     * canOpen: the app can be launched (installed and enabled).
     */
    describe(st) {
        if (!st) return { text: 'UNKNOWN', state: 'unknown', canOpen: false };
        const canOpen = !!(st.installed && st.enabled);
        // Android doesn't say WHICH app owns the VPN, so say "a VPN", not this app.
        if (st.vpnActive) return { text: 'A VPN IS ON ✗', state: 'bad', canOpen };
        if (!st.installed) return { text: 'NOT INSTALLED ✓', state: 'ok', canOpen: false };
        if (!st.enabled) return { text: 'DISABLED ✓', state: 'ok', canOpen: false };
        return { text: 'OFF ✓', state: 'ok', canOpen: true };
    },
};
