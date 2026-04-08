package app.flywhere.flytab.tileserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import fi.iki.elonen.NanoHTTPD;

/**
 * Lightweight local HTTP server that serves aviation data files
 * (tiles, plates, NASR) from the Android filesystem to the WebView.
 *
 * GET URL patterns:
 *   /tiles/sectional/{z}/{x}/{y}.webp
 *   /tiles/ifr-low/{z}/{x}/{y}.webp
 *   /plates/{icao}/{filename}
 *   /nasr/bundle.json
 *
 * PUT: saves request body to the same path on the filesystem.
 *   Used by layer-panel.js to cache tiles downloaded from the home server.
 */
public class TileServer extends NanoHTTPD {
    private final File baseDir;

    // MBTiles: open databases keyed by layer name (e.g. "sectional", "ifr-low")
    private final ConcurrentHashMap<String, SQLiteDatabase> mbtilesOpen = new ConcurrentHashMap<>();
    // Layers confirmed to have no .mbtiles file — skip filesystem check on every request
    private final Set<String> mbtilesAbsent = Collections.newSetFromMap(new ConcurrentHashMap<>());

    // Matches /tiles/{layer}/{z}/{x}/{y}.webp
    private static final String TAG = "TileServer";
    private static final Pattern TILE_PATTERN =
        Pattern.compile("^/tiles/([\\w-]+)/(\\d+)/(\\d+)/(\\d+)\\.webp$");

    public TileServer(int port, File baseDir) {
        super(port);
        this.baseDir = baseDir;
    }

    /** Close all open MBTiles databases. Call from plugin handleOnDestroy. */
    public void closeDatabases() {
        for (SQLiteDatabase db : mbtilesOpen.values()) {
            try { db.close(); } catch (Exception ignored) {}
        }
        mbtilesOpen.clear();
    }

