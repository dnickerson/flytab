package app.flywhere.flytab;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.AttributeSet;
import android.view.View;

import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView, except that Chromium is always told its window is visible.
 *
 * Measured on the tablet (2026-10-14, WebView 155): about 30-40 s after FlyTab
 * was hidden (screen off or another app in front), Chromium froze the page
 * (document 'freeze' event) and no JavaScript ran until FlyTab was shown again:
 * no engine alerts, no flight recording, no traffic. Android itself kept the
 * renderer running (perceptible, not frozen), so this is Chromium's own page
 * freezing, triggered by the window becoming invisible. Reporting VISIBLE
 * keeps the page running: 3 min with the screen off, a 1 s timer never missed.
 * FlightService keeps the CPU awake for this.
 *
 * Side effect: document.visibilityState is always 'visible'. FlyTab's real
 * on-screen state comes from MainActivity ('flytab:screen' event,
 * AppHealth.isOnScreen). Used via res/layout/capacitor_bridge_layout_main.xml,
 * which overrides Capacitor's layout of the same name.
 *
 * Also: no Android autofill. The autofill service (LastPass on this tablet)
 * opened its suggestion window on the first character typed in the route
 * planner's search box; that window took the input focus and the keyboard
 * closed (logcat "setInputFocusLw : Window{... Autofill UI}", Dana
 * 2026-10-17). Neither autocomplete="off" nor the WebView's
 * importantForAutofill stops it: Chromium's AutofillProvider takes
 * AutofillManager from this view's Context (AutofillManagerWrapper:
 * context.getSystemService(AutofillManager.class)) and checks only that the
 * service is enabled. A Context that has no AutofillManager disables it
 * (isDisabled() when the manager is null) for this WebView only -- the
 * Activity's own autofill bookkeeping is untouched. Dana chose off
 * everywhere, the SFTP password prompts too.
 */
public class KeepAliveWebView extends CapacitorWebView {
    public KeepAliveWebView(Context context, AttributeSet attrs) {
        super(withoutAutofill(context), attrs);
    }

    /** The service name this WebView's Context hides. */
    static final String HIDDEN_SERVICE = "autofill";      // Context.AUTOFILL_MANAGER_SERVICE (API 26)

    static boolean hides(String serviceName) {
        return HIDDEN_SERVICE.equals(serviceName);
    }

    private static Context withoutAutofill(Context base) {
        return new ContextWrapper(base) {
            @Override
            public Object getSystemService(String name) {
                return hides(name) ? null : super.getSystemService(name);
            }
        };
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
