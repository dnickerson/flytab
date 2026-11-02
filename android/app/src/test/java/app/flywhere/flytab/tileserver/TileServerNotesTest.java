package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Airport notes (Documents/FlyTab/notes/<ID>.txt) through the tile server:
 *  - GET / PUT / DELETE /notes/<ID>.txt, ID upper-case [A-Z0-9]{2,7}; PUT and DELETE
 *    only with the app Origin; any other name under /notes/ refused, so the generic
 *    (non-atomic) PUT never writes there;
 *  - "can't read" (no storage access, unreadable file or folder) is 503
 *    storage-permission, never 404, so the notes box can't save over a hidden note;
 *  - PUT replaces the note atomically (temp file + rename);
 *  - GET /notes/list: note names only, plain files only (no links).
 * Raw sockets: HttpURLConnection silently drops a caller-set Origin header.
 */
public class TileServerNotesTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private TileServer server;
    private int port;
    private File base;
    private File notes;
    private File outside;

    private static final String APP = "http://localhost";

    private void start(boolean storageAccess) throws Exception {
        try (ServerSocket s = new ServerSocket(0)) { port = s.getLocalPort(); }
        base = tmp.newFolder("FlyTab");
        notes = new File(base, "notes");
        outside = tmp.newFolder("elsewhere");
        server = new TileServer(port, base, () -> storageAccess);
        server.start(5000, false);
    }

    @After
    public void tearDown() {
        if (server != null) server.stop();
        if (notes != null) { notes.setReadable(true); notes.setExecutable(true); }
    }

    private static final class Resp {
        final int status; final String head; final byte[] body;
        Resp(int status, String head, byte[] body) { this.status = status; this.head = head; this.body = body; }
        String text() { return new String(body, StandardCharsets.UTF_8); }
    }

    /** One request on a fresh connection (Connection: close); -1 if the server sent no response. */
    private Resp req(String method, String path, String origin, byte[] body) throws Exception {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(5000);
            StringBuilder h = new StringBuilder(method + " " + path + " HTTP/1.1\r\nHost: localhost:" + port
                    + "\r\nConnection: close\r\n");
            if (origin != null) h.append("Origin: ").append(origin).append("\r\n");
            if (body != null) h.append("Content-Type: text/plain; charset=utf-8\r\nContent-Length: ")
                    .append(body.length).append("\r\n");
            h.append("\r\n");
            OutputStream out = s.getOutputStream();
            out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (body != null) out.write(body);
            out.flush();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            InputStream in = s.getInputStream();
            byte[] buf = new byte[4096];
            int n;
            try {
                while ((n = in.read(buf)) > 0) all.write(buf, 0, n);
            } catch (IOException ignored) { /* reset after the response: keep what arrived */ }
            byte[] raw = all.toByteArray();
            String str = new String(raw, StandardCharsets.ISO_8859_1);
            int split = str.indexOf("\r\n\r\n");
            if (split < 0) return new Resp(-1, str, new byte[0]);
            String head = str.substring(0, split);
            int status = Integer.parseInt(head.split(" ")[1]);
            byte[] rest = java.util.Arrays.copyOfRange(raw, split + 4, raw.length);
            return new Resp(status, head, rest);
        }
    }

    private Resp get(String path) throws Exception { return req("GET", path, null, null); }
    private Resp put(String path, String text, String origin) throws Exception {
        return req("PUT", path, origin, text.getBytes(StandardCharsets.UTF_8));
    }

    private void write(File f, String text) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private String read(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static List<String> names(String json) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\"name\":\"([^\"]*)\"").matcher(json);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    // ── GET ───────────────────────────────────────────────────────────────

    @Test
    public void missingNoteIs404AndNoFolderIsCreatedByAGet() throws Exception {
        start(true);
        assertEquals(404, get("/notes/SC76.txt").status);
        assertFalse(notes.exists());
    }

    @Test
    public void getReturnsTheNoteAsUtf8Text() throws Exception {
        start(true);
        String text = "Land 3 — take off 21 ✈\nUphill to the NE.";
        write(new File(notes, "SC76.txt"), text);
        Resp r = get("/notes/SC76.txt");
        assertEquals(200, r.status);
        assertTrue(r.head, r.head.toLowerCase().contains("content-type: text/plain; charset=utf-8"));
        assertTrue(r.head, r.head.toLowerCase().contains("cache-control: no-store"));
        assertEquals(text, r.text());
    }

    @Test
    public void noStorageAccessIs503NotNotFound() throws Exception {
        start(false);
        write(new File(notes, "SC76.txt"), "keep me");
        Resp r = get("/notes/SC76.txt");
        assertEquals(503, r.status);
        assertEquals("storage-permission", r.text());
        assertEquals("a missing note too: can't tell without access", 503, get("/notes/KLKR.txt").status);
        assertEquals(503, get("/notes/list").status);
    }

    @Test
    public void unreadableFileIs503() throws Exception {
        start(true);
        File f = new File(notes, "SC76.txt");
        write(f, "keep me");
        assertTrue(f.setReadable(false, false));
        org.junit.Assume.assumeFalse("running as root: permissions not enforced", f.canRead());
        Resp r = get("/notes/SC76.txt");
        assertEquals(503, r.status);
        assertEquals("storage-permission", r.text());
        f.setReadable(true, false);
    }

    @Test
    public void unreadableFolderIs503NotNotFound() throws Exception {
        start(true);
        write(new File(notes, "SC76.txt"), "keep me");
        assertTrue(notes.setReadable(false, false));
        assertTrue(notes.setExecutable(false, false));
        org.junit.Assume.assumeFalse("running as root: permissions not enforced", notes.canRead());
        assertEquals(503, get("/notes/SC76.txt").status);
        assertEquals(503, get("/notes/list").status);
    }

    // ── PUT ───────────────────────────────────────────────────────────────

    @Test
    public void putCreatesTheFolderAndWritesTheNote() throws Exception {
        start(true);
        String text = "Owners' arrival: left downwind 3. ✈";
        Resp r = put("/notes/SC76.txt", text, APP);
        assertEquals(201, r.status);
        assertEquals(text, read(new File(notes, "SC76.txt")));
        assertEquals(text, get("/notes/SC76.txt").text());
        assertFalse("no temp file left", new File(notes, "SC76.txt.tmp").exists());
    }

    @Test
    public void putReplacesTheWholeNote() throws Exception {
        start(true);
        write(new File(notes, "SC76.txt"), "a much longer old note that must not leave a tail behind");
        assertEquals(201, put("/notes/SC76.txt", "short", APP).status);
        assertEquals("short", read(new File(notes, "SC76.txt")));
    }

    @Test
    public void writesAreRefusedWithoutTheAppOrigin() throws Exception {
        start(true);
        File f = new File(notes, "SC76.txt");
        write(f, "keep me");
        for (String origin : new String[]{null, "null", "https://evil.example", "http://localhost:8080"}) {
            Resp p = put("/notes/SC76.txt", "overwritten", origin);
            Resp d = req("DELETE", "/notes/SC76.txt", origin, null);
            // 403 from allowed(); in a JVM test android.util.Log (the refusal's log
            // line) is a stub that throws, so the server may drop the connection
            // instead. Either way: no success, and the note is untouched.
            assertRefused(String.valueOf(origin), p);
            assertRefused(String.valueOf(origin), d);
            assertEquals("keep me", read(f));
            assertTrue(f.exists());
            assertFalse(new File(notes, "KLKR.txt").exists());
        }
        assertFalse(TileServer.allowed("PUT", null));
        assertFalse(TileServer.allowed("DELETE", "https://evil.example"));
        assertTrue(TileServer.allowed("PUT", APP));
    }

    private static void assertRefused(String what, Resp r) {
        assertTrue(what + ": " + r.status, r.status == 403 || r.status == -1 || r.status == 500);
    }

    @Test
    public void noStorageAccessRefusesWrites() throws Exception {
        start(false);
        assertEquals(503, put("/notes/SC76.txt", "x", APP).status);
        assertFalse(new File(notes, "SC76.txt").exists());
        File f = new File(notes, "KLKR.txt");
        write(f, "keep me");
        assertEquals(503, req("DELETE", "/notes/KLKR.txt", APP, null).status);
        assertEquals("keep me", read(f));
    }

    @Test
    public void oversizeNoteIsRefusedAndTheOldOneKept() throws Exception {
        start(true);
        File f = new File(notes, "SC76.txt");
        write(f, "keep me");
        StringBuilder big = new StringBuilder();
        while (big.length() <= NoteFiles.MAX_BYTES) big.append("0123456789abcdef");
        Resp r = put("/notes/SC76.txt", big.toString(), APP);
        assertTrue(String.valueOf(r.status), r.status == 413 || r.status == -1);
        assertEquals("keep me", read(f));
    }

    @Test
    public void otherNamesUnderNotesAreRefusedForEveryMethod() throws Exception {
        start(true);
        write(new File(base, "flights/x.csv"), "flight");
        String[] bad = {"/notes/sc76.txt", "/Notes/SC76.txt", "/NOTES/SC76.txt", "/notes/SC76.TXT",
                "/notes/S.txt", "/notes/TOOLONGX.txt", "/notes/SC76.txt.tmp", "/notes/SC76",
                "/notes/../flights/x.csv", "/notes/SC%2F76.txt", "/notes/SC76.txt/x", "/notes/", "/notes",
                "/notes/.txt"};
        for (String p : bad) {
            assertEquals(p, 400, get(p).status);
            assertEquals(p, 400, put(p, "x", APP).status);
            assertEquals(p, 400, req("DELETE", p, APP, null).status);
        }
        assertEquals("flight", read(new File(base, "flights/x.csv")));
        String[] left = notes.exists() ? notes.list() : new String[0];
        assertEquals(0, left.length);
        assertFalse(new File(base, "Notes").exists() && !new File(base, "Notes").equals(notes));
    }

    // ── DELETE ────────────────────────────────────────────────────────────

    @Test
    public void deleteRemovesTheNote() throws Exception {
        start(true);
        File f = new File(notes, "SC76.txt");
        write(f, "x");
        assertEquals(200, req("DELETE", "/notes/SC76.txt", APP, null).status);
        assertFalse(f.exists());
        assertEquals(404, req("DELETE", "/notes/SC76.txt", APP, null).status);
    }

    // ── links ─────────────────────────────────────────────────────────────

    @Test
    public void linksAreNeitherReadNorWrittenThrough() throws Exception {
        start(true);
        File secret = new File(outside, "secret.txt");
        write(secret, "do not touch");
        assertTrue(notes.mkdirs());
        Files.createSymbolicLink(new File(notes, "LINK.txt").toPath(), secret.toPath());
        assertEquals(403, get("/notes/LINK.txt").status);
        assertEquals(409, put("/notes/LINK.txt", "x", APP).status);
        assertEquals(409, req("DELETE", "/notes/LINK.txt", APP, null).status);
        assertEquals("do not touch", read(secret));
        assertTrue(Files.isSymbolicLink(new File(notes, "LINK.txt").toPath()));
    }

    @Test
    public void aNotesFolderThatIsALinkIsRefused() throws Exception {
        start(true);
        write(new File(outside, "SC76.txt"), "elsewhere");
        Files.createSymbolicLink(notes.toPath(), outside.toPath());
        assertEquals(500, get("/notes/SC76.txt").status);
        assertEquals(500, put("/notes/SC76.txt", "x", APP).status);
        assertEquals(500, get("/notes/list").status);
        assertEquals("elsewhere", read(new File(outside, "SC76.txt")));
    }

    // ── /notes/list ───────────────────────────────────────────────────────

    @Test
    public void listIsEmptyWithoutAFolder() throws Exception {
        start(true);
        Resp r = get("/notes/list");
        assertEquals(200, r.status);
        assertEquals("[]", r.text());
    }

    @Test
    public void listShowsPlainNoteFilesOnly() throws Exception {
        start(true);
        write(new File(notes, "SC76.txt"), "abc");
        write(new File(notes, "KLKR.txt"), "de");
        write(new File(notes, "KJFK.txt.tmp"), "x");
        write(new File(notes, "sc77.txt"), "x");
        write(new File(notes, "SC78.TXT"), "x");
        write(new File(notes, "TOOLONGX.txt"), "x");
        write(new File(notes, "A.txt"), "x");
        write(new File(notes, "A B.txt"), "x");
        write(new File(notes, "notes.md"), "x");
        assertTrue(new File(notes, "DIR1.txt").mkdir());
        File secret = new File(outside, "secret.txt");
        write(secret, "do not upload");
        Files.createSymbolicLink(new File(notes, "LINK.txt").toPath(), secret.toPath());
        Files.createSymbolicLink(new File(notes, "SAME.txt").toPath(), new File(notes, "SC76.txt").toPath());

        Resp r = get("/notes/list");
        assertEquals(200, r.status);
        assertEquals(java.util.Arrays.asList("KLKR.txt", "SC76.txt"), names(r.text()));
        File a = new File(notes, "KLKR.txt"), b = new File(notes, "SC76.txt");
        assertEquals("[{\"name\":\"KLKR.txt\",\"size_bytes\":2,\"modified_ms\":" + a.lastModified() + "},"
                + "{\"name\":\"SC76.txt\",\"size_bytes\":3,\"modified_ms\":" + b.lastModified() + "}]", r.text());
    }

    @Test
    public void flightsListIsUnchangedByNotes() throws Exception {
        start(true);
        write(new File(notes, "SC76.txt"), "abc");
        Resp r = get("/flights/list");
        assertEquals(200, r.status);
        assertEquals("[]", r.text());
    }

    // ── NoteFiles ─────────────────────────────────────────────────────────

    @Test
    public void noteNames() {
        for (String ok : new String[]{"SC76.txt", "KLKR.txt", "K2.txt", "ABCDEFG.txt", "12.txt"}) {
            assertTrue(ok, NoteFiles.isNoteName(ok));
        }
        for (String bad : new String[]{null, "", ".txt", "S.txt", "ABCDEFGH.txt", "sc76.txt", "SC76.TXT",
                "SC76.txt.tmp", "../SC76.txt", "SC/76.txt", "SC 76.txt", "SC76..txt", "SC76.md", "SC76.txt\n"}) {
            assertFalse(String.valueOf(bad), NoteFiles.isNoteName(bad));
        }
    }

    @Test
    public void atomicWriteKeepsTheOldNoteWhenTheWriteFails() throws Exception {
        File dir = tmp.newFolder("n");
        File f = new File(dir, "SC76.txt");
        Files.write(f.toPath(), "old note".getBytes(StandardCharsets.UTF_8));
        InputStream failing = new InputStream() {
            int n = 0;
            @Override public int read() throws IOException {
                if (n++ < 10000) return 'x';
                throw new IOException("storage gone mid-write");
            }
        };
        try {
            NoteFiles.writeAtomic(dir, "SC76.txt", failing);
            fail("expected IOException");
        } catch (IOException expected) { /* ok */ }
        assertEquals("old note", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        assertFalse("temp file removed", new File(dir, "SC76.txt.tmp").exists());
    }

    @Test
    public void atomicWriteKeepsTheOldNoteWhenTooLarge() throws Exception {
        File dir = tmp.newFolder("n");
        File f = new File(dir, "SC76.txt");
        Files.write(f.toPath(), "old note".getBytes(StandardCharsets.UTF_8));
        try {
            NoteFiles.writeAtomic(dir, "SC76.txt", new ByteArrayInputStream(new byte[NoteFiles.MAX_BYTES + 1]));
            fail("expected IOException");
        } catch (IOException expected) { /* ok */ }
        assertEquals("old note", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        assertFalse(new File(dir, "SC76.txt.tmp").exists());
    }

    @Test
    public void atomicWriteNeverDeletesTheTargetWhenTheRenameFails() throws Exception {
        File dir = tmp.newFolder("n");
        File target = new File(dir, "SC76.txt");
        assertTrue(target.mkdir());                       // rename(2) can't replace a non-empty directory
        Files.write(new File(target, "inside").toPath(), "x".getBytes(StandardCharsets.UTF_8));
        try {
            NoteFiles.writeAtomic(dir, "SC76.txt", new ByteArrayInputStream("new".getBytes(StandardCharsets.UTF_8)));
            fail("expected IOException");
        } catch (IOException expected) { /* ok */ }
        assertTrue(new File(target, "inside").exists());
        assertFalse(new File(dir, "SC76.txt.tmp").exists());
    }

    @Test
    public void atomicWriteReplacesInOneStep() throws Exception {
        File dir = tmp.newFolder("n");
        File f = new File(dir, "SC76.txt");
        Files.write(f.toPath(), "old".getBytes(StandardCharsets.UTF_8));
        Object inodeBefore = Files.getAttribute(f.toPath(), "unix:ino");
        byte[] text = "new text ✈".getBytes(StandardCharsets.UTF_8);
        NoteFiles.writeAtomic(dir, "SC76.txt", new ByteArrayInputStream(text));
        assertArrayEquals(text, Files.readAllBytes(f.toPath()));
        // A new inode: the note was replaced by rename, not truncated and rewritten in place.
        assertNotEquals(inodeBefore, Files.getAttribute(f.toPath(), "unix:ino"));
        assertFalse(new File(dir, "SC76.txt.tmp").exists());
    }

    @Test(expected = IOException.class)
    public void atomicWriteRefusesBadNames() throws Exception {
        NoteFiles.writeAtomic(tmp.newFolder("n"), "../x.txt", new ByteArrayInputStream(new byte[1]));
    }
}
