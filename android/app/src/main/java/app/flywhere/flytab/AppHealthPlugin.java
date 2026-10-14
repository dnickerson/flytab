package app.flywhere.flytab;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the web app what the page itself can't know: whether FlyTab is on
 * screen, and what happened to the previous WebView.
 *
 * JS API:
 *   AppHealth.isOnScreen() -> { onScreen }  (MainActivity between onStart and onStop;
 *     the page can't tell: KeepAliveWebView keeps it "visible". Changes arrive as
 *     the window event 'flytab:screen' { onScreen }.)
 *   AppHealth.takeRendererEvents() -> { events: [{ at, didCrash, priority, action }] }
 *     Renderer deaths recorded by MainActivity.handleRendererGone since the last
 *     call (oldest first), then cleared. action: RESTART | CLOSE_IN_BACKGROUND | GIVE_UP.
 */
@CapacitorPlugin(name = "AppHealth")
public class AppHealthPlugin extends Plugin {

    @PluginMethod
    public void isOnScreen(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("onScreen", MainActivity.isOnScreen());
        call.resolve(ret);
    }

    @PluginMethod
    public void takeRendererEvents(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(RendererRecoveryLogic.PREFS, Context.MODE_PRIVATE);
        String pending = prefs.getString(RendererRecoveryLogic.KEY_PENDING, "");
        prefs.edit().remove(RendererRecoveryLogic.KEY_PENDING).apply();

        JSArray events = new JSArray();
        if (pending != null && !pending.isEmpty()) {
            for (String line : pending.split("\n")) {
                String[] f = line.split(",");
                if (f.length != 4) continue;
                try {
                    JSObject e = new JSObject();
                    e.put("at", Long.parseLong(f[0]));
                    e.put("didCrash", "1".equals(f[1]));
                    e.put("priority", Integer.parseInt(f[2]));
                    e.put("action", f[3]);
                    events.put(e);
                } catch (NumberFormatException ignored) {
                    // skip a damaged line
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", events);
        call.resolve(ret);
    }
}
