package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Check the tablet's FAA files against the home server's checksums.json
 * (written by the pipeline's audit_currency.py): size + SHA-256 per file.
 *
 * changed  on the tablet with other content (an older edition under the same name)
 * missing  in the list, not on the tablet
 * extra    plate files (plates/<AIRPORT>/*.pdf|*.webp) not in the list -- leftovers
 * rejected paths in the list outside the data folder (never read)
 *
 * The review found 2,461 plates on the tablet differing from the server, 130
 * missing and thousands of leftovers, with nothing on the tablet able to tell
 * (2026-10-16).
 */
final class ChecksumVerify {

    static final class Expected {
        final long size;
        final String sha256;
        Expected(long size, String sha256) { this.size = size; this.sha256 = sha256; }
    }

    static final class Result {
        int checked, matched, rejected;
        final List<String> missing = new ArrayList<>();
        final List<String> changed = new ArrayList<>();
        final List<String> extra = new ArrayList<>();
    }

    static Result verify(File baseDir, Map<String, Expected> expected) throws IOException {
        Result r = new Result();
        String root = baseDir.getCanonicalPath() + File.separator;
        for (Map.Entry<String, Expected> e : expected.entrySet()) {
            String rel = e.getKey();
            File f = new File(baseDir, rel);
            if (rel.startsWith("/") || rel.contains("..") || !f.getCanonicalPath().startsWith(root)) {
                r.rejected++;
                continue;
            }
            r.checked++;
            if (!f.isFile()) { r.missing.add(rel); continue; }
            if (f.length() != e.getValue().size || !e.getValue().sha256.equalsIgnoreCase(sha256(f))) {
                r.changed.add(rel);
                continue;
            }
            r.matched++;
        }
        // Case-insensitive storage: a name differing only in case is the listed
        // file (PlatePrune keeps it), not a leftover.
        java.util.Set<String> listed = new java.util.HashSet<>();
        for (String k : expected.keySet()) listed.add(k.toUpperCase(java.util.Locale.ROOT));
        File plates = new File(baseDir, "plates");
        File[] airports = plates.listFiles(File::isDirectory);
        if (airports != null) {
            for (File dir : airports) {
                if ("state_zips".equals(dir.getName())) continue;
                File[] files = dir.listFiles(File::isFile);
                if (files == null) continue;
                for (File f : files) {
                    String n = f.getName().toLowerCase();
                    if (!n.endsWith(".pdf") && !n.endsWith(".webp")) continue;
                    String rel = "plates/" + dir.getName() + "/" + f.getName();
                    if (!listed.contains(rel.toUpperCase(java.util.Locale.ROOT))) r.extra.add(rel);
                }
            }
        }
        Collections.sort(r.missing);
        Collections.sort(r.changed);
        Collections.sort(r.extra);
        return r;
    }

    static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder b = new StringBuilder(64);
            for (byte x : md.digest()) b.append(String.format("%02x", x));
            return b.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }
}
