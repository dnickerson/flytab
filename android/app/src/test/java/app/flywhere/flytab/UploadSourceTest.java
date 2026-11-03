package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * SftpPlugin.upload's source folder is allow-listed ("flights" default | "notes");
 * the file must be a plain file directly in the chosen folder (canonical path, no
 * links). Flight uploads behave as before; notes go to <remotePath>/notes/.
 */
public class UploadSourceTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File flyTab, flights, notes, outside;

    private static void write(File f, String s) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), s.getBytes(StandardCharsets.UTF_8));
    }

    @Before
    public void setUp() throws Exception {
        flyTab = tmp.newFolder("FlyTab");
        flights = new File(flyTab, "flights");
        notes = new File(flyTab, "notes");
        outside = tmp.newFolder("elsewhere");
        write(new File(flights, "20261101_KLKR-SC76.csv"), "a");
        write(new File(flights, "20261101_KLKR-SC76_weather.ndjson"), "{}");
        write(new File(notes, "SC76.txt"), "land 3, take off 21");
        write(new File(outside, "secret.txt"), "x");
        write(new File(outside, "KLKR.txt"), "x");
    }

    @Test
    public void flightsIsTheDefaultAndUnchanged() throws Exception {
        UploadSource s = UploadSource.resolve(flyTab, null, "20261101_KLKR-SC76.csv");
        assertNull(s.error);
        assertEquals(new File(flights, "20261101_KLKR-SC76.csv").getCanonicalFile(), s.file.getCanonicalFile());
        assertNull("flights go to the remote path itself", s.remoteSubdir);
        s = UploadSource.resolve(flyTab, "flights", "20261101_KLKR-SC76_weather.ndjson");
        assertNull(s.error);
        assertNull(s.remoteSubdir);
    }

    @Test
    public void notesComeFromTheNotesFolderAndGoToNotes() throws Exception {
        UploadSource s = UploadSource.resolve(flyTab, "notes", "SC76.txt");
        assertNull(s.error);
        assertEquals(new File(notes, "SC76.txt").getCanonicalFile(), s.file.getCanonicalFile());
        assertEquals("notes", s.remoteSubdir);
    }

    @Test
    public void unknownSourceFoldersAreRefused() {
        for (String dir : new String[]{"", "tiles", "NOTES", "Notes", "flights/", "../notes", "notes/..", "/", ".",
                "plates", "notes/../flights"}) {
            UploadSource s = UploadSource.resolve(flyTab, dir, "SC76.txt");
            assertEquals(dir, "Invalid source folder", s.error);
            assertNull(s.file);
        }
    }

    @Test
    public void fileNameRules() {
        for (String name : new String[]{null, "../secret.txt", "a/b.csv", "..", "x..csv"}) {
            assertEquals(String.valueOf(name), "Invalid filename", UploadSource.resolve(flyTab, "flights", name).error);
        }
        // Notes: only <ID>.txt, upper case, 2-7 characters
        for (String name : new String[]{"sc76.txt", "SC76.TXT", "S.txt", "TOOLONGX.txt", "SC76.txt.tmp",
                "20261101_KLKR-SC76.csv", "../flights/20261101_KLKR-SC76.csv"}) {
            assertEquals(name, "Invalid filename", UploadSource.resolve(flyTab, "notes", name).error);
        }
    }

    @Test
    public void aFlightFileIsNotSentAsANoteOrTheOtherWayRound() {
        assertEquals("Invalid filename", UploadSource.resolve(flyTab, "notes", "20261101_KLKR-SC76.csv").error);
        assertEquals("File not found: SC76.txt", UploadSource.resolve(flyTab, "flights", "SC76.txt").error);
    }

    @Test
    public void missingFileSaysFileNotFound() {
        assertEquals("File not found: KLKR.txt", UploadSource.resolve(flyTab, "notes", "KLKR.txt").error);
        assertEquals("File not found: X.csv", UploadSource.resolve(flyTab, null, "X.csv").error);
    }

    @Test
    public void linksAreRefused() throws Exception {
        Files.createSymbolicLink(new File(notes, "LINK.txt").toPath(), new File(outside, "secret.txt").toPath());
        Files.createSymbolicLink(new File(notes, "SAME.txt").toPath(), new File(notes, "SC76.txt").toPath());
        Files.createSymbolicLink(new File(flights, "l_weather.ndjson").toPath(), new File(outside, "secret.txt").toPath());
        assertTrue(UploadSource.resolve(flyTab, "notes", "LINK.txt").error.startsWith("Invalid file (not a plain file in the notes folder)"));
        assertTrue(UploadSource.resolve(flyTab, "notes", "SAME.txt").error.startsWith("Invalid file"));
        assertEquals("Invalid file (not a plain file in the flights folder): l_weather.ndjson",
                UploadSource.resolve(flyTab, "flights", "l_weather.ndjson").error);
        assertTrue(new File(notes, "DIR2.txt").mkdir());
        assertTrue(UploadSource.resolve(flyTab, "notes", "DIR2.txt").error.startsWith("Invalid file"));
    }

    @Test
    public void aNotesFolderThatIsALinkIsRefused() throws Exception {
        File real = notes;
        File moved = new File(tmp.getRoot(), "realnotes");
        assertTrue(real.renameTo(moved));
        Files.createSymbolicLink(notes.toPath(), outside.toPath());   // notes -> elsewhere (has KLKR.txt)
        assertEquals("Invalid folder (not a plain notes folder)", UploadSource.resolve(flyTab, "notes", "KLKR.txt").error);
    }
}
