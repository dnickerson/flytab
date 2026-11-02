package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The SFTP self-update installs only a FlyTab APK signed like the installed app and
 * newer than it (security review 2026-11-01). Fake package infos: the plugin reads
 * the real ones from PackageManager and passes these values in.
 */
public class ApkCheckTest {
    private static final String PKG = "app.flywhere.flytab";
    private static final Set<String> OURS = set(ApkCheck.sha256Hex("our cert".getBytes(StandardCharsets.UTF_8)));
    private static final Set<String> THEIRS = set(ApkCheck.sha256Hex("their cert".getBytes(StandardCharsets.UTF_8)));

    private static Set<String> set(String... s) { return new HashSet<>(Arrays.asList(s)); }

    @Test
    public void aNewerFlyTabSignedWithOurKeyIsAccepted() {
        assertNull(ApkCheck.refusal(PKG, 1251, OURS, PKG, 1252, set(OURS.iterator().next())));
    }

    @Test
    public void anotherPackageIsRefused() {
        String r = ApkCheck.refusal(PKG, 1251, OURS, "com.evil.app", 9999, OURS);
        assertNotNull(r);
        assertTrue(r, r.contains("com.evil.app"));
    }

    @Test
    public void anUnreadableFileIsRefused() {
        assertNotNull(ApkCheck.refusal(PKG, 1251, OURS, null, -1, null));
    }

    @Test
    public void anotherSigningKeyIsRefused() {
        assertNotNull(ApkCheck.refusal(PKG, 1251, OURS, PKG, 1252, THEIRS));
        Set<String> both = new HashSet<>(OURS);
        both.addAll(THEIRS);
        assertNotNull("an extra signer is not the same signers", ApkCheck.refusal(PKG, 1251, OURS, PKG, 1252, both));
    }

    @Test
    public void missingSignaturesAreRefused() {
        assertNotNull(ApkCheck.refusal(PKG, 1251, OURS, PKG, 1252, Collections.<String>emptySet()));
        assertNotNull(ApkCheck.refusal(PKG, 1251, OURS, PKG, 1252, null));
        assertNotNull("installed signers unreadable", ApkCheck.refusal(PKG, 1251, Collections.<String>emptySet(), PKG, 1252, OURS));
    }

    @Test
    public void theSameOrAnOlderVersionIsRefused() {
        String same = ApkCheck.refusal(PKG, 1251, OURS, PKG, 1251, OURS);
        assertNotNull(same);
        assertTrue(same, same.contains("1251"));
        assertNotNull(ApkCheck.refusal(PKG, 1251, OURS, PKG, 1250, OURS));
        assertNotNull("v6.0 style downgrade", ApkCheck.refusal(PKG, 1251, OURS, PKG, 60, OURS));
    }

    @Test
    public void sha256HexIsLowerCaseHex() {
        String h = ApkCheck.sha256Hex(new byte[0]);
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", h);
    }
}
