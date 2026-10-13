package app.flywhere.flytab;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageManager;

import org.junit.Test;

public class VpnStatusLogicTest {

    @Test
    public void onlyExpressVpnIsAllowed() {
        assertTrue(VpnStatusLogic.isAllowed("com.expressvpn.vpn"));
        assertFalse(VpnStatusLogic.isAllowed("com.android.settings"));
        assertFalse(VpnStatusLogic.isAllowed(""));
        assertFalse(VpnStatusLogic.isAllowed(null));
    }

    @Test
    public void enabledStateMapping() {
        // DEFAULT means "as the manifest says" -- an installed app is enabled unless
        // its manifest says otherwise, which a launchable VPN app's doesn't.
        assertTrue(VpnStatusLogic.isEnabled(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT));
        assertTrue(VpnStatusLogic.isEnabled(PackageManager.COMPONENT_ENABLED_STATE_ENABLED));
        assertFalse(VpnStatusLogic.isEnabled(PackageManager.COMPONENT_ENABLED_STATE_DISABLED));
        // 3 = what `pm disable-user` set on the tablet on 2026-10-13
        assertFalse(VpnStatusLogic.isEnabled(PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER));
        assertFalse(VpnStatusLogic.isEnabled(PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED));
    }
}
