package app.flywhere.flytab;

import android.content.Context;
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
 */
public class KeepAliveWebView extends CapacitorWebView {
    public KeepAliveWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
