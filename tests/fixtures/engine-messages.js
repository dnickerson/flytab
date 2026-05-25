// tests/fixtures/engine-messages.js
// Exact engine monitor get_status() wire format — verified from engine_monitor.py.
// The engine panel flattens via: raw.data ? { ...raw, ...raw.data } : raw

const ENGINE_FRAME = {
    version:               '3.3.0',
    capturing:             true,
    serial_connected:      true,
    stratux_connected:     false,
    percent_power:         65.0,
    rop_lop_percent:        2.5,
    rop_lop_mode:          'RICH',
    sfc:                    0.42,
    gps_altitude:          5000,
    pressure_altitude:     4950,
    ground_speed:           150,
    tas:                    155,
    oat:                     12.0,
    density_altitude:      6200,
    sticky_valve_alert:    null,
    sticky_valve_dismissed: false,
    serial_warning:        null,
    degrees_from_peak:     {},
    peaks_valid:           false,
    manual_altimeter:      null,
    manual_oat:            null,
    fuel:                  null,
    data: {
        RPM:        2200,
        MP:           24.5,
        Oil_Temp:    180.0,
        Oil_Press:    76.0,
        Fuel_Press:    4.7,
        Volts:        13.7,
        Amps:         34.0,
        Fuel_Flow:     8.5,
        Gallons_Rem:  24.9,
        Fuel_L1:      13.7,
        Fuel_L2:      11.2,
        EGT1: 1350,
        EGT2: 1320,
        EGT3: 1360,
        EGT4: 1340,
        CHT1:  380,
        CHT2:  365,
        CHT3:  370,
        CHT4:  355,
    },
};

const ENGINE_FRAME_FLAT = { ...ENGINE_FRAME, ...ENGINE_FRAME.data };

const ENGINE_STALE_EVENT = { stale: true, ageMs: 6000 };

module.exports = { ENGINE_FRAME, ENGINE_FRAME_FLAT, ENGINE_STALE_EVENT };