    /**
     * Return an open read-only SQLiteDatabase for the given tile layer,
     * or null if no .mbtiles file exists for that layer.
     * Thread-safe: at most one database is opened per layer.
     */
    private SQLiteDatabase getMbtilesDb(String layer) {
        if (mbtilesAbsent.contains(layer)) return null;

        SQLiteDatabase db = mbtilesOpen.get(layer);
        if (db != null) return db;

        File dbFile = new File(baseDir, "tiles/" + layer + ".mbtiles");
        if (!dbFile.exists()) {
            mbtilesAbsent.add(layer);
            return null;
        }
        try {
            Log.i("TileServer", "Opening MBTiles: " + dbFile.getAbsolutePath()
                + " exists=" + dbFile.exists()
                + " canRead=" + dbFile.canRead()
                + " size=" + dbFile.length());
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null,
                SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS
            );
            Log.i("TileServer", "MBTiles opened OK: " + layer);
            SQLiteDatabase existing = mbtilesOpen.putIfAbsent(layer, db);
            if (existing != null) {
                db.close(); // another thread won the race
                return existing;
            }
            return db;
        } catch (Exception e) {
            Log.e("TileServer", "Failed to open MBTiles for " + layer
                + " at " + dbFile.getAbsolutePath(), e);
            mbtilesAbsent.add(layer);
            return null;
        }
    }

    /**
     * Serve a tile from MBTiles SQLite if available, otherwise fall back to filesystem.
     * MBTiles uses TMS y (flipped): tms_y = (2^z) - 1 - xyz_y
     */
    private Response serveTile(String layer, int z, int x, int yXyz) {
        SQLiteDatabase db = getMbtilesDb(layer);
        if (db != null) {
            int yTms = (1 << z) - 1 - yXyz;
            Cursor c = db.rawQuery(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                new String[]{String.valueOf(z), String.valueOf(x), String.valueOf(yTms)}
            );
            if (c.moveToFirst()) {
                byte[] data = c.getBlob(0);
                c.close();
                return newFixedLengthResponse(Response.Status.OK, "image/webp",
                    new ByteArrayInputStream(data), data.length);
            }
            c.close();
            // Tile not in MBTiles — fall through to filesystem (layer panel cached tiles)
        }
        // Filesystem fallback: serves tiles PUT by the layer panel
        return serveFile("/tiles/" + layer + "/" + z + "/" + x + "/" + yXyz + ".webp");
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        String method = session.getMethod().name();

        // CORS preflight
        if ("OPTIONS".equals(method)) {
            Response r = newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", "");
            addCors(r);
            return r;
        }

        Response response;
        if ("GET".equals(method) && "/terrain/grid/status".equals(uri)) {
            response = handleTerrainGridStatus();
        } else if ("GET".equals(method) && "/terrain/grid/terrain.json".equals(uri)) {
            response = serveFile("/terrain/terrain.json");
        } else if ("GET".equals(method) && "/terrain/grid/terrain.bin".equals(uri)) {
            response = serveFile("/terrain/terrain.bin");
        } else if ("GET".equals(method) && "/terrain/status".equals(uri)) {
            response = handleTerrainStatus();
        } else if ("GET".equals(method) && uri.startsWith("/terrain/profile")) {
            response = handleTerrainProfile(session);
        } else if ("GET".equals(method) && uri.matches("^/terrain/[A-Za-z0-9_+-]+\\.hgt$")) {
            response = serveFile(uri);
        } else if ("GET".equals(method) && "/mbtiles/status".equals(uri)) {
            response = handleMbtilesStatus();
        } else if ("POST".equals(method) && "/fetch-mbtiles".equals(uri)) {
            response = handleFetchMbtiles(session);
        } else if ("POST".equals(method) && "/fetch-zip".equals(uri)) {
            response = handleFetchZip(session);
        } else if ("POST".equals(method) && "/unzip".equals(uri)) {
            response = handleUnzip(session);
        } else if ("GET".equals(method) && uri.matches("^/plates/[^/]+/list$")) {
            response = handlePlatesList(uri);
        } else if ("GET".equals(method) && "/flights/list".equals(uri)) {
            response = handleFlightsList();
        } else if ("PUT".equals(method)) {
            response = handlePut(session, uri);
        } else if ("DELETE".equals(method)) {
            response = handleDelete(uri);
        } else {
            // Check for tile request — serve from MBTiles if available
            Matcher tileMatcher = TILE_PATTERN.matcher(uri);
            if (tileMatcher.matches()) {
                String layer = tileMatcher.group(1);
                int z = Integer.parseInt(tileMatcher.group(2));
                int x = Integer.parseInt(tileMatcher.group(3));
                int y = Integer.parseInt(tileMatcher.group(4));
                response = serveTile(layer, z, x, y);
            } else {
                response = serveFile(uri);
            }
        }
        addCors(response);
        return response;
    }

    private void addCors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, X-Append");
    }

    /**
     * GET /mbtiles/status — returns JSON array showing which .mbtiles files are on device.
     * [{"layer":"sectional","exists":true,"size_mb":2380},{"layer":"ifr-low","exists":false}]
     */
    private Response handleMbtilesStatus() {
        String[] layers = {"sectional", "ifr-low"};
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < layers.length; i++) {
            File f = new File(new File(baseDir, "tiles"), layers[i] + ".mbtiles");
            if (i > 0) sb.append(",");
            sb.append("{\"layer\":\"").append(layers[i]).append("\"");
            sb.append(",\"exists\":").append(f.exists());
            if (f.exists()) sb.append(",\"size_mb\":").append(f.length() / (1024 * 1024));
            sb.append("}");
        }
        sb.append("]");
        return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
    }

    /**
     * POST /fetch-mbtiles?layer={layer}&url={url}
     * Downloads an MBTiles file from the home server directly to tiles/{layer}.mbtiles.
     * Runs synchronously — JS caller should use a long timeout (10+ min for 2.4 GB).
     * Invalidates the SQLite cache so the new file is picked up immediately.
     */
    private Response handleFetchMbtiles(IHTTPSession session) {
        Map<String, java.util.List<String>> params = session.getParameters();
        java.util.List<String> layerList = params.get("layer");
        java.util.List<String> urlList   = params.get("url");

        String layer = (layerList != null && !layerList.isEmpty()) ? layerList.get(0) : null;
        String url   = (urlList   != null && !urlList.isEmpty())   ? urlList.get(0)   : null;

        if (layer == null || url == null || layer.contains("..") || layer.contains("/")) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain",
                "Missing or invalid layer/url params");
        }

        File outFile = new File(new File(baseDir, "tiles"), layer + ".mbtiles");
        outFile.getParentFile().mkdirs();

        // Evict cached database so the new file is used after download
        SQLiteDatabase oldDb = mbtilesOpen.remove(layer);
        if (oldDb != null) { try { oldDb.close(); } catch (Exception ignored) {} }
        mbtilesAbsent.remove(layer);

        try {
            java.net.URL parsedUrl = new java.net.URL(url);
            java.net.URLConnection rawConn = parsedUrl.openConnection();

            // For HTTPS on the local home server (self-signed cert), trust all certs.
            // This is safe because fetch-mbtiles is only called from the cockpit app
            // connecting to flypi.local on the user's own trusted network.
            if (rawConn instanceof javax.net.ssl.HttpsURLConnection) {
                javax.net.ssl.HttpsURLConnection https = (javax.net.ssl.HttpsURLConnection) rawConn;
                try {
                    javax.net.ssl.TrustManager[] trustAll = new javax.net.ssl.TrustManager[]{
                        new javax.net.ssl.X509TrustManager() {
                            public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                            public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
                            public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
                        }
                    };
                    javax.net.ssl.SSLContext sc = javax.net.ssl.SSLContext.getInstance("TLS");
                    sc.init(null, trustAll, new java.security.SecureRandom());
                    https.setSSLSocketFactory(sc.getSocketFactory());
                    https.setHostnameVerifier((h, s) -> true);
                } catch (Exception sslEx) {
                    Log.w(TAG, "Could not configure trust-all SSL: " + sslEx.getMessage());
                }
            }

            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) rawConn;
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(600000); // 10 min
            conn.connect();

            int code = conn.getResponseCode();
            if (code != 200) {
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                    "Server returned HTTP " + code);
            }

            long bytes = 0;
            byte[] buf = new byte[65536];
            try (java.io.InputStream in  = conn.getInputStream();
                 java.io.FileOutputStream out = new java.io.FileOutputStream(outFile)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    bytes += n;
                }
            }

            // Open the new database into cache
            getMbtilesDb(layer);

            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"ok\":true,\"layer\":\"" + layer + "\",\"bytes\":" + bytes + "}");

        } catch (Exception e) {
            outFile.delete(); // remove partial file
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                "Download failed: " + e.getMessage());
        }
    }

    /**
     * POST /fetch-zip?url={url}
     * Downloads a ZIP from the home server (trust-all TLS for self-signed cert),
     * streams it to a temp file, then extracts all entries relative to baseDir.
     * Used for bulk plate and data sync (e.g. plates_NC.zip → plates/KLKR/…).
     * Returns JSON: {"extracted": N, "bytes": B}
     */
    private Response handleFetchZip(IHTTPSession session) {
        Map<String, java.util.List<String>> params = session.getParameters();
        java.util.List<String> urlList = params.get("url");
        String url = (urlList != null && !urlList.isEmpty()) ? urlList.get(0) : null;

        if (url == null) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", "Missing url param");
        }

        File tempFile = new File(baseDir, "_fetch_zip_tmp.zip");
        try {
            // Download zip to temp file using trust-all TLS (same as fetch-mbtiles)
            java.net.URL parsedUrl = new java.net.URL(url);
            java.net.URLConnection rawConn = parsedUrl.openConnection();
            if (rawConn instanceof javax.net.ssl.HttpsURLConnection) {
                javax.net.ssl.HttpsURLConnection https = (javax.net.ssl.HttpsURLConnection) rawConn;
                try {
                    javax.net.ssl.TrustManager[] trustAll = new javax.net.ssl.TrustManager[]{
                        new javax.net.ssl.X509TrustManager() {
                            public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                            public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
                            public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
                        }
                    };
                    javax.net.ssl.SSLContext sc = javax.net.ssl.SSLContext.getInstance("TLS");
                    sc.init(null, trustAll, new java.security.SecureRandom());
                    https.setSSLSocketFactory(sc.getSocketFactory());
                    https.setHostnameVerifier((h, s) -> true);
                } catch (Exception sslEx) {
                    Log.w(TAG, "fetch-zip: could not configure trust-all SSL: " + sslEx.getMessage());
                }
            }

            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) rawConn;
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(600000); // 10 min
            conn.connect();

            int code = conn.getResponseCode();
            if (code != 200) {
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                    "Server returned HTTP " + code);
            }

            long bytes = 0;
            byte[] buf = new byte[65536];
            try (java.io.InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(tempFile)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    bytes += n;
                }
            }
            Log.i(TAG, "fetch-zip: downloaded " + bytes + " bytes to " + tempFile.getAbsolutePath());

            // Extract zip relative to baseDir
            int extracted = 0;
            byte[] xbuf = new byte[8192];
            try (ZipInputStream zis = new ZipInputStream(new FileInputStream(tempFile))) {
                ZipEntry entry;
                while ((entry = zis.getNextEntry()) != null) {
                    if (entry.isDirectory()) { zis.closeEntry(); continue; }
                    String name = entry.getName();
                    if (name.contains("..")) { zis.closeEntry(); continue; }

                    File outFile = new File(baseDir, name);
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();

                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        int n;
                        while ((n = zis.read(xbuf)) > 0) fos.write(xbuf, 0, n);
                    }
                    extracted++;
                    zis.closeEntry();
                }
            }
            Log.i(TAG, "fetch-zip: extracted " + extracted + " files");
            tempFile.delete();

            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"extracted\":" + extracted + ",\"bytes\":" + bytes + "}");

        } catch (Exception e) {
            if (tempFile.exists()) tempFile.delete();
            Log.e(TAG, "fetch-zip failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                "fetch-zip failed: " + e.getMessage());
        }
    }

    /**
     * POST /unzip — accepts a ZIP file body and extracts all entries to the filesystem.
     * ZIP paths are relative to baseDir (e.g. tiles/sectional/7/34/52.webp).
     * Returns JSON: {"extracted": N}
     */
    private Response handleUnzip(IHTTPSession session) {
        try {
            // NanoHTTPD requires parseBody for POST
            Map<String, String> bodyMap = new HashMap<>();
            session.parseBody(bodyMap);

            String tempFilePath = bodyMap.get("content");
            if (tempFilePath == null) {
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain",
                    "No body received");
            }

            File tempFile = new File(tempFilePath);
            if (!tempFile.exists()) {
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain",
                    "Temp file missing");
            }

            int extracted = 0;
            try (ZipInputStream zis = new ZipInputStream(new FileInputStream(tempFile))) {
                ZipEntry entry;
                byte[] buf = new byte[8192];
                while ((entry = zis.getNextEntry()) != null) {
                    if (entry.isDirectory()) continue;
                    String name = entry.getName();
                    // Security: skip entries with path traversal
                    if (name.contains("..")) continue;

                    File outFile = new File(baseDir, name);
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();

                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        int n;
                        while ((n = zis.read(buf)) > 0) {
                            fos.write(buf, 0, n);
                        }
                    }
                    extracted++;
                    zis.closeEntry();
                }
            }
            tempFile.delete();

            String json = "{\"extracted\":" + extracted + "}";
            return newFixedLengthResponse(Response.Status.OK, "application/json", json);
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                "Unzip failed: " + e.getMessage());
        }
    }

    /**
     * GET /plates/{icao}/list
     * Returns JSON array of human-readable plate PDF filenames for an airport.
     * Only lowercase .pdf files are returned — these are the renamed, readable versions.
     * Raw FAA code files (uppercase .PDF) are excluded.
     */
    private Response handlePlatesList(String uri) {
        String[] parts = uri.split("/");
        if (parts.length < 3) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", "Bad request");
        }
        String icao = parts[2].toUpperCase();
        if (icao.contains("..") || icao.isEmpty()) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden");
        }

        File platesDir = new File(new File(baseDir, "plates"), icao);
        if (!platesDir.isDirectory()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
        }

        File[] files = platesDir.listFiles();
        if (files == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
        }

        java.util.List<String> pdfs = new java.util.ArrayList<>();
        for (File f : files) {
            if (f.isFile() && f.getName().endsWith(".pdf")) {
                pdfs.add(f.getName());
            }
        }
        java.util.Collections.sort(pdfs);

        if (pdfs.isEmpty()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "No plates");
        }

        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < pdfs.size(); i++) {
            if (i > 0) sb.append(",");
            String escaped = pdfs.get(i).replace("\\", "\\\\").replace("\"", "\\\"");
            sb.append("\"").append(escaped).append("\"");
        }
        sb.append("]");
        return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
    }

    /**
     * GET /flights/list
     * Returns JSON array of flight CSV filenames sorted newest-first.
     */
    private Response handleFlightsList() {
        File flightsDir = new File(baseDir, "flights");
        if (!flightsDir.isDirectory()) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
        }
        File[] files = flightsDir.listFiles();
        if (files == null || files.length == 0) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
        }
        java.util.List<String> csvs = new java.util.ArrayList<>();
        for (File f : files) {
            if (f.isFile() && f.getName().toLowerCase().endsWith(".csv")) {
                csvs.add(f.getName());
            }
        }
        java.util.Collections.sort(csvs, java.util.Collections.reverseOrder());
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < csvs.size(); i++) {
            if (i > 0) sb.append(",");
            String escaped = csvs.get(i).replace("\\", "\\\\").replace("\"", "\\\"");
            sb.append("\"").append(escaped).append("\"");
        }
        sb.append("]");
        return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
    }

    private Response handlePut(IHTTPSession session, String uri) {
        // Prevent path traversal
        if (uri.contains("..")) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden");
        }

        String path = uri.startsWith("/") ? uri.substring(1) : uri;
        File file = new File(baseDir, path);

        try {
            // Parse body — NanoHTTPD requires this for PUT/POST
            Map<String, String> bodyMap = new HashMap<>();
            session.parseBody(bodyMap);

            // Create parent directories
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            // Get content length
            long contentLength = 0;
            String clHeader = session.getHeaders().get("content-length");
            if (clHeader != null) {
                contentLength = Long.parseLong(clHeader);
            }

            // Check for append mode (X-Append: true header)
            boolean appendMode = "true".equalsIgnoreCase(
                session.getHeaders().get("x-append"));

            // Write body to file
            // NanoHTTPD already parsed the body into a temp file — use that
            String tempFilePath = bodyMap.get("content");
            if (tempFilePath != null) {
                File tempFile = new File(tempFilePath);
                if (tempFile.exists()) {
                    try (FileInputStream fis = new FileInputStream(tempFile);
                         FileOutputStream fos = new FileOutputStream(file, appendMode)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = fis.read(buf)) > 0) {
                            fos.write(buf, 0, n);
                        }
                    }
                    tempFile.delete();
                }
            }

            return newFixedLengthResponse(Response.Status.CREATED, "text/plain", "OK");
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                "Write failed: " + e.getMessage());
        }
    }

    private Response handleDelete(String uri) {
        if (uri.contains("..")) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden");
        }
        String path = uri.startsWith("/") ? uri.substring(1) : uri;
        File file = new File(baseDir, path);
        if (!file.exists()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
        }
        if (file.delete()) {
            return newFixedLengthResponse(Response.Status.OK, "text/plain", "Deleted");
        }
        return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "Delete failed");
    }

    private Response serveFile(String uri) {
        // Prevent path traversal
        if (uri.contains("..")) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden");
        }

        // Strip leading slash and resolve against base directory
        String path = uri.startsWith("/") ? uri.substring(1) : uri;
        File file = new File(baseDir, path);

        if (!file.exists() || !file.isFile()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found: " + uri);
        }

        // Determine MIME type
        String mime = getMimeType(uri);

        try {
            FileInputStream fis = new FileInputStream(file);
            return newFixedLengthResponse(Response.Status.OK, mime, fis, file.length());
        } catch (FileNotFoundException e) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
        }
    }

    /**
     * GET /terrain/grid/status
     * Returns { exists, sizeMb, builtAt } for the terrain grid binary.
     */
    private Response handleTerrainGridStatus() {
        File binFile  = new File(new File(baseDir, "terrain"), "terrain.bin");
        File jsonFile = new File(new File(baseDir, "terrain"), "terrain.json");
        boolean exists = binFile.exists() && binFile.isFile()
                      && jsonFile.exists() && jsonFile.isFile();
        double sizeMb = exists ? binFile.length() / (1024.0 * 1024.0) : 0.0;
        String builtAt = null;
        if (exists) {
            try {
                // Parse builtAt from terrain.json — simple string search to avoid a full JSON lib
                java.io.FileInputStream fis = new java.io.FileInputStream(jsonFile);
                byte[] bytes = new byte[(int) jsonFile.length()];
                fis.read(bytes);
                fis.close();
                String content = new String(bytes, "UTF-8");
                // Extract "builtAt": "value"
                int idx = content.indexOf("\"builtAt\"");
                if (idx >= 0) {
                    int q1 = content.indexOf('"', idx + 9);
                    if (q1 >= 0) {
                        int q2 = content.indexOf('"', q1 + 1);
                        if (q2 > q1) {
                            builtAt = content.substring(q1 + 1, q2);
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "handleTerrainGridStatus: could not read terrain.json: " + e.getMessage());
            }
        }
        String json = String.format("{\"exists\":%b,\"sizeMb\":%.1f,\"builtAt\":%s}",
            exists, sizeMb, builtAt != null ? "\"" + builtAt + "\"" : "null");
        return newFixedLengthResponse(Response.Status.OK, "application/json", json);
    }

    /**
     * GET /terrain/status
     * Returns { tileCount, totalSizeMb, hasTerrain } for the terrain/srtm/ directory.
     */
    private Response handleTerrainStatus() {
        File terrainDir = new File(new File(baseDir, "terrain"), "srtm");
        int count = 0;
        long totalBytes = 0;
        if (terrainDir.isDirectory()) {
            File[] files = terrainDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && f.getName().toUpperCase().endsWith(".HGT")) {
                        count++;
                        totalBytes += f.length();
                    }
                }
            }
        }
        // Also check terrain/ root (flat layout)
        File terrainRoot = new File(baseDir, "terrain");
        if (terrainRoot.isDirectory()) {
            File[] files = terrainRoot.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && f.getName().toUpperCase().endsWith(".HGT")) {
                        count++;
                        totalBytes += f.length();
                    }
                }
            }
        }
        double sizeMb = totalBytes / (1024.0 * 1024.0);
        String json = String.format("{\"tileCount\":%d,\"totalSizeMb\":%.1f,\"hasTerrain\":%b}",
            count, sizeMb, count > 0);
        return newFixedLengthResponse(Response.Status.OK, "application/json", json);
    }

    /**
     * GET /terrain/profile?points=lat1,lon1|lat2,lon2|...
     * Returns { profile: [{dist_nm, elev_ft}] } sampled every ~2 NM.
     */
    private Response handleTerrainProfile(IHTTPSession session) {
        Map<String, List<String>> params = session.getParameters();
        List<String> ptsList = params.get("points");
        String pointsStr = (ptsList != null && !ptsList.isEmpty()) ? ptsList.get(0) : "";

        if (pointsStr.isEmpty()) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"profile\":[]}");
        }

        // Parse lat,lon pairs
        List<double[]> points = new ArrayList<>();
        for (String pair : pointsStr.split("\\|")) {
            String[] parts = pair.split(",");
            if (parts.length == 2) {
                try {
                    double lat = Double.parseDouble(parts[0].trim());
                    double lon = Double.parseDouble(parts[1].trim());
                    points.add(new double[]{lat, lon});
                } catch (NumberFormatException ignored) {}
            }
        }

        if (points.size() < 2) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"profile\":[]}");
        }

        final double STEP_NM = 2.0;
        StringBuilder sb = new StringBuilder("{\"profile\":[");
        Map<String, RandomAccessFile> rafCache = new HashMap<>();
        double cumDist = 0.0;
        boolean first = true;

        try {
            for (int i = 0; i < points.size() - 1; i++) {
                double lat1 = points.get(i)[0],    lon1 = points.get(i)[1];
                double lat2 = points.get(i + 1)[0], lon2 = points.get(i + 1)[1];
                double segDist = haversineNm(lat1, lon1, lat2, lon2);
                if (segDist < 0.001) continue;

                int steps = Math.max(1, (int) Math.ceil(segDist / STEP_NM));
                for (int s = 0; s < steps; s++) {
                    double frac = (double) s / steps;
                    double lat  = lat1 + frac * (lat2 - lat1);
                    double lon  = lon1 + frac * (lon2 - lon1);
                    double dist = cumDist + frac * segDist;
                    double elev = srtmElev(lat, lon, rafCache);
                    if (!first) sb.append(",");
                    sb.append(String.format("{\"dist_nm\":%.2f,\"elev_ft\":%.0f}", dist, elev));
                    first = false;
                }
                cumDist += segDist;
            }
            // Final point
            double[] last = points.get(points.size() - 1);
            double elev = srtmElev(last[0], last[1], rafCache);
            if (!first) sb.append(",");
            sb.append(String.format("{\"dist_nm\":%.2f,\"elev_ft\":%.0f}", cumDist, elev));
        } finally {
            for (RandomAccessFile raf : rafCache.values()) {
                if (raf != null) try { raf.close(); } catch (Exception ignored) {}
            }
        }

        sb.append("]}");
        return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
    }

    private double haversineNm(double lat1, double lon1, double lat2, double lon2) {
        final double R = 3440.065;
        double dlat = Math.toRadians(lat2 - lat1);
        double dlon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dlat / 2) * Math.sin(dlat / 2)
                 + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                 * Math.sin(dlon / 2) * Math.sin(dlon / 2);
        return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
    }

    /**
     * Sample elevation from a local SRTM .hgt file using RandomAccessFile (no full-file load).
     * Files are looked up in terrain/srtm/ and terrain/ (flat fallback).
     * rafCache maps filename → open RAF (null = tile absent).
     */
    private double srtmElev(double lat, double lon, Map<String, RandomAccessFile> rafCache) {
        int tileLat = (int) Math.floor(lat);
        int tileLon = (int) Math.floor(lon);
        String ns   = tileLat >= 0 ? "N" : "S";
        String ew   = tileLon <  0 ? "W" : "E";
        String fname = String.format("%s%02d%s%03d.hgt", ns, Math.abs(tileLat), ew, Math.abs(tileLon));

        RandomAccessFile raf;
        if (rafCache.containsKey(fname)) {
            raf = rafCache.get(fname);
        } else {
            raf = null;
            // Search terrain/srtm/ then terrain/
            File[] searchDirs = {
                new File(new File(baseDir, "terrain"), "srtm"),
                new File(baseDir, "terrain"),
            };
            outer:
            for (File dir : searchDirs) {
                if (!dir.isDirectory()) continue;
                File[] files = dir.listFiles();
                if (files == null) continue;
                for (File f : files) {
                    if (f.getName().equalsIgnoreCase(fname)) {
                        try { raf = new RandomAccessFile(f, "r"); } catch (Exception ignored) {}
                        break outer;
                    }
                }
            }
            rafCache.put(fname, raf);
        }

        if (raf == null) return 0.0;

        int row = (int) Math.round((tileLat + 1 - lat) * 3600);
        int col = (int) Math.round((lon - tileLon) * 3600);
        row = Math.max(0, Math.min(3600, row));
        col = Math.max(0, Math.min(3600, col));
        long offset = ((long) row * 3601 + col) * 2;

        try {
            raf.seek(offset);
            int b0 = raf.read();
            int b1 = raf.read();
            if (b0 < 0 || b1 < 0) return 0.0;
            short elevM = (short) ((b0 << 8) | b1);
            if (elevM == -32768) return 0.0;
            return elevM * 3.28084;
        } catch (Exception e) {
            return 0.0;
        }
    }

    private String getMimeType(String uri) {
        if (uri.endsWith(".webp")) return "image/webp";
        if (uri.endsWith(".png")) return "image/png";
        if (uri.endsWith(".jpg") || uri.endsWith(".jpeg")) return "image/jpeg";
        if (uri.endsWith(".json")) return "application/json";
        if (uri.endsWith(".gz")) return "application/gzip";
        if (uri.endsWith(".pdf")) return "application/pdf";
        if (uri.endsWith(".csv")) return "text/csv";
        return "application/octet-stream";
    }
}
