// tests/fixtures/stratux-messages.js
// Exact Stratux WebSocket wire formats — verified from stratux-client.js source.

export const SITUATION = {
    GPSLatitude:          34.9,
    GPSLongitude:        -81.1,
    GPSAltitudeMSL:       5000.0,
    BaroPressureAltitude: 4950.0,
    GPSGroundSpeed:       150.0,
    GPSTrueCourse:         90.0,
    GPSVerticalSpeed:       0.0,
    GPSFixQuality:          2,
    GPSSatellites:          9,
    GPSSatellitesSeen:     11,
    AHRSPitch:              1.5,
    AHRSRoll:               0.5,
    AHRSGLoad:              1.0,
    AHRSGLoadMin:           0.98,
    AHRSGLoadMax:           1.02,
};

// Note: longitude field is Lng, NOT Lon.
export const TRAFFIC_TARGET = {
    Icao_addr:            11256833,
    Tail:                 'N123AB',
    Lat:                   35.25,
    Lng:                  -80.0,
    Alt:                   3500,
    Track:                 270,
    Speed:                 120,
    Vvel:                    0,
    Squawk:               '1200',
    OnGround:              false,
    Age:                    0.0,
    ExtrapolatedPosition:  false,
    SignalLevel:           -45.0,
    TargetType:              1,
};

export const SITUATION_NO_FIX = { ...SITUATION, GPSFixQuality: 0, GPSSatellites: 0 };

export const NEXRAD_FRAME = {
    Product_id: 63,
    NEXRAD: [
        { lat: 34.9, lon: -81.1, intensity: 25, range: 50 },
    ],
};
