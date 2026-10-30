package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 2026-10-28, on the tablet: the WebView GETs a flight file, the CORS preflight
 * for the next PUT reuses that connection, and the PUT then fails with
 * net::ERR_INVALID_HTTP_RESPONSE -- although the server wrote the file. NanoHTTPD
 * 2.3.1 gzips any text/* response when the request accepts gzip, the 204 too, so
 * the 204 went out with a chunked gzip body. A 204 has no body (RFC 9110 15.3.5):
 * the browser stops at the headers, and the stray bytes become the start of the
 * next response on the socket. Every recording rename "failed" (copy left behind,
 * logbook got no route), and appends that had been written were sent again.
 *
 * Replays the WebView's requests on one keep-alive socket, Accept-Encoding as
 * Chromium sends it.
 */
public class TileServerNoContentTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private TileServer server;
    private int port;
    private File flights;

    private static final String H = "Host: localhost\r\nConnection: keep-alive\r\n"
            + "Accept-Encoding: gzip, deflate, br\r\nOrigin: http://localhost\r\n";

    @Before
    public void setUp() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) { port = s.getLocalPort(); }
        File base = tmp.newFolder("FlyTab");
        flights = new File(base, "flights");
        assertTrue(flights.mkdirs());
        Files.write(new File(flights, "20261027_1500Z.csv").toPath(),
                "Zulu_Time,RPM\n3:01:28 PM,1090\n".getBytes(StandardCharsets.UTF_8));
        server = new TileServer(port, base);
        server.start(5000, false);
    }

    @After
    public void tearDown() {
        if (server != null) server.stop();
    }

    /** Reads one HTTP/1.1 response (Content-Length or chunked) off the stream. */
    private static String readResponse(InputStream in) throws Exception {
        String head = readHead(in);
        String lower = head.toLowerCase();
        if (lower.contains("transfer-encoding: chunked")) {
            while (true) {
                String sizeLine = readLine(in);
                int size = Integer.parseInt(sizeLine.trim(), 16);
                readBytes(in, size + 2);
                if (size == 0) break;
            }
        } else {
            int i = lower.indexOf("content-length:");
            if (i >= 0) {
                int end = lower.indexOf("\r\n", i);
                int len = Integer.parseInt(head.substring(i + 15, end).trim());
                readBytes(in, len);
            }
        }
        return head;
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, n = 0;
        while ((c = in.read()) != -1) {
            b.write(c);
            n = (c == '\r' || c == '\n') ? n + 1 : 0;
            if (n == 4) break;
        }
        return b.toString("ISO-8859-1");
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1 && c != '\n') b.write(c);
        return b.toString("ISO-8859-1");
    }

    private static void readBytes(InputStream in, int n) throws Exception {
        for (int i = 0; i < n; i++) if (in.read() == -1) throw new AssertionError("EOF");
    }

    @Test
    public void preflightHasNoBodySoTheNextResponseOnTheSocketIsIntact() throws Exception {
        String body = "Zulu_Time,RPM\n3:01:28 PM,1090\n";
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(5000);
            OutputStream out = s.getOutputStream();
            InputStream in = s.getInputStream();

            out.write(("GET /flights/20261027_1500Z.csv HTTP/1.1\r\n" + H + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
            assertTrue(readResponse(in).startsWith("HTTP/1.1 200"));

            out.write(("OPTIONS /flights/20261027_KTBR-KTBR.csv HTTP/1.1\r\n" + H
                    + "Access-Control-Request-Method: PUT\r\nAccess-Control-Request-Headers: content-type\r\n\r\n")
                    .getBytes(StandardCharsets.ISO_8859_1));
            // The browser reads a 204 as headers only -- so must this test.
            String preflight = readHead(in);
            assertTrue(preflight, preflight.startsWith("HTTP/1.1 204"));
            assertFalse(preflight, preflight.toLowerCase().contains("transfer-encoding"));
            assertFalse(preflight, preflight.toLowerCase().contains("content-encoding"));
            assertTrue(preflight, preflight.contains("Access-Control-Allow-Origin: http://localhost"));

            out.write(("PUT /flights/20261027_KTBR-KTBR.csv HTTP/1.1\r\n" + H
                    + "Content-Type: text/csv\r\nContent-Length: " + body.length() + "\r\n\r\n" + body)
                    .getBytes(StandardCharsets.ISO_8859_1));
            String put = readHead(in);
            assertTrue("response after the preflight starts with: " + put, put.startsWith("HTTP/1.1 201"));
        }
        assertEquals(body, new String(Files.readAllBytes(new File(flights, "20261027_KTBR-KTBR.csv").toPath()),
                StandardCharsets.UTF_8));
    }

    @Test
    public void bodiesStillGzipWhenAccepted() throws Exception {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(5000);
            s.getOutputStream().write(("GET /flights/20261027_1500Z.csv HTTP/1.1\r\n" + H + "\r\n")
                    .getBytes(StandardCharsets.ISO_8859_1));
            String head = readResponse(s.getInputStream());
            assertTrue(head, head.startsWith("HTTP/1.1 200"));
            assertTrue(head, head.toLowerCase().contains("content-encoding: gzip"));
        }
    }
}
