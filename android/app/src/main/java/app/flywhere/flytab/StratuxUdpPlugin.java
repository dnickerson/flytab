package app.flywhere.flytab;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;

/**
 * GDL 90 over UDP — primary transport for ownship + traffic in v7.00+.
 *
 * Stratux unicasts GDL 90 frames to every DHCP client on its AP. We bind a UDP
 * socket on the configured port (default 4000) and parse incoming frames into
 * Stratux WebSocket-compatible JSON objects so stratux-client.js consumers
 * (_handleTraffic, _handleSituation) work unchanged.
 *
 * Why UDP/GDL 90 vs. JSON-over-WebSocket: no connection state to get stuck —
 * a brief Wi-Fi glitch causes a few packets to drop, then the next one arrives.
 * No half-closed-TCP problem, no head-of-line blocking, no in-band keepalive
 * needed. This is what every native EFB app does for cockpit-critical data.
 *
 * JS API:
 *   StratuxUDP.start({ port })   // begin listening
 *   StratuxUDP.stop()
 *   StratuxUDP.addListener('situation', cb)   // payload mirrors Stratux WS situation
 *   StratuxUDP.addListener('traffic',   cb)   // payload mirrors Stratux WS traffic
 *   StratuxUDP.addListener('heartbeat', cb)   // {gps_valid, ahrs_valid}
 */
@CapacitorPlugin(name = "StratuxUDP")
public class StratuxUdpPlugin extends Plugin {
    private static final String TAG = "StratuxUDP";

    // ---- GDL 90 message IDs ----
    private static final int MSG_HEARTBEAT       = 0x00;
    private static final int MSG_OWNSHIP         = 0x0A;
    private static final int MSG_OWNSHIP_GEO_ALT = 0x0B;
    private static final int MSG_TRAFFIC         = 0x14;
    private static final int MSG_FOREFLIGHT_EXT  = 0x65;
    private static final int MSG_STRATUX_HB      = 0xCC;

    // ---- Socket lifecycle ----
    private DatagramSocket socket;
    private Thread rxThread;
    private volatile boolean running;

    // ---- Counters for diagnostics ----
    private volatile long datagramsReceived;
    private volatile long framesParsed;
    private volatile long crcFailures;
    private volatile long lastDatagramFrom;  // hash of source IP for sanity

