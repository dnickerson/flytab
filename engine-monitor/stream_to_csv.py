#!/usr/bin/env python3
"""Convert a capture_v5 stream_*.txt file to a Savvy-compatible CSV.

Usage:
    python3 stream_to_csv.py stream_2026-03-09_17-13-46.txt

Output: same name with .csv extension (e.g. stream_2026-03-09_17-13-46.csv)
"""

import re
import sys
import os
from datetime import datetime, timezone

FIELD_WIDTHS = [2, 2, 2, 2, 4, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 8, 8, 8, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3]

CSV_HEADER = ('Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,'
              'Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,'
              'GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,'
              'CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,'
              'altitude_ft,speed_kts,bank,pitch,acc_vert,course,'
              'EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,'
              'Operating_Condition,Percent,SFC')


def extract_numeric(s):
    """Extract numeric value from a field that may have text prefix (e.g. 'CRB00117' -> 117)."""
    if not s:
        return 0
    match = re.search(r'-?\d+', s)
    return int(match.group()) if match else 0


def parse_line(line):
    line = line.strip()
    min_len = sum(FIELD_WIDTHS)
    if not line or len(line) < min_len or '\x00' in line:
        return None
    try:
        fields = []
        pos = 0
        for w in FIELD_WIDTHS:
            fields.append(line[pos:pos + w].strip())
            pos += w

        hours, minutes, seconds = int(fields[0]), int(fields[1]), int(fields[2])
        if not (0 <= hours <= 23 and 0 <= minutes <= 59 and 0 <= seconds <= 59):
            return None

        return {
            'time': f"{hours:02d}:{minutes:02d}:{seconds:02d}",
            'MP':            float(fields[4]) / 100 if fields[4] else 0,
            'Oil_Temp':      extract_numeric(fields[5]),
            'Oil_Press':     extract_numeric(fields[6]),
            'Fuel_Press':    float(fields[7]) / 10 if fields[7] else 0,
            'Volts':         float(fields[8]) / 10 if fields[8] else 0,
            'Amps':          extract_numeric(fields[9]),
            'RPM':           extract_numeric(fields[10]) * 10,
            'Fuel_Flow':     float(fields[11]) / 10 if fields[11] else 0,
            'Fuel_Remaining':float(fields[12]) / 10 if fields[12] else 0,
            'Fuel_Left':     float(fields[13]) / 10 if fields[13] else 0,
            'Fuel_Right':    float(fields[14]) / 10 if fields[14] else 0,
            'Carb_Temp':     extract_numeric(fields[15]),
            'GP2':           fields[16].strip() if len(fields) > 16 else '',
            'GP3':           fields[17].strip() if len(fields) > 17 else '',
            'Thermo':        extract_numeric(fields[18]) if len(fields) > 18 else 0,
            'EGT1':          extract_numeric(fields[19]),
            'EGT2':          extract_numeric(fields[20]),
            'EGT3':          extract_numeric(fields[21]),
            'EGT4':          extract_numeric(fields[22]),
            'CHT1':          extract_numeric(fields[25]),
            'CHT2':          extract_numeric(fields[26]),
            'CHT3':          extract_numeric(fields[27]),
            'CHT4':          extract_numeric(fields[28]),
        }
    except (ValueError, IndexError):
        return None


def main():
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <stream_file.txt>")
        sys.exit(1)

    stream_path = sys.argv[1]
    if not os.path.exists(stream_path):
        print(f"File not found: {stream_path}")
        sys.exit(1)

    # Derive date from filename (stream_YYYY-MM-DD_HH-MM-SS.txt)
    basename = os.path.basename(stream_path)
    try:
        date_str = basename.split('_')[1]   # "2026-03-09"
    except IndexError:
        date_str = datetime.now().strftime('%Y-%m-%d')

    out_path = stream_path.replace('.txt', '.csv')

    points = 0
    skipped = 0
    last_time = None

    with open(stream_path, 'r', errors='replace') as fin, \
         open(out_path, 'w') as fout:

        fout.write(CSV_HEADER + '\n')

        for raw in fin:
            d = parse_line(raw)
            if d is None:
                skipped += 1
                continue

            # Write at most one row per second (deduplicate sub-second EDM frames)
            t = d['time']
            if t == last_time:
                continue
            last_time = t

            egts = [d['EGT1'], d['EGT2'], d['EGT3'], d['EGT4']]
            chts = [d['CHT1'], d['CHT2'], d['CHT3'], d['CHT4']]
            egts_pos = [v for v in egts if v > 0]
            chts_pos = [v for v in chts if v > 0]
            egt_spread = max(egts_pos) - min(egts_pos) if egts_pos else 0
            cht_spread = max(chts_pos) - min(chts_pos) if chts_pos else 0
            max_egt    = max(egts_pos) if egts_pos else 0

            # 12-hour time for Zulu_Time column
            parts = t.split(':')
            h = int(parts[0])
            ampm = 'PM' if h >= 12 else 'AM'
            h12 = h % 12 or 12
            time_12 = f"{h12}:{parts[1]}:{parts[2]} {ampm}"

            row = ','.join(str(v) for v in [
                time_12,
                d['MP'], d['Oil_Temp'], d['Oil_Press'],
                d['Fuel_Press'], d['Volts'], d['Amps'],
                d['RPM'], d['Fuel_Flow'], d['Fuel_Remaining'],
                d['Fuel_Left'], d['Fuel_Right'], d['Carb_Temp'],
                d['GP2'], d['GP3'], d['Thermo'],
                d['EGT1'], d['EGT2'], d['EGT3'], d['EGT4'],
                d['CHT1'], d['CHT2'], d['CHT3'], d['CHT4'],
                date_str, time_12,
                '', '',   # longitude, latitude — not in stream file
                '', '',   # altitude_ft, speed_kts
                '', '', '', '',  # bank, pitch, acc_vert, course
                egt_spread, cht_spread, max_egt,
                '', '', '', ''   # percent_power, mode, deviation, sfc
            ])
            fout.write(row + '\n')
            points += 1

    print(f"Done: {points} rows written to {out_path}  ({skipped} lines skipped)")


if __name__ == '__main__':
    main()
