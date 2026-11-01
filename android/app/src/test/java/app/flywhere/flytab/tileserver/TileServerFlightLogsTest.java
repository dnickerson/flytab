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
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * GET /flights/logs lists the flights folder's weather / traffic NDJSON logs,
 * including ones with no matching CSV, so Upload All can send a log that kept its
 * start-time name. Unsafe names and symbolic links are left out. /flights/list
 * (CSVs, used by Flight Upload and the fuel overlay) is unchanged.
 */
public class TileServerFlightLogsTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private TileServer server;
    private int port;
    private File flights;
    private File outside;

    private void touch(File f, String body) throws Exception {
        Files.write(f.toPath(), body.getBytes(StandardCharsets.UTF_8));
    }

    @Before
    public void setUp() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) { port = s.getLocalPort(); }
        File base = tmp.newFolder("FlyTab");
        flights = new File(base, "flights");
        assertTrue(flights.mkdirs());
        outside = tmp.newFolder("elsewhere");

        touch(new File(flights, "20261101_KLKR-KFDK.csv"), "a\n");
        touch(new File(flights, "20261101_1430Z.CSV"), "b\n");
        touch(new File(flights, "20261101_KLKR-KFDK_weather.ndjson"), "{}\n");
        touch(new File(flights, "20261101_1430Z_weather.ndjson"), "{}\n");   // orphan: no CSV
        touch(new File(flights, "20261101_1430Z_traffic.ndjson"), "{}\n");
        // excluded
        touch(new File(flights, "a b_weather.ndjson"), "{}\n");
        touch(new File(flights, "a..b_weather.ndjson"), "{}\n");
        touch(new File(flights, "X_weather.NDJSON"), "{}\n");
        touch(new File(flights, "x_weather.ndjson.tmp"), "{}\n");
        touch(new File(flights, "notes.txt"), "x\n");
        assertTrue(new File(flights, "dir_weather.ndjson").mkdir());
        File secret = new File(outside, "secret.txt");
        touch(secret, "do not upload\n");
        Files.createSymbolicLink(new File(flights, "link_weather.ndjson").toPath(), secret.toPath());
        Files.createSymbolicLink(new File(flights, "samedir_traffic.ndjson").toPath(),
                new File(flights, "20261101_1430Z_traffic.ndjson").toPath());

        server = new TileServer(port, base);
        server.start(5000, false);
    }

    @After
    public void tearDown() {
        if (server != null) server.stop();
    }

    private String get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        assertEquals(200, c.getResponseCode());
        assertTrue(c.getContentType().startsWith("application/json"));
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static List<String> names(String json) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\"name\":\"([^\"]*)\"").matcher(json);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    @Test
    public void logsListsSafeNdjsonFilesOnly() throws Exception {
        List<String> got = names(get("/flights/logs"));
        List<String> want = new ArrayList<>(java.util.Arrays.asList(
                "20261101_KLKR-KFDK_weather.ndjson", "20261101_1430Z_weather.ndjson", "20261101_1430Z_traffic.ndjson"));
        Collections.sort(want, Collections.reverseOrder());      // newest-name first, as /flights/list
        assertEquals(want, got);
    }

    @Test
    public void symbolicLinksAreLeftOut() throws Exception {
        String json = get("/flights/logs");
        assertFalse(json.contains("link_weather.ndjson"));
        assertFalse("a link to a file in the same folder too", json.contains("samedir_traffic.ndjson"));
    }

    @Test
    public void logsEntriesHaveTheListShape() throws Exception {
        String json = get("/flights/logs");
        assertTrue(json, json.matches("^\\[(\\{\"name\":\"[^\"]+\",\"size_bytes\":\\d+,\"modified_ms\":\\d+\\},?)+\\]$"));
    }

    @Test
    public void flightsListIsUnchanged() throws Exception {
        String json = get("/flights/list");
        assertEquals(java.util.Arrays.asList("20261101_KLKR-KFDK.csv", "20261101_1430Z.CSV"), names(json));
        File csv = new File(flights, "20261101_KLKR-KFDK.csv");
        File csv2 = new File(flights, "20261101_1430Z.CSV");
        assertEquals("[{\"name\":\"20261101_KLKR-KFDK.csv\",\"size_bytes\":2,\"modified_ms\":" + csv.lastModified() + "},"
                + "{\"name\":\"20261101_1430Z.CSV\",\"size_bytes\":2,\"modified_ms\":" + csv2.lastModified() + "}]", json);
    }

    @Test
    public void flightFilesFilter() throws Exception {
        assertTrue(FlightFiles.isLogName("20261101_1430Z_weather.ndjson"));
        for (String bad : new String[]{null, "", ".ndjson".substring(1), "a b.ndjson", "a..b.ndjson", "../x.ndjson",
                "a/b.ndjson", "x.NDJSON", "x.ndjson.tmp", "x.txt"}) {
            assertFalse(String.valueOf(bad), FlightFiles.isLogName(bad));
        }
        assertTrue(FlightFiles.isPlainFileIn(flights, new File(flights, "20261101_1430Z_weather.ndjson")));
        assertFalse(FlightFiles.isPlainFileIn(flights, new File(flights, "link_weather.ndjson")));
        assertFalse(FlightFiles.isPlainFileIn(flights, new File(flights, "dir_weather.ndjson")));
        assertFalse(FlightFiles.isPlainFileIn(flights, new File(flights, "missing.ndjson")));
        assertTrue("a file not yet written", FlightFiles.isDirectChild(flights, new File(flights, "new.apk")));
        assertFalse(FlightFiles.isDirectChild(flights, new File(flights, "../elsewhere/secret.txt")));
    }
}
