package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.regex.Pattern;

/**
 * Airport notes (Documents/FlyTab/notes/&lt;ID&gt;.txt): the name rule and the atomic
 * write, shared by TileServer and SftpPlugin. Plain Java, no Android types, so it
 * runs in JVM unit tests.
 */
public final class NoteFiles {
    private NoteFiles() {}

    /** Folder under Documents/FlyTab/ (TileServer baseDir) and under the SFTP remote path. */
    public static final String DIR = "notes";

    /** Largest note accepted or served (a note is a few lines of text). */
    public static final int MAX_BYTES = 1024 * 1024;

    // An airport identifier as FlyTab uses it (NASR icao: SC76, KLKR), upper case only:
    // no '.', '/', '\', spaces or control characters can reach a path.
    private static final Pattern NAME = Pattern.compile("^[A-Z0-9]{2,7}\\.txt$");

    /** A note file name that is safe to read, write, list and upload, e.g. "SC76.txt". */
    public static boolean isNoteName(String name) {
        return name != null && NAME.matcher(name).matches();
    }

    /**
     * Replace dir/name with the bytes of source, atomically: the bytes go to a
     * temporary file in the same folder, are synced to storage, and the temporary
     * file is then renamed over the note (rename(2) replaces the target in one
     * step). A crash or full disk mid-write leaves the old note whole; a failed
     * rename leaves it untouched (it is never deleted first).
     */
    public static void writeAtomic(File dir, String name, InputStream source) throws IOException {
        if (!isNoteName(name)) throw new IOException("invalid note name");
        File target = new File(dir, name);
        File tmp = new File(dir, name + ".tmp");
        boolean renamed = false;
        try {
            try (FileOutputStream out = new FileOutputStream(tmp, false)) {
                byte[] buf = new byte[8192];
                long total = 0;
                int n;
                while ((n = source.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_BYTES) throw new IOException("note too large");
                    out.write(buf, 0, n);
                }
                out.flush();
                out.getFD().sync();
            }
            if (!tmp.renameTo(target)) throw new IOException("rename failed");
            renamed = true;
        } finally {
            if (!renamed) tmp.delete();
        }
    }

    /** writeAtomic from a file (NanoHTTPD's temporary copy of a PUT body). */
    public static void writeAtomic(File dir, String name, File source) throws IOException {
        try (InputStream in = new FileInputStream(source)) {
            writeAtomic(dir, name, in);
        }
    }
}
