package app.flywhere.flytab;

import android.content.pm.PackageManager;

/** Pure decisions for VpnStatusPlugin, kept free of Android services so JUnit can cover them. */
final class VpnStatusLogic {
    private VpnStatusLogic() {}

    /**
     * Apps the WebView may ask about or open. The JS side passes a package name;
     * anything not listed here is refused, so a page can't use the plugin to probe
     * for or launch arbitrary apps. Each entry also needs a <queries> entry in
     * AndroidManifest.xml (Android 11+ package visibility).
     */
    static boolean isAllowed(String pkg) {
        return "com.expressvpn.vpn".equals(pkg);
    }

    /** PackageManager.getApplicationEnabledSetting() -> can the app run? */
    static boolean isEnabled(int enabledSetting) {
        return enabledSetting == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
            || enabledSetting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }
}
