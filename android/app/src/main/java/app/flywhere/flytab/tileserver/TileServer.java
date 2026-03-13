package app.flywhere.flytab.tileserver;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
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

    public TileServer(int port, File baseDir) {
        super(port);
        this.baseDir = baseDir;
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
        if ("POST".equals(method) && "/unzip".equals(uri)) {
            response = handleUnzip(session);
        } else if ("PUT".equals(method)) {
            response = handlePut(session, uri);
        } else if ("DELETE".equals(method)) {
            response = handleDelete(uri);
        } else {
            response = serveFile(uri);
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
                    FileInputStream fis = new FileInputStream(tempFile);
                    FileOutputStream fos = new FileOutputStream(file, appendMode);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = fis.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                    }
                    fos.close();
                    fis.close();
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
