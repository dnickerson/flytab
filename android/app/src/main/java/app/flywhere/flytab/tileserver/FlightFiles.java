package app.flywhere.flytab.tileserver;

import java.util.regex.Pattern;

/**
 * Names accepted by GET /flights/logs (plain Java, no Android types, so the filter
 * can be checked off-device).
 */
final class FlightFiles {
    private FlightFiles() {}

    // Letters, digits, '_', '.', '-' then .ndjson: no '/', '\', spaces or control chars.
    private static final Pattern LOG_NAME = Pattern.compile("^[A-Za-z0-9_.-]+\\.ndjson$");

    /** A flight log (weather / traffic NDJSON) name that is safe to list and upload. */
    static boolean isLogName(String name) {
        return name != null
            && name.length() <= 200
            && !name.contains("..")
            && LOG_NAME.matcher(name).matches();
    }
}
