package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * The tablet checks its FAA files against the home server's checksums.json
 * (2026-10-16): the review found 2,461 plates on the tablet that differed from
 * the server (expired editions), 130 missing and thousands of leftovers --
 * nothing on the tablet could tell.
 */
public class ChecksumVerifyTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static String sha(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        StringBuilder b = new StringBuilder();
        for (byte x : md.digest(s.getBytes(StandardCharsets.UTF_8))) b.append(String.format("%02x", x));
        return b.toString();
    }

    private void write(File base, String rel, String body) throws IOException {
        File f = new File(base, rel);
        f.getParentFile().mkdirs();
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
    }

    private Map<String, ChecksumVerify.Expected> expected(String... pathBody) throws Exception {
        Map<String, ChecksumVerify.Expected> m = new HashMap<>();
        for (int i = 0; i < pathBody.length; i += 2) {
            m.put(pathBody[i], new ChecksumVerify.Expected(pathBody[i + 1].length(), sha(pathBody[i + 1])));
        }
        return m;
    }

    @Test
    public void allFilesMatch() throws Exception {
        File base = tmp.newFolder("FlyTab");
        write(base, "plates/KTMB/05349AD.PDF", "current");
        write(base, "nasr/bundle.json", "{}");
        ChecksumVerify.Result r = ChecksumVerify.verify(base, expected("plates/KTMB/05349AD.PDF", "current", "nasr/bundle.json", "{}"));
        assertEquals(2, r.checked);
        assertEquals(2, r.matched);
        assertTrue(r.missing.isEmpty() && r.changed.isEmpty() && r.extra.isEmpty());
    }

    @Test
    public void staleMissingAndExtraFilesAreReported() throws Exception {
        File base = tmp.newFolder("FlyTab");
        write(base, "plates/KTMB/00257FROGZ.PDF", "april edition");     // same name, other content
        write(base, "plates/KTMB/05349R9L.PDF", "ok");
        write(base, "plates/KPBI/00449AD.PDF", "dropped airport");       // extra
        write(base, "plates/KTMB/OLD.webp", "old image");                // extra
        write(base, "plates/KTMB/notes.txt", "not a plate");             // not considered
        ChecksumVerify.Result r = ChecksumVerify.verify(base, expected(
                "plates/KTMB/00257FROGZ.PDF", "october edition",
                "plates/KTMB/05349R9L.PDF", "ok",
                "plates/14A/10308R14.PDF", "missing on tablet"));
        assertEquals(3, r.checked);
        assertEquals(1, r.matched);
        assertEquals(Arrays.asList("plates/KTMB/00257FROGZ.PDF"), r.changed);
        assertEquals(Arrays.asList("plates/14A/10308R14.PDF"), r.missing);
        assertEquals(Arrays.asList("plates/KPBI/00449AD.PDF", "plates/KTMB/OLD.webp"), r.extra);
    }

    @Test
    public void sameSizeDifferentContentIsChanged() throws Exception {
        File base = tmp.newFolder("FlyTab");
        write(base, "cifp/cifp_bundle.json", "AAAA");
        ChecksumVerify.Result r = ChecksumVerify.verify(base, expected("cifp/cifp_bundle.json", "BBBB"));
        assertEquals(Arrays.asList("cifp/cifp_bundle.json"), r.changed);
    }

    @Test
    public void pathsOutsideTheDataFolderAreNotRead() throws Exception {
        File base = tmp.newFolder("FlyTab");
        write(tmp.getRoot(), "secret.txt", "x");
        ChecksumVerify.Result r = ChecksumVerify.verify(base, expected("../secret.txt", "x", "/etc/hosts", "x"));
        assertEquals(0, r.checked);
        assertEquals(2, r.rejected);
    }
}
