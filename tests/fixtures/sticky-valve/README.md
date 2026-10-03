# Sticky-valve rule fixtures (real engine starts)

Columns: `t_sec,rpm,egt1,egt2,egt3,egt4` (integers; EGT in deg F). `t_sec` is relative to the first row. No GPS, time-of-day or dates. Source data resampled to 1 Hz (first sample in each second). See `REPORT.md` for the full per-start analysis.

- `sticky-valve-start-1.csv`: source `stream_0033.txt`; coldest start (lowest mean EGT at the first RPM>500 sample); min ratio 0.926 on cyl 2. Rows are 1 Hz from 30 s before engine start (first RPM > 500) to 12 min after.
- `sticky-valve-start-2.csv`: source `2025-06-24_SC76 - KLKR_merged.csv`; typical start (closest to the median start EGT 164F and median min ratio 0.920 among starts with full 12-min 1 Hz coverage); min ratio 0.920 on cyl 2. Rows are 1 Hz from 30 s before engine start (first RPM > 500) to 12 min after.
- `sticky-valve-start-3.csv`: source `2025-07-02_KLKR - KLKR_merged.csv`; closest to alerting (lowest per-cylinder ratio of any captured start); min ratio 0.787 on cyl 2. Rows are 1 Hz from 30 s before engine start (first RPM > 500) to 12 min after. Includes a failed start attempt: RPM first exceeds 500 at t_sec=30, engine quits, real start at t_sec=50. Source recording ends 409 s after the first RPM>500 (less than 12 min available).
