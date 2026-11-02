package app.flywhere.flytab;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** trustHostKey may store only a key a server actually presented, once (security review 2026-11-01). */
public class PresentedKeysTest {
    private static final byte[] A = {1, 2, 3, 4};
    private static final byte[] B = {1, 2, 3, 5};

    @Test
    public void theSameBytesAreAcceptedOnce() {
        PresentedKeys p = new PresentedKeys();
        p.remember("[nas.local]:2222", A);
        assertTrue(p.consume("[nas.local]:2222", A.clone()));
        assertFalse("one use", p.consume("[nas.local]:2222", A));
    }

    @Test
    public void otherBytesAreRefusedAndUseUpTheEntry() {
        PresentedKeys p = new PresentedKeys();
        p.remember("nas.local", A);
        assertFalse(p.consume("nas.local", B));
        assertFalse(p.consume("nas.local", A));
    }

    @Test
    public void entriesArePerHostPortAndCaseInsensitive() {
        PresentedKeys p = new PresentedKeys();
        p.remember("[NAS.local]:2222", A);
        assertFalse(p.consume("nas.local", A));
        assertFalse(p.consume("[nas.local]:22", A));
        assertTrue(p.consume("[nas.local]:2222", A));
    }

    @Test
    public void aNewerPresentationReplacesTheOlderOne() {
        PresentedKeys p = new PresentedKeys();
        p.remember("nas.local", A);
        p.remember("nas.local", B);
        assertFalse(p.consume("nas.local", A));
        p.remember("nas.local", B);
        assertTrue(p.consume("nas.local", B));
    }

    @Test
    public void nothingRememberedNothingAccepted() {
        PresentedKeys p = new PresentedKeys();
        assertFalse(p.consume("nas.local", A));
        assertFalse(p.consume(null, A));
        p.remember("nas.local", A);
        assertFalse(p.consume("nas.local", null));
    }

    @Test
    public void theRememberedKeyIsACopy() {
        PresentedKeys p = new PresentedKeys();
        byte[] k = A.clone();
        p.remember("nas.local", k);
        k[0] = 9;
        assertTrue(p.consume("nas.local", A));
    }
}
