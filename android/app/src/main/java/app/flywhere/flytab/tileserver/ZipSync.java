package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Extract a downloaded data zip (state plates, nasr.zip, cifp.zip) into the
 * data folder, then prune the plate folders it covers (PlatePrune).
 *
 * Read through ZipFile, which needs the zip's central directory -- written
 * last, so only a complete zip has it. ZipInputStream read a zip cut off at an
 * entry boundary, or a body that wasn't a zip at all, as complete and empty:
 * the prune then deleted the airport's current plates and the sync recorded
 * the state as current (pre-merge review, 2026-10-16). An empty zip fails too.
 * Each file is written beside its target and renamed over it, so a failure
 * mid-file leaves the previous file whole; the prune runs only after every
 * entry was written.
 */
final class ZipSync {

    static final class Result {
        int extracted, pruned, folders;
    }

    static Result extract(File zipFile, File baseDir) throws IOException {
        String root = baseDir.getCanonicalPath() + File.separator;
        Result r = new Result();
        PlatePrune prune = new PlatePrune();
        try (ZipFile zf = new ZipFile(zipFile)) {
            if (zf.size() == 0) throw new IOException("zip has no files");
            byte[] buf = new byte[65536];
            Enumeration<? extends ZipEntry> entries = zf.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (name.startsWith("/") || name.contains("\\") || name.contains("..")) continue;
                File outFile = new File(baseDir, name);
                if (!outFile.getCanonicalPath().startsWith(root)) continue;
                prune.saw(name);
                File parent = outFile.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("cannot create " + parent);
                }
                File part = new File(outFile.getPath() + ".part");
                try (InputStream in = zf.getInputStream(entry); FileOutputStream out = new FileOutputStream(part)) {
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } catch (IOException e) {
                    part.delete();
                    throw e;
                }
                if (!part.renameTo(outFile)) {
                    part.delete();
                    throw new IOException("cannot replace " + name);
                }
                r.extracted++;
            }
        }
        if (r.extracted == 0) throw new IOException("zip has no files for the data folder");
        r.pruned = prune.prune(baseDir);
        r.folders = prune.folders().size();
        return r;
    }

    private ZipSync() {}
}
