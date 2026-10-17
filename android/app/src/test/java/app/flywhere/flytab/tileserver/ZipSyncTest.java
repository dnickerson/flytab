package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Plate sync extraction (pre-merge review, 2026-10-16). A zip cut off at an
 * entry boundary -- or a 200 that isn't a zip -- read as complete through
 * ZipInputStream; the prune then deleted the airport's current plates and the
 * state was recorded as synced.
 */
public class ZipSyncTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static byte[] zip(String... nameBody) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bos)) {
            for (int i = 0; i < nameBody.length; i += 2) {
                z.putNextEntry(new ZipEntry(nameBody[i]));
                z.write(nameBody[i + 1].getBytes(StandardCharsets.UTF_8));
                z.closeEntry();
            }
        }
        return bos.toByteArray();
    }

    private File file(String name, byte[] body) throws IOException {
        File f = tmp.newFile(name);
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(body); }
        return f;
    }

    private File baseWithOldPlates() throws IOException {
        File base = tmp.newFolder("FlyTab");
        new File(base, "plates/KTMB").mkdirs();
        for (String n : new String[]{"P0.PDF", "P1.PDF", "P2.PDF", "P3.PDF", "OLD.PDF"}) {
            Files.write(new File(base, "plates/KTMB/" + n).toPath(), "old".getBytes(StandardCharsets.UTF_8));
        }
        return base;
    }

    private static final String[] FOUR = {"plates/KTMB/P0.PDF", "new0", "plates/KTMB/P1.PDF", "new1",
                                          "plates/KTMB/P2.PDF", "new2", "plates/KTMB/P3.PDF", "new3"};

    @Test
    public void completeZipExtractsAndPrunes() throws Exception {
        File base = baseWithOldPlates();
        ZipSync.Result r = ZipSync.extract(file("ok.zip", zip(FOUR)), base);
        assertEquals(4, r.extracted);
        assertEquals(1, r.pruned);                                   // OLD.PDF
        assertFalse(new File(base, "plates/KTMB/OLD.PDF").exists());
        assertEquals("new3", new String(Files.readAllBytes(new File(base, "plates/KTMB/P3.PDF").toPath()), StandardCharsets.UTF_8));
    }

    @Test
    public void zipCutAtAnEntryBoundaryFailsAndDeletesNothing() throws Exception {
        File base = baseWithOldPlates();
        byte[] full = zip(FOUR);
        byte[] two = zip(FOUR[0], FOUR[1], FOUR[2], FOUR[3]);
        // the first two entries' local records, as a download cut there would deliver
        int cut = indexOf(two, new byte[]{0x50, 0x4b, 0x01, 0x02});          // central directory start
        byte[] partial = Arrays.copyOf(full, cut + 12);
        try {
            ZipSync.extract(file("cut.zip", partial), base);
            fail("a cut-off zip must fail");
        } catch (IOException expected) { }
        for (String n : new String[]{"P0.PDF", "P1.PDF", "P2.PDF", "P3.PDF", "OLD.PDF"}) {
            assertTrue(n + " kept", new File(base, "plates/KTMB/" + n).exists());
        }
    }

    @Test
    public void aBodyThatIsNotAZipFails() throws Exception {
        File base = baseWithOldPlates();
        for (byte[] body : new byte[][]{"<html>captive portal</html>".getBytes(StandardCharsets.UTF_8), new byte[0]}) {
            try {
                ZipSync.extract(file("x" + body.length + ".zip", body), base);
                fail("not a zip must fail");
            } catch (IOException expected) { }
        }
        assertTrue(new File(base, "plates/KTMB/OLD.PDF").exists());
    }

    @Test
    public void anEmptyZipFails() throws Exception {
        File base = baseWithOldPlates();
        try {
            ZipSync.extract(file("empty.zip", zip()), base);
            fail("an empty zip must fail");
        } catch (IOException expected) { }
        assertTrue(new File(base, "plates/KTMB/OLD.PDF").exists());
    }

    @Test
    public void entriesOutsideTheDataFolderAreNotWritten() throws Exception {
        File base = tmp.newFolder("FlyTab2");
        ZipSync.Result r = ZipSync.extract(file("evil.zip", zip("../evil.txt", "x", "/abs.txt", "x", "plates/KTMB/A.PDF", "a")), base);
        assertEquals(1, r.extracted);
        assertFalse(new File(tmp.getRoot(), "evil.txt").exists());
        assertTrue(new File(base, "plates/KTMB/A.PDF").exists());
    }

    private static int indexOf(byte[] a, byte[] pat) {
        outer:
        for (int i = 0; i <= a.length - pat.length; i++) {
            for (int j = 0; j < pat.length; j++) if (a[i + j] != pat[j]) continue outer;
            return i;
        }
        return -1;
    }
}
