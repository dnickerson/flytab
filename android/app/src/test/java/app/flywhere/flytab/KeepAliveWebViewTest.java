package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The WebView's Context hides the autofill service only (LastPass took the
 * keyboard, Dana 2026-10-17); every other service is passed through.
 */
public class KeepAliveWebViewTest {
    @Test
    public void hidesOnlyTheAutofillService() {
        assertEquals("autofill", KeepAliveWebView.HIDDEN_SERVICE);   // Context.AUTOFILL_MANAGER_SERVICE
        assertTrue(KeepAliveWebView.hides("autofill"));
        for (String s : new String[]{"input_method", "layout_inflater", "window", "clipboard", "accessibility", null}) {
            assertFalse(String.valueOf(s), KeepAliveWebView.hides(s));
        }
    }
}
