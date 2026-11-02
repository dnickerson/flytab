package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.IOException;
import java.util.regex.Pattern;

/**
 * Flight-folder file checks shared by TileServer and SftpPlugin (plain Java, no
 * Android types, so they run in JVM unit tests).
 */
public final class FlightFiles {
    private FlightFiles() {}

    // Letters, digits, '_', '.', '-' then .ndjson: no '/', '\', spaces or control chars.
    private static final Pattern LOG_NAME = Pattern.compile("^[A-Za-z0-9_.-]+\\.ndjson$");

    /** A flight log (weather / traffic NDJSON) name that is safe to list and upload. */
    public static boolean isLogName(String name) {
        return name != null
            && name.length() <= 200
            && !name.contains("..")
            && LOG_NAME.matcher(name).matches();
    }

    /**
     * f resolves to dir/<f's name> itself: not a symbolic link (to anywhere, even in
     * dir) and not under a linked path. Canonical paths, not java.nio.file.Files
     * .isSymbolicLink, which needs API 26 (minSdk is 24). f need not exist yet.
     */
    public static boolean isDirectChild(File dir, File f) {
        if (dir == null || f == null) return false;
        try {
            File want = new File(dir.getCanonicalFile(), f.getName());
            return f.getCanonicalFile().equals(want);
        } catch (IOException e) {
            return false;
        }
    }

    /** An existing regular file directly in dir, not a link. */
    public static boolean isPlainFileIn(File dir, File f) {
        return f != null && f.isFile() && isDirectChild(dir, f);
    }
}
