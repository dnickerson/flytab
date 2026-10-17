package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Plate sync: after a state's zip is extracted, remove the plates its airport
 * folders no longer have. Extraction only added and replaced files, so a new
 * cycle left the old one's dropped charts in place -- 4,060 expired plates on the
 * tablet, KTMB listing the 16 APR - 14 MAY 2026 FROGZ FIVE ARRIVAL beside the
 * current plates (Dana, 2026-10-16).
 *
 * Only plain files directly in a {@code plates/<AIRPORT>/} folder that the zip
 * itself has are considered; other airports (other states), top-level files
 * (plate_index.json) and anything outside plates/ are never touched.
 */
final class PlatePrune {

    /**
     * "plates/KTMB" -> names in the zip, upper-cased ("05349AD.PDF", ...): shared
     * storage is case-insensitive, so extracting 05349AD.PDF over 05349ad.pdf
     * rewrites that file under its old name, which must not count as a leftover
     * (final review 2026-10-17).
     */
    private final Map<String, Set<String>> keep = new TreeMap<>();

    /** An entry of the zip (its name as in the zip). */
    void saw(String entryName) {
        if (entryName == null || entryName.startsWith("/") || entryName.contains("\\")) return;
        String[] p = entryName.split("/", -1);
        if (p.length != 3 || !"plates".equals(p[0])) return;
        for (String s : p) if (s.isEmpty() || ".".equals(s) || "..".equals(s)) return;
        keep.computeIfAbsent(p[0] + "/" + p[1], k -> new HashSet<>()).add(p[2].toUpperCase(Locale.ROOT));
    }

    /** The airport folders the zip has (for tests and the log). */
    List<String> folders() {
        return new ArrayList<>(keep.keySet());
    }

    /** Delete the files in those folders that the zip did not have. Returns how many. */
    int prune(File baseDir) throws IOException {
        String root = baseDir.getCanonicalPath() + File.separator;
        int deleted = 0;
        for (Map.Entry<String, Set<String>> e : keep.entrySet()) {
            File dir = new File(baseDir, e.getKey());
            if (!dir.getCanonicalPath().startsWith(root) || !dir.isDirectory()) continue;
            File[] files = dir.listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (!f.isFile() || e.getValue().contains(f.getName().toUpperCase(Locale.ROOT))) continue;
                if (f.delete()) deleted++;
            }
        }
        return deleted;
    }
}
