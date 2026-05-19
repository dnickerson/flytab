# APK Update — Design Spec

**Date:** 2026-05-19  
**Status:** Approved

## Overview

Add an APK self-update capability to FlyTab: the pilot places a new APK on their SFTP server (home LAN or Tailscale), taps "Download & Install Update" at the top of the Configuration editor, and the app downloads the file and hands it to the Android system installer. Reuses the existing `SftpPlugin` and `flightUpload` SFTP configuration — no new credentials, no new plugin.

## Configuration

New field `apkRemotePath` added to the existing `flightUpload` block in `cockpit-config.json`:

```json
"flightUpload": {
  "host": "",
  "port": 22,
  "username": "",
  "remotePath": "~/flights",
  "apkRemotePath": "~/flytab/flytab-latest.apk"
}
```

The existing Flight Upload card in `config-editor.js` gets a fifth text field: **APK Remote Path** (below the four existing fields). Collected and saved by the same `_save()` logic that handles the other four fields.

## Android — SftpPlugin Additions (`SftpPlugin.java`)

Two new `@PluginMethod` entries added to the existing plugin:

### `download(host, port, username, password, remoteFile)`

| Parameter | Type | Notes |
|-----------|------|-------|
| `host` | String | SFTP server hostname or IP |
| `port` | int | Default 22 |
| `username` | String | SFTP username |
| `password` | String | Cleartext for this call only |
| `remoteFile` | String | Full remote path, e.g. `~/flytab/flytab-latest.apk` |

- Runs on the background executor thread (same pattern as `upload`)
- Downloads `remoteFile` to `getContext().getCacheDir()/flytab-update.apk`
- Returns `{ok: true}` on success or `{ok: false, error: "..."}` on failure (never rejects)
- No path traversal guard needed — `remoteFile` is a full remote path supplied from trusted config, not a user-typed filename

### `installApk()`

- Builds a `File` reference to `getContext().getCacheDir()/flytab-update.apk`
- Obtains a FileProvider URI via `FileProvider.getUriForFile(context, packageName + ".fileprovider", file)`
- Fires `Intent.ACTION_VIEW` with MIME type `application/vnd.android.package-archive` and `FLAG_GRANT_READ_URI_PERMISSION`
- The Android system installer dialog opens over FlyTab; the user taps Install

**FileProvider:** Already declared in `AndroidManifest.xml`. `res/xml/file_paths.xml` already includes `<cache-path name="my_cache_images" path="." />` — no changes needed to either file.

**New permission required:**
```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

## Config Editor UI & Flow (`web/cockpit/config-editor.js`)

A "Download & Install Update" button row is rendered at the very top of the config editor page body, above all section cards.

### Flow on tap

1. **Validate config** — check `host`, `username`, and `apkRemotePath` are non-empty. If any missing, show an inline message: "Configure Flight Upload (host, username, APK path) before updating."
2. **Get password** — call `Sftp.getPassword()`. If `null`, show a password modal:
   - `<input type="password">` with a "Save password" checkbox (checked by default)
   - Cancel and OK buttons wired via `wireTap()` (required — Leaflet swallows synthetic clicks)
   - `keydown` Enter listener stays as `addEventListener`
   - If "Save password" checked, call `Sftp.savePassword()` before proceeding
3. **Show progress** — replace button with "Downloading…" status line
4. **Download** — call `Sftp.download(host, port, username, password, apkRemotePath)`
5. **On success** — call `Sftp.installApk()`. System installer opens.
6. **On error** — show inline error text; restore button so user can retry

The password modal and flow logic live entirely in `config-editor.js`. No shared module needed — this is a low-frequency action and the password is almost always already stored from regular flight upload use.

## Files Changed

| File | Change |
|------|--------|
| `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java` | Add `download()` and `installApk()` methods |
| `android/app/src/main/AndroidManifest.xml` | Add `REQUEST_INSTALL_PACKAGES` permission |
| `web/cockpit/config-editor.js` | Add `apkRemotePath` field to Flight Upload card; add "Download & Install Update" button + flow at top |
| `web/cockpit-config.json` | Add `apkRemotePath: ""` to `flightUpload` block |

## Out of Scope

- Automatic "new version available" notification or version comparison
- Download progress percentage (shows "Downloading…" only)
- Keeping or rolling back to the previous APK
- APK signature verification (handled by the Android system installer)
- Silent install (Android security requirement: user must tap Install in system dialog)
