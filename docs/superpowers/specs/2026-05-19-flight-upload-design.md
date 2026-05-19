# Flight Upload — Design Spec

**Date:** 2026-05-19  
**Status:** Approved

## Overview

Add SFTP upload of completed flight CSV files from FlyTab to a user-configured server (home LAN or Tailscale). Flight files are Savvy Aviation-compatible CSVs recorded by `FlightRecorder` and stored at `Documents/FlyTab/flights/` on the device's SD card. The feature consists of:

1. A `flightUpload` config block (host, port, username, remote path)
2. A native Capacitor SFTP plugin (mwiede/jsch + EncryptedSharedPreferences)
3. A full-screen Flight Upload panel (`flight-upload.js`)
4. A "Flight Upload" entry in the More drawer

## Configuration

New block in `cockpit-config.json`:

```json
"flightUpload": {
  "host": "",
  "port": 22,
  "username": "",
  "remotePath": "~/flights"
}
```

- `host` accepts LAN IPs (e.g. `192.168.1.81`) and Tailscale hostnames (e.g. `fitpc.tail12345.ts.net`)
- `port` defaults to 22
- Password is **never stored in config** — it is encrypted and stored separately in Android EncryptedSharedPreferences

Config is saved to `localStorage` via `CockpitConfig` (same pattern as all other blocks). The `config-editor.js` Connection section gets a new **Flight Upload** card with four fields: Host (text), Port (number), Username (text), Remote Path (text). Collected and saved via custom logic in `_save()` (same pattern as the Home Server card — not via `data-section` attributes).

## Android SFTP Plugin (`SftpPlugin.java`)

**Location:** `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`

**Gradle dependencies** (app-level `build.gradle`):
```groovy
implementation 'com.github.mwiede:jsch:0.2.17'
implementation 'androidx.security:security-crypto:1.1.0-alpha06'
```

**Plugin methods:**

| Method | Parameters | Returns | Notes |
|--------|-----------|---------|-------|
| `upload` | `host, port, username, filename, remotePath` | `{ok, error?}` | Reads file from SD card, streams via SFTP |
| `savePassword` | `password` | `{}` | Encrypts via EncryptedSharedPreferences |
| `getPassword` | — | `{password}` | Returns null if not stored |
| `clearPassword` | — | `{}` | Removes stored password |

**Implementation notes:**
- `upload()` runs on a background thread (Capacitor executor pool) — never blocks the UI thread
- File path resolved from `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS) + "/FlyTab/flights/" + filename`
- Path traversal guard: reject any `filename` containing `..` or `/`
- JSch `StrictHostKeyChecking` set to `no` (pilot's own servers on trusted networks; avoids known-hosts management complexity)
- `EncryptedSharedPreferences` uses a Keystore-backed AES-256 master key; key never leaves the hardware security module

## Flight Upload Panel (`web/cockpit/flight-upload.js`)

Full-screen overlay following the `Logbook` / `ConfigEditor` pattern.

### Lifecycle

- `show()` — renders overlay, fetches flight list, checks stored password
- `hide()` — removes overlay from view
- `toggle()` — show/hide

### Flight list

Fetched from `GET http://localhost:9090/flights/list` (returns JSON array of filenames sorted newest-first). Each row displays:

- **Filename** (e.g. `20260519_KLKR-KAVL.csv`)
- **Date** parsed from the filename prefix (`YYYYMMDD` → human-readable)
- **File size** — the existing `GET /flights/list` endpoint returns only filenames; `handleFlightsList()` in `TileServer.java` must be extended to return a JSON array of objects `[{name, size_bytes, modified_ms}]` instead of strings. The panel uses `size_bytes` to display size and `modified_ms` as a fallback date source.
- **Status badge:** `UPLOADED` (green) or `PENDING` (grey)
- **Upload button** — disabled and shows `✓` when already uploaded

### Upload status persistence

Tracked in `localStorage` key `flytab_uploaded_flights` as a JSON array of filenames. A file is marked uploaded only after `SftpPlugin.upload()` returns `{ok: true}`.

### Password flow

1. First upload attempt: calls `Sftp.getPassword()` — if `null`, shows a modal with a password `<input type="password">` and a "Save password" checkbox (checked by default). If checkbox is checked, calls `Sftp.savePassword()` before uploading.
2. Subsequent uploads: `getPassword()` returns the stored value — no modal shown.
3. **Change Password** link at the bottom of the panel clears stored password via `Sftp.clearPassword()` and re-prompts on the next upload attempt.

### Bulk upload

- **Upload All Pending** button at the top — iterates pending files sequentially, showing per-row progress. Stops on first error and shows an error message; already-uploaded rows retain their status.

### Config validation

Before any upload attempt, validates that `host` and `username` are non-empty. If not configured, shows an inline message directing the user to Configuration → Flight Upload.

## Menu / Wiring

**`tab-bar.js` `_buildMoreDrawer()`** — new row after the Logbook entry:

```js
{ icon: '📤', label: 'Flight Upload', action: () => {
    if (c.flightUpload?.show) c.flightUpload.show();
    this._hideRadarControls();
    this._closeMoreDrawer();
}},
```

**`app.js`:**
- `FlightUpload` instantiated alongside other cockpit components
- Passed to `TabBar` in the components map as `flightUpload`
- Added to the hide-all list in `_selectTab()` so it closes when switching tabs

**`web/index.html`:**
- `<script src="cockpit/flight-upload.js">` added after `flight-recorder.js`

## Files Changed / Created

| File | Change |
|------|--------|
| `android/app/build.gradle` | Add jsch + security-crypto dependencies |
| `android/app/src/main/java/app/flywhere/flytab/tileserver/TileServer.java` | Extend `handleFlightsList()` to return `[{name, size_bytes, modified_ms}]` |
| `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java` | New Capacitor plugin |
| `android/app/src/main/java/app/flywhere/flytab/MainActivity.java` | Register SftpPlugin |
| `web/cockpit/flight-upload.js` | New panel component |
| `web/cockpit/config-editor.js` | Add Flight Upload card to Connection section |
| `web/index.html` | Add `<script>` tag for flight-upload.js |
| `web/app.js` | Instantiate FlightUpload, wire to TabBar |
| `web/cockpit/tab-bar.js` | Add "Flight Upload" row to More drawer |
| `web/cockpit-config.json` | Add `flightUpload` default block |

## Out of Scope

- Automatic upload on WiFi connect (the existing `autoSyncWhenOnline` flag is unrelated to this feature)
- Deleting files from device after upload
- Upload to Savvy Aviation HTTP API (user specified SFTP)
- Known-hosts verification (not practical for a tablet moving between networks)
