package app.flywhere.flytab;

import app.flywhere.flytab.tileserver.FlightFiles;
import app.flywhere.flytab.tileserver.NoteFiles;

import java.io.File;

/**
 * Which local file SftpPlugin.upload may send, and to which remote sub-folder.
 * Plain Java (no Android types) so the checks run in JVM unit tests.
 *
 * The source folder is allow-listed: "flights" (the default, unchanged behaviour)
 * or "notes" (airport notes, sent to &lt;remotePath&gt;/notes/). Anything else is
 * refused. The file must be a plain file directly in the chosen folder (canonical
 * path check, no links); a note must also have a note name (NoteFiles.isNoteName)
 * and the notes folder itself must not be a link.
 */
public final class UploadSource {
    public static final String FLIGHTS = "flights";
    public static final String NOTES = NoteFiles.DIR;

    /** The file to send, or null when refused. */
    public final File file;
    /** Remote sub-folder under the configured remote path, or null (the remote path itself). */
    public final String remoteSubdir;
    /** Why the upload is refused, or null. "File not found: <name>" when the file is missing. */
    public final String error;

    private UploadSource(File file, String remoteSubdir, String error) {
        this.file = file;
        this.remoteSubdir = remoteSubdir;
        this.error = error;
    }

    private static UploadSource refuse(String error) {
        return new UploadSource(null, null, error);
    }

    /**
     * @param flyTabDir Documents/FlyTab
     * @param dir       "flights" (or null) | "notes"
     * @param filename  a bare file name, no path
     */
    public static UploadSource resolve(File flyTabDir, String dir, String filename) {
        String which = dir == null ? FLIGHTS : dir;
        boolean notes = NOTES.equals(which);
        if (!notes && !FLIGHTS.equals(which)) return refuse("Invalid source folder");
        // Existing flight-file rule, kept as it was; notes must also be <ID>.txt.
        if (filename == null || filename.contains("..") || filename.contains("/")) return refuse("Invalid filename");
        if (notes && !NoteFiles.isNoteName(filename)) return refuse("Invalid filename");

        File folder = new File(flyTabDir, which);
        File local = new File(folder, filename);
        if (!local.exists()) return refuse("File not found: " + filename);
        if (notes && !FlightFiles.isDirectChild(flyTabDir, folder)) {
            return refuse("Invalid folder (not a plain notes folder)");
        }
        // Only a regular file directly in the folder (not a link planted in the shared folder).
        if (!FlightFiles.isPlainFileIn(folder, local)) {
            return refuse("Invalid file (not a plain file in the " + which + " folder): " + filename);
        }
        return new UploadSource(local, notes ? NOTES : null, null);
    }
}
