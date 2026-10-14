package app.flywhere.flytab;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Is a VPN up, and can the pilot open the VPN app to stop it?
 *
 * 2026-10-13: ExpressVPN on the cockpit tablet re-pointed its tunnel every
 * ~47.5 s on the Stratux Wi-Fi (no internet), breaking every Stratux connection
 * each time. Android won't let one app stop another app's VPN, so FlyTab shows
 * the state on the checklist and opens the VPN app for the pilot.
 *
 * Android reports THAT a VPN network exists (TRANSPORT_VPN), not which app owns
 * it, so vpnActive means "some VPN is up".
 *
 * JS API:
 *   VpnStatus.status({ package })  -> { vpnActive, installed, enabled }
 *   VpnStatus.openApp({ package }) -> resolves once the app is launched
 * Only packages allowed by VpnStatusLogic.isAllowed() are accepted.
 */
@CapacitorPlugin(name = "VpnStatus")
public class VpnStatusPlugin extends Plugin {
    private static final String TAG = "VpnStatus";

    @PluginMethod
    public void status(PluginCall call) {
        String pkg = call.getString("package");
        if (!VpnStatusLogic.isAllowed(pkg)) { call.reject("package not allowed"); return; }

        JSObject ret = new JSObject();
        ret.put("vpnActive", vpnActive());

        PackageManager pm = getContext().getPackageManager();
        boolean installed = false, enabled = false;
        try {
            // Throws IllegalArgumentException for a package that isn't installed
            // (or isn't visible -- hence the <queries> entry in the manifest).
            enabled = VpnStatusLogic.isEnabled(pm.getApplicationEnabledSetting(pkg));
            installed = true;
        } catch (IllegalArgumentException e) {
            // not installed
        }
        ret.put("installed", installed);
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String pkg = call.getString("package");
        if (!VpnStatusLogic.isAllowed(pkg)) { call.reject("package not allowed"); return; }
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) { call.reject("app not installed or disabled"); return; }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(launch);
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "openApp failed: " + e);
            call.reject("could not open app: " + e.getMessage());
        }
    }

    /** Any VPN network: the app's own default network, or any other network the system lists. */
    private boolean vpnActive() {
        ConnectivityManager cm = getContext().getSystemService(ConnectivityManager.class);
        if (cm == null) return false;
        if (isVpn(cm, cm.getActiveNetwork())) return true;
        // getAllNetworks() is deprecated (API 31) but still returned; it also catches a
        // VPN that FlyTab itself is excluded from (split tunnelling).
        for (Network n : cm.getAllNetworks()) {
            if (isVpn(cm, n)) return true;
        }
        return false;
    }

    private static boolean isVpn(ConnectivityManager cm, Network n) {
        if (n == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }
}
