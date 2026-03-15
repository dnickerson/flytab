package app.flywhere.flytab;

import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;

/**
 * Capacitor plugin that exposes Android thermal data to the WebView.
 *
 * Returns:
 *   headroom     — float 0.0 (cool) to 1.0+ (throttling). API 30+ only, -1 if unavailable.
 *   status       — thermal status string
 *   statusCode   — int 0–6
 *   cpuTemp      — hottest CPU core in °C from sysfs
 *   surfaceTemp  — actual device surface temp (front_temp/back_temp average)
 *   skinTemp     — skin-msm-therm virtual sensor (for reference only)
 *   shutdownTemp — CPU thermal trip point
 */
@CapacitorPlugin(name = "ThermalMonitor")
public class ThermalMonitorPlugin extends Plugin {
    private static final String TAG = "ThermalMonitor";

    @PluginMethod
    public void getThermal(PluginCall call) {
        JSObject ret = new JSObject();

        // --- Official Thermal API (API 29+) ---
        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);

        int statusCode = -1;
        String statusName = "UNKNOWN";
        float headroom = -1f;

        if (Build.VERSION.SDK_INT >= 29 && pm != null) {
            statusCode = pm.getCurrentThermalStatus();
            statusName = thermalStatusName(statusCode);
        }
        if (Build.VERSION.SDK_INT >= 30 && pm != null) {
            headroom = pm.getThermalHeadroom(30);
        }

        ret.put("headroom", headroom);
        ret.put("status", statusName);
        ret.put("statusCode", statusCode);

        // --- Sysfs thermal zones ---
        float cpuTempMax = -1f;
        float skinMsmTemp = -1f;
        float frontTemp = -1f;
        float backTemp = -1f;
        float quietTemp = -1f;
        float shutdownTemp = -1f;

        File thermalDir = new File("/sys/class/thermal");
        if (thermalDir.exists()) {
            File[] zones = thermalDir.listFiles((dir, name) -> name.startsWith("thermal_zone"));
            if (zones != null) {
                for (File zone : zones) {
                    String type = readFile(new File(zone, "type")).trim().toLowerCase();
                    float temp = readTempFile(new File(zone, "temp"));

                    // CPU cores — track the hottest one
                    if (type.startsWith("cpu") || type.startsWith("cpuss")) {
                        if (temp > cpuTempMax) {
                            cpuTempMax = temp;
                        }
                        // Get shutdown trip from first CPU zone found
                        if (shutdownTemp < 0) {
                            shutdownTemp = readHighestTripPoint(zone);
                        }
                    }

                    // Actual surface sensors (Lenovo Yoga Tab specific)
                    if (type.equals("front_temp")) frontTemp = temp;
                    if (type.equals("back_temp")) backTemp = temp;
                    if (type.equals("quiet-therm") || type.equals("quiet_therm")) quietTemp = temp;

                    // Virtual skin sensor (not user-facing, reference only)
                    if (type.equals("skin-msm-therm")) skinMsmTemp = temp;
                }

                // Fallback CPU temp
                if (cpuTempMax < 0 && zones.length > 0) {
                    cpuTempMax = readTempFile(new File(zones[0], "temp"));
                    shutdownTemp = readHighestTripPoint(zones[0]);
                }
            }
        }

        // Surface temp: average of front and back, or whichever is available
        float surfaceTemp = -1f;
        if (frontTemp >= 0 && backTemp >= 0) {
            surfaceTemp = (frontTemp + backTemp) / 2f;
        } else if (backTemp >= 0) {
            surfaceTemp = backTemp;
        } else if (frontTemp >= 0) {
            surfaceTemp = frontTemp;
        } else if (quietTemp >= 0) {
            surfaceTemp = quietTemp;
        }

        ret.put("cpuTemp", Math.round(cpuTempMax * 10) / 10.0);
        ret.put("surfaceTemp", Math.round(surfaceTemp * 10) / 10.0);
        ret.put("skinTemp", Math.round(skinMsmTemp * 10) / 10.0);
        ret.put("shutdownTemp", Math.round(shutdownTemp * 10) / 10.0);

        Log.i(TAG, "headroom=" + String.format("%.2f", headroom)
                + " cpu=" + Math.round(cpuTempMax) + "C"
                + " surface=" + Math.round(surfaceTemp) + "C"
                + " status=" + statusName + "(" + statusCode + ")");

        call.resolve(ret);
    }

    /** Read a sysfs temp file (millidegrees → °C). Returns -1 on failure. */
    private float readTempFile(File file) {
        String raw = readFile(file).trim();
        if (raw.isEmpty()) return -1f;
        try {
            long milliDeg = Long.parseLong(raw);
            if (milliDeg > 1000) return milliDeg / 1000f;
            return milliDeg;
        } catch (NumberFormatException e) {
            return -1f;
        }
    }

    /** Find the highest trip point in a thermal zone (likely critical/shutdown). */
    private float readHighestTripPoint(File zone) {
        float highest = -1f;
        for (int i = 0; i < 20; i++) {
            File tp = new File(zone, "trip_point_" + i + "_temp");
            if (!tp.exists()) break;
            float temp = readTempFile(tp);
            if (temp > highest) highest = temp;
        }
        return highest;
    }

    /** Read a small sysfs file. Returns empty string on failure. */
    private String readFile(File file) {
        if (!file.exists() || !file.canRead()) return "";
        try (BufferedReader br = new BufferedReader(new FileReader(file))) {
            String line = br.readLine();
            return line != null ? line : "";
        } catch (Exception e) {
            return "";
        }
    }

    private String thermalStatusName(int status) {
        switch (status) {
            case 0: return "NONE";
            case 1: return "LIGHT";
            case 2: return "MODERATE";
            case 3: return "SEVERE";
            case 4: return "CRITICAL";
            case 5: return "EMERGENCY";
            case 6: return "SHUTDOWN";
            default: return "UNKNOWN";
        }
    }
}