    // ---- Aggregated situation state (combined from ownship + geo_alt + ahrs + hb) ----
    // Using doubles because Stratux WS uses unrestricted numeric JSON values and
    // downstream consumers don't care about precision beyond what GDL 90 carries.
    private final Object stateLock = new Object();
    private Double sLat, sLon, sBaroAlt, sGsKt, sTrack, sVvel, sGeoAlt;
    private Double sPitch, sRoll, sHdgMag, sIas, sTas;
    private Boolean sGpsValid;
    private Boolean sAirborne;
    private long lastOwnshipAt = 0;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) { call.resolve(); return; }
        int port = call.getInt("port", 4000);
        try {
            socket = new DatagramSocket(port);
            socket.setReuseAddress(true);
        } catch (Exception e) {
            call.reject("bind failed: " + e.getMessage());
            return;
        }
        running = true;
        rxThread = new Thread(this::receiveLoop, "StratuxUDP-rx");
        rxThread.setDaemon(true);
        rxThread.start();
        Log.i(TAG, "listening on UDP :" + port);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        if (socket != null) { try { socket.close(); } catch (Exception ignored) {} socket = null; }
        if (rxThread != null) { try { rxThread.join(500); } catch (InterruptedException ignored) {} rxThread = null; }
        call.resolve();
    }

    @PluginMethod
    public void getStats(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running",            running);
        ret.put("datagramsReceived",  datagramsReceived);
        ret.put("framesParsed",       framesParsed);
        ret.put("crcFailures",        crcFailures);
        ret.put("lastDatagramFrom",   lastDatagramFrom);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        if (socket != null) try { socket.close(); } catch (Exception ignored) {}
    }

    // ===========================================================================
    // Receive loop
    // ===========================================================================

    private void receiveLoop() {
        byte[] buf = new byte[2048];
        DatagramPacket packet = new DatagramPacket(buf, buf.length);
        while (running) {
            try {
                socket.receive(packet);
                datagramsReceived++;
                if (packet.getAddress() != null) {
                    // Pack the last source IP into a long for cheap diag readout.
                    byte[] addr = packet.getAddress().getAddress();
                    if (addr != null && addr.length == 4) {
                        lastDatagramFrom = ((addr[0] & 0xFFL) << 24) | ((addr[1] & 0xFFL) << 16)
                                         | ((addr[2] & 0xFFL) << 8)  |  (addr[3] & 0xFFL);
                    }
                }
                if (datagramsReceived == 1) {
                    Log.i(TAG, "first datagram from " + packet.getAddress() + " len=" + packet.getLength());
                }
                handleDatagram(packet.getData(), packet.getLength());
            } catch (Exception e) {
                if (running) Log.w(TAG, "rx err: " + e.getMessage());
            }
        }
    }

    /** A datagram may contain a single GDL 90 frame, or several concatenated. */
    private void handleDatagram(byte[] data, int len) {
        int i = 0;
        while (i < len) {
            while (i < len && (data[i] & 0xFF) != 0x7E) i++;
            if (i >= len) return;
            int start = i + 1;
            i++;
            while (i < len && (data[i] & 0xFF) != 0x7E) i++;
            if (i >= len) return;
            int end = i;
            i++;
            if (end - start >= 3) processFrame(data, start, end - start);
        }
    }

    /** Validate and dispatch a single de-stuffed GDL 90 frame (between 0x7E flags). */
    private void processFrame(byte[] data, int offset, int length) {
        byte[] payload = destuff(data, offset, length);
        if (payload.length < 3) return;
        int crcLen = payload.length - 2;
        int crcRecv = (payload[crcLen] & 0xFF) | ((payload[crcLen + 1] & 0xFF) << 8);
        int crcCalc = crcCcitt(payload, 0, crcLen);
        if (crcRecv != crcCalc) {
            crcFailures++;
            return;
        }
        framesParsed++;
        int msgId = payload[0] & 0xFF;
        try {
            switch (msgId) {
                case MSG_HEARTBEAT:       parseHeartbeat(payload, crcLen); break;
                case MSG_OWNSHIP:         parseOwnshipOrTraffic(payload, crcLen, true); break;
                case MSG_OWNSHIP_GEO_ALT: parseGeoAlt(payload, crcLen); break;
                case MSG_TRAFFIC:         parseOwnshipOrTraffic(payload, crcLen, false); break;
                case MSG_FOREFLIGHT_EXT:  parseFFExt(payload, crcLen); break;
                case MSG_STRATUX_HB:      parseStratuxHb(payload, crcLen); break;
                default: /* unknown msg — ignore */ break;
            }
        } catch (Exception e) {
            Log.w(TAG, "parse err msg=0x" + Integer.toHexString(msgId) + ": " + e.getMessage());
        }
    }

    // ===========================================================================
    // Framing helpers
    // ===========================================================================

    /** Reverse byte-stuffing: 0x7D xx → (xx XOR 0x20). */
    private static byte[] destuff(byte[] in, int offset, int length) {
        byte[] out = new byte[length];
        int n = 0;
        for (int j = 0; j < length; j++) {
            int b = in[offset + j] & 0xFF;
            if (b == 0x7D && j + 1 < length) {
                j++;
                out[n++] = (byte) ((in[offset + j] & 0xFF) ^ 0x20);
            } else {
                out[n++] = (byte) b;
            }
        }
        byte[] trimmed = new byte[n];
        System.arraycopy(out, 0, trimmed, 0, n);
        return trimmed;
    }

    /** CRC-16-CCITT, poly 0x1021, init 0x0000, MSB-first, no reflection. */
    private static int crcCcitt(byte[] data, int offset, int length) {
        int crc = 0;
        for (int i = 0; i < length; i++) {
            crc ^= (data[offset + i] & 0xFF) << 8;
            for (int b = 0; b < 8; b++) {
                if ((crc & 0x8000) != 0) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
                else                     crc = (crc << 1) & 0xFFFF;
            }
        }
        return crc;
    }

    // ===========================================================================
    // Message parsers
    // ===========================================================================

    /** Heartbeat (msg 0x00, 7 bytes). Status1 bit-7 = GPS Position Valid. */
    private void parseHeartbeat(byte[] p, int len) {
        if (len < 7) return;
        boolean gpsValid = (p[1] & 0x80) != 0;
        synchronized (stateLock) { sGpsValid = gpsValid; }
        // Inform JS at heartbeat cadence (1 Hz).
        JSObject ev = new JSObject();
        ev.put("gps_valid", gpsValid);
        notifyListeners("heartbeat", ev);
    }

    /**
     * Ownship Report (0x0A) and Traffic Report (0x14) share the same 28-byte payload.
     * @param ownship true for 0x0A (updates aggregated situation state), false for 0x14 (emits a traffic event).
     */
    private void parseOwnshipOrTraffic(byte[] p, int len, boolean ownship) {
        if (len < 28) return;

        // [1] hi nibble = traffic alert status, lo nibble = address type
        int addrType = p[1] & 0x0F;

        // [2..4] 24-bit ICAO address, big-endian
        int icao = ((p[2] & 0xFF) << 16) | ((p[3] & 0xFF) << 8) | (p[4] & 0xFF);

        // [5..7] latitude semicircles, [8..10] longitude semicircles. Big-endian, signed 24-bit.
        double lat = decodeSemicircle(p, 5);
        double lon = decodeSemicircle(p, 8);

        // [11..12] altitude (12 bits) + misc (4 bits)
        int altRaw = ((p[11] & 0xFF) << 4) | ((p[12] & 0xF0) >> 4);
        Double altFt = (altRaw == 0xFFF) ? null : (double) (altRaw * 25 - 1000);
        int misc = p[12] & 0x0F;
        boolean airborne = (misc & 0x02) != 0;

        // [13] hi nibble = NIC, lo nibble = NACp (we don't surface these)

        // [14..16] 12-bit hVel kt + 12-bit vVel (64 fpm units, signed)
        int hVel = ((p[14] & 0xFF) << 4) | ((p[15] & 0xF0) >> 4);
        int vVelRaw12 = ((p[15] & 0x0F) << 8) | (p[16] & 0xFF);
        Double speedKt = (hVel == 0xFFF) ? null : (double) hVel;
        // vVel sentinel (0x800 raw = "no data") must be checked BEFORE sign-extending,
        // because after sign extension 0x800 becomes -2048 — a value we'd otherwise
        // report as -131072 fpm.
        Double vvelFpm;
        if (vVelRaw12 == 0x800) {
            vvelFpm = null;
        } else {
            int vVel = vVelRaw12;
            if ((vVel & 0x800) != 0) vVel -= 0x1000;  // sign-extend 12-bit
            vvelFpm = (double) (vVel * 64);
        }

        // [17] track/heading 360/256 deg/LSB
        double track = (p[17] & 0xFF) * 360.0 / 256.0;

        // [18] emitter category (we don't surface)

        // [19..26] 8-byte ASCII callsign, space-padded
        StringBuilder cs = new StringBuilder(8);
        for (int j = 19; j < 27; j++) cs.append((char) (p[j] & 0xFF));
        String callsign = cs.toString().trim();

        if (ownship) {
            synchronized (stateLock) {
                // Stratux sends lat=0,lon=0 when GPS hasn't acquired a fix yet.
                // Don't overwrite a previously valid position with the 0,0 sentinel —
                // map-level consumers gate on gps_fix_quality, but route-table and
                // other consumers may not, and "ownship at 0,0" would jump the map.
                if (lat != 0.0 || lon != 0.0) {
                    sLat = lat;
                    sLon = lon;
                }
                sBaroAlt = altFt;
                sGsKt = speedKt;
                sVvel = vvelFpm;
                sTrack = track;
                sAirborne = airborne;
                lastOwnshipAt = System.currentTimeMillis();
            }
            emitSituation();
            return;
        }

        // Traffic: shape payload to match Stratux's WS /traffic JSON so
        // _handleTraffic in stratux-client.js works unchanged.
        JSObject ev = new JSObject();
        ev.put("Icao_addr", icao);
        ev.put("Addr_type", addrType);
        ev.put("Tail", callsign);
        if (lat != 0.0 || lon != 0.0) { ev.put("Lat", lat); ev.put("Lng", lon); }
        if (altFt != null)   ev.put("Alt", altFt);
        if (speedKt != null) ev.put("Speed", speedKt);
        if (vvelFpm != null) ev.put("Vvel", vvelFpm);
        ev.put("Track", track);
        ev.put("OnGround", !airborne);
        ev.put("ExtrapolatedPosition", false);
        notifyListeners("traffic", ev);
    }

    /** Decode 24-bit signed two's-complement semicircle starting at offset. */
    private static double decodeSemicircle(byte[] p, int off) {
        int v = ((p[off] & 0xFF) << 16) | ((p[off + 1] & 0xFF) << 8) | (p[off + 2] & 0xFF);
        if ((v & 0x800000) != 0) v |= 0xFF000000;  // sign-extend
        return v * (180.0 / (1 << 23));
    }

    /** Ownship Geometric Altitude (0x0B): bytes 1-2 = signed int16 * 5 ft. */
    private void parseGeoAlt(byte[] p, int len) {
        if (len < 5) return;
        int v = ((p[1] & 0xFF) << 8) | (p[2] & 0xFF);
        if ((v & 0x8000) != 0) v -= 0x10000;
        double altFt = v * 5.0;
        synchronized (stateLock) { sGeoAlt = altFt; }
        emitSituation();
    }

    /** ForeFlight extension (0x65). Sub-ID 0x01 = AHRS. */
    private void parseFFExt(byte[] p, int len) {
        if (len < 2) return;
        int sub = p[1] & 0xFF;
        if (sub != 0x01) return;  // ID message ignored
        if (len < 12) return;
        // Big-endian signed int16 fields.
        int rollRaw  = signed16(p, 2);
        int pitchRaw = signed16(p, 4);
        int hdgRaw   = (p[6] & 0xFF) << 8 | (p[7] & 0xFF);
        boolean magnetic = (hdgRaw & 0x8000) != 0;
        int hdgVal = hdgRaw & 0x7FFF;
        int iasRaw = (p[8] & 0xFF) << 8 | (p[9] & 0xFF);
        int tasRaw = (p[10] & 0xFF) << 8 | (p[11] & 0xFF);

        synchronized (stateLock) {
            sRoll  = (rollRaw  == 0x7FFF) ? null : rollRaw  / 10.0;
            sPitch = (pitchRaw == 0x7FFF) ? null : pitchRaw / 10.0;
            sHdgMag = (hdgVal == 0x7FFF || !magnetic) ? null : hdgVal / 10.0;
            sIas = (iasRaw == 0xFFFF) ? null : (double) iasRaw;
            sTas = (tasRaw == 0xFFFF) ? null : (double) tasRaw;
        }
        emitSituation();
    }

    private static int signed16(byte[] p, int off) {
        int v = ((p[off] & 0xFF) << 8) | (p[off + 1] & 0xFF);
        if ((v & 0x8000) != 0) v -= 0x10000;
        return v;
    }

    /** Stratux custom heartbeat (0xCC, 2 bytes): [1] bit0 AHRS valid, bit1 GPS valid. */
    private void parseStratuxHb(byte[] p, int len) {
        if (len < 2) return;
        boolean ahrsValid = (p[1] & 0x01) != 0;
        boolean gpsValid  = (p[1] & 0x02) != 0;
        JSObject ev = new JSObject();
        ev.put("ahrs_valid", ahrsValid);
        ev.put("gps_valid", gpsValid);
        notifyListeners("stratux_hb", ev);
    }

    // ===========================================================================
    // Situation emission — combine all sources into a Stratux-WS-compatible object
    // ===========================================================================

    /**
     * Emit a 'situation' event with fields shaped like Stratux's WS /situation JSON,
     * so stratux-client.js _handleSituation works unchanged. Called whenever any
     * source updates state; downstream rate-limits as needed.
     */
    private void emitSituation() {
        JSObject ev = new JSObject();
        synchronized (stateLock) {
            if (sLat != null) ev.put("GPSLatitude", sLat);
            if (sLon != null) ev.put("GPSLongitude", sLon);
            // Stratux's WS distinguishes BaroPressureAltitude (from ADS-B msg) from
            // GPSAltitudeMSL (from geo alt msg). We map directly.
            if (sBaroAlt != null) ev.put("BaroPressureAltitude", sBaroAlt);
            if (sGeoAlt  != null) ev.put("GPSAltitudeMSL", sGeoAlt);
            if (sGsKt    != null) ev.put("GPSGroundSpeed", sGsKt);
            if (sVvel    != null) ev.put("GPSVerticalSpeed", sVvel);
            if (sTrack   != null) ev.put("GPSTrueCourse", sTrack);
            if (sPitch   != null) ev.put("AHRSPitch", sPitch);
            if (sRoll    != null) ev.put("AHRSRoll", sRoll);
            // GDL 90 doesn't carry G-load; leave AHRSGLoad absent.
            // GPSFixQuality: GDL 90 doesn't expose DGPS vs basic. Use 2 if heartbeat
            // says GPS valid (matches Stratux WS convention where 2 = DGPS), else 0.
            ev.put("GPSFixQuality", Boolean.TRUE.equals(sGpsValid) ? 2 : 0);
            // Stratux WS sends sat counts; GDL 90 doesn't. Omit.
        }
        notifyListeners("situation", ev);
    }
}
