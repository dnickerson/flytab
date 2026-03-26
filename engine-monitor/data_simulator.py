#!/usr/bin/env python3
"""
Simulate serial data from a capture file for testing with capture_v4.
Creates a virtual serial port and feeds data with EDM timestamp-based timing.

This version uses proper EDM timestamp parsing for realistic playback timing,
matching the FilePlaybackReader approach used in engine_monitor.py.
"""

import os
import sys
import pty
import time
import argparse


def parse_edm_timestamp(line):
    """Extract EDM timestamp from line (seconds since midnight with fractional precision).

    EDM format: first 8 chars are HHMMSSFF where FF is 1/64 second fraction.

    Returns:
        float: Seconds since midnight with fractional precision, or None if invalid
    """
    line = line.strip()
    if len(line) < 8:
        return None
    try:
        hours = int(line[0:2])
        minutes = int(line[2:4])
        seconds = int(line[4:6])
        fraction = int(line[6:8])  # 1/64 of a second
        if 0 <= hours <= 23 and 0 <= minutes <= 59 and 0 <= seconds <= 59:
            return hours * 3600 + minutes * 60 + seconds + (fraction / 64.0)
    except (ValueError, IndexError):
        pass
    return None


def simulate_data(data_file, rate=1.0, loop=True):
    """
    Create a virtual serial port and feed data from file with EDM timestamp timing.

    Uses actual EDM timestamps embedded in the data for realistic playback,
    rather than a fixed rate. This matches how capture_v4's FilePlaybackReader works.

    Args:
        data_file: Path to captured data file
        rate: Playback speed multiplier (1.0 = realtime, 10.0 = 10x speed)
        loop: Whether to loop the file continuously
    """
    # Create pseudo-terminal pair
    master_fd, slave_fd = pty.openpty()
    slave_name = os.ttyname(slave_fd)

    # Create symlink at /tmp/ttyUSB0 for easy access
    link_path = '/tmp/ttyUSB0'
    try:
        os.unlink(link_path)
    except FileNotFoundError:
        pass
    os.symlink(slave_name, link_path)

    print(f"Virtual serial port created:")
    print(f"  Device: {slave_name}")
    print(f"  Symlink: {link_path}")
    print(f"  Data file: {data_file}")
    print(f"  Playback rate: {rate}x")
    print(f"  Loop: {loop}")
    print()
    print("Configure engine_monitor.py:")
    print("  CONFIG['SERIAL_PORT'] = '/tmp/ttyUSB0'")
    print()
    print("Or use built-in playback mode instead:")
    print(f"  CONFIG['PLAYBACK_MODE'] = True")
    print(f"  CONFIG['PLAYBACK_FILE'] = '{os.path.abspath(data_file)}'")
    print(f"  CONFIG['PLAYBACK_RATE'] = {rate}")
    print()
    print("Press Ctrl+C to stop")
    print()

    last_wall_time = None
    last_edm_time = None

    try:
        while True:
            with open(data_file, 'r') as f:
                line_count = 0
                for line in f:
                    line = line.strip()
                    if not line:
                        continue

                    # Parse EDM timestamp for timing sync
                    edm_time = parse_edm_timestamp(line)

                    if edm_time is not None:
                        current_wall_time = time.time()

                        if last_edm_time is not None and last_wall_time is not None:
                            # Calculate delay based on EDM time difference
                            edm_delta = edm_time - last_edm_time

                            # Handle midnight rollover
                            if edm_delta < 0:
                                edm_delta += 86400  # Add 24 hours

                            # Skip sleep if delta is unreasonably large (corrupted data or gap)
                            if edm_delta <= 60:
                                # Apply playback rate and calculate required sleep
                                target_wall_delta = edm_delta / rate
                                actual_wall_delta = current_wall_time - last_wall_time
                                sleep_time = target_wall_delta - actual_wall_delta

                                if sleep_time > 0:
                                    time.sleep(sleep_time)

                        last_edm_time = edm_time
                        last_wall_time = time.time()

                    # Write to virtual serial port
                    os.write(master_fd, (line + '\n').encode())
                    line_count += 1

                    if line_count % 360 == 0:  # Status every ~minute at 6Hz
                        # Parse time for display
                        if edm_time is not None:
                            hours = int(edm_time // 3600)
                            minutes = int((edm_time % 3600) // 60)
                            seconds = int(edm_time % 60)
                            print(f"Sent {line_count} lines... EDM time: {hours:02d}:{minutes:02d}:{seconds:02d}")
                        else:
                            print(f"Sent {line_count} lines...")

            if not loop:
                print("File complete.")
                break
            print("Looping file...")
            # Reset timing for smooth loop transition
            last_wall_time = None
            last_edm_time = None

    except KeyboardInterrupt:
        print("\nStopping simulator...")
    finally:
        os.close(master_fd)
        os.close(slave_fd)
        try:
            os.unlink(link_path)
        except:
            pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Simulate EDM serial data for capture_v4 testing',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s capture_data.txt              # Realtime playback, looping
  %(prog)s capture_data.txt --rate 10    # 10x speed playback
  %(prog)s capture_data.txt --no-loop    # Single pass, then stop

Note: capture_v4 also has built-in playback mode via CONFIG settings.
This simulator is useful when testing the actual serial port reading code.
""")
    parser.add_argument('datafile', help='Path to captured EDM data file')
    parser.add_argument('--rate', type=float, default=1.0,
                        help='Playback speed multiplier (default: 1.0 = realtime)')
    parser.add_argument('--no-loop', action='store_true',
                        help='Stop at end of file instead of looping')

    args = parser.parse_args()

    if not os.path.exists(args.datafile):
        print(f"Error: File not found: {args.datafile}")
        sys.exit(1)

    simulate_data(args.datafile, args.rate, not args.no_loop)
