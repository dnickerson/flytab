package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;

/**
 * Plate sync left plates the new cycle's state zip no longer has: 4,060 expired
 * charts on the tablet (KTMB listed the FROGZ FIVE ARRIVAL of the 16 APR - 14 MAY
 * 2026 volume next to the current plates). Dana, 2026-10-16.
 */
public class PlatePruneTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File file(File base, String rel) throws IOException {
        File f = new File(base, rel);
        f.getParentFile().mkdirs();
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(1); }
        return f;
    }

    @Test
    public void filesNotInTheZipAreRemovedFromTheAirportFoldersItHas() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File keep = file(base, "plates/KTMB/05349HURCN.PDF");
        File old1 = file(base, "plates/KTMB/00257FROGZ.PDF");
        File old2 = file(base, "plates/KTMB/00744TARPN.PDF");
        PlatePrune p = new PlatePrune();
        p.saw("plates/KTMB/05349HURCN.PDF");
        assertEquals(2, p.prune(base));
        assertTrue(keep.exists());
        assertFalse(old1.exists());
        assertFalse(old2.exists());
    }

    @Test
    public void otherAirportsAndStatesAndTopLevelFilesAreNotTouched() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File otherState = file(base, "plates/KLKR/00001AD.PDF");      // NC: not in the FL zip
        File index = file(base, "plates/plate_index.json");
        File nasr = file(base, "nasr/bundle.json");
        PlatePrune p = new PlatePrune();
        p.saw("plates/KTMB/05349AD.PDF");
        p.saw("plates/plate_index.json");
        assertEquals(0, p.prune(base));
        assertTrue(otherState.exists());
        assertTrue(index.exists());
        assertTrue(nasr.exists());
    }

    @Test
    public void onlyPlateAirportFoldersArePruned() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File other = file(base, "cifp/old.json");
        PlatePrune p = new PlatePrune();
        p.saw("cifp/new.json");                                         // a non-plates zip
        assertEquals(0, p.prune(base));
        assertTrue(other.exists());
    }

    @Test
    public void subfoldersAreLeftAlone() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File nested = file(base, "plates/KTMB/sub/x.PDF");
        PlatePrune p = new PlatePrune();
        p.saw("plates/KTMB/05349AD.PDF");
        assertEquals(0, p.prune(base));
        assertTrue(nested.exists());
    }

    @Test
    public void unsafeNamesAreIgnored() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File outside = file(tmp.getRoot(), "victim/keep.txt");
        PlatePrune p = new PlatePrune();
        p.saw("plates/../victim/x.txt");
        p.saw("plates/KTMB/../../victim/x.txt");
        p.saw("/plates/KTMB/a.PDF");
        assertEquals(0, p.prune(base));
        assertTrue(outside.exists());
        assertEquals(Arrays.asList(), p.folders());
    }

    /**
     * Shared storage on the tablet is case-insensitive: extracting 05349AD.PDF over
     * an existing 05349ad.pdf rewrites that file and keeps its old name. Comparing
     * names case-sensitively deleted the plate just written (final review 2026-10-17).
     */
    @Test
    public void aFileWhoseNameDiffersOnlyInCaseIsKept() throws IOException {
        File base = tmp.newFolder("FlyTab");
        File sameFile = file(base, "plates/KTMB/05349ad.pdf");
        File old = file(base, "plates/KTMB/00257FROGZ.PDF");
        PlatePrune p = new PlatePrune();
        p.saw("plates/KTMB/05349AD.PDF");
        assertEquals(1, p.prune(base));
        assertTrue(sameFile.exists());
        assertFalse(old.exists());
    }
}
