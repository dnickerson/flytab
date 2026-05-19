# SFTP SSH Key Authentication — Design Spec

**Date:** 2026-05-19  
**Status:** Approved

## Overview

Add SSH private key authentication to the existing SFTP plugin (`SftpPlugin.java`). The pilot copies their existing private key file to the device SD card once, imports it via the config editor, and the key is stored encrypted on device. All SFTP operations (`upload`, `download`) try key auth first, fall back to password automatically. No changes to `cockpit-config.json` — the key lives in `EncryptedSharedPreferences` only.

## Authentication Logic — `SftpPlugin.java`

### New Plugin Methods

| Method | Parameters | Returns | Notes |
|--------|-----------|---------|-------|
| `importKey` | `keyPath` | `{ok, error?}` | Reads key bytes from SD card, stores encrypted |
| `clearKey` | — | `{}` | Removes stored key from EncryptedSharedPreferences |
| `getKeyStatus` | — | `{hasKey}` | Returns true if a key is stored |

#### `importKey({keyPath})`

- Resolves `keyPath` relative to `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)` if it does not start with `/`. A bare filename like `id_rsa` resolves to `Documents/id_rsa`.
- Reads the file into a byte array.
- Path traversal guard: reject any `keyPath` containing `..`.
- Stores the raw bytes as a Base64 string in `EncryptedSharedPreferences` under key `sftp_private_key`.
- Returns `{ok: true}` on success; `{ok: false, error: "..."}` on failure (file not found, read error). Never `call.reject()`.

#### `clearKey()`

- Removes `sftp_private_key` from `EncryptedSharedPreferences`.
- Always resolves (no error path).

#### `getKeyStatus()`

- Returns `{hasKey: true}` if `sftp_private_key` is present and non-null, `{hasKey: false}` otherwise.

### Changes to `upload()` and `download()`

Both methods gain the same auth setup block, inserted after `session.setConfig("StrictHostKeyChecking", "no")` and before `session.connect()`:

```java
// Try key auth first if a key is stored; fall back to password automatically
byte[] keyBytes = loadStoredKey();
if (keyBytes != null) {
    byte[] passphraseBytes = finalPassword != null ? finalPassword.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;
    jsch.addIdentity("flytab", keyBytes, null, passphraseBytes);
}
session.setConfig("PreferredAuthentications", "publickey,password");
session.setPassword(finalPassword);
session.connect(30000);
```

`loadStoredKey()` is a private helper that reads `sftp_private_key` from `EncryptedSharedPreferences`, Base64-decodes it, and returns the byte array. Returns `null` if not set or on error.

**Auth behaviour:**
- Key stored, server accepts key → key auth succeeds; password field ignored by server
- Key stored, key passphrase-protected → uses `finalPassword` as passphrase via `addIdentity`
- Key stored, server rejects key → JSch falls back to password auth automatically via `PreferredAuthentications`
- No key stored → password-only auth (existing behaviour, unchanged)

## Config Editor UI — `web/cockpit/config-editor.js`

### SSH Key status row

Added to the Flight Upload SFTP card, between the Remote Path field and the APK Remote Path field.

**State: no key imported**
```
SSH Key    [not imported]   [Import Key ▸]
```

**State: key stored**
```
SSH Key    [imported ✓]     [Clear Key]
```

The status text and button are rendered inline in the card HTML. Because `getKeyStatus()` is an async Capacitor call, the row defaults to "not imported" in the static HTML. After `body.innerHTML = sections.join('')`, `_render()` calls `Capacitor.Plugins.Sftp.getKeyStatus()` and, once it resolves, updates the row DOM directly (`querySelector('#ce-fu-key-status')`). On-device the update takes a few milliseconds and is not perceptible to the user.

### Import flow

Tapping **Import Key** expands an inline sub-row below the status row:

```
Path:  [____________Documents/id_rsa____________]  [Import]  [Cancel]
       (error message if any)
```

- Path input: placeholder `Documents/id_rsa`; the user types the filename or full path where the key file was placed on the SD card
- Tapping **Import** calls `Sftp.importKey({keyPath: inputValue.trim()})`
  - On `{ok: true}`: collapses the sub-row, updates status to "imported ✓", button changes to "Clear Key"
  - On `{ok: false, error}`: shows inline error message; input stays open
- Tapping **Cancel**: collapses the sub-row without changes
- All buttons wired via `wireTap()` (required for Android WebView)

### Clear flow

Tapping **Clear Key** calls `Sftp.clearKey()` and updates the status row back to "not imported / Import Key".

## Files Changed

| File | Change |
|------|--------|
| `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java` | Add `importKey()`, `clearKey()`, `getKeyStatus()`, `loadStoredKey()` helper; update `upload()` and `download()` auth setup |
| `web/cockpit/config-editor.js` | Add SSH Key status row + import/clear UI to Flight Upload card; call `getKeyStatus()` in `_render()` |

## User Workflow

1. Copy private key file to device SD card (e.g. `Documents/id_rsa`) via USB from laptop or Tailscale file drop
2. Open FlyTab → Configuration → Flight Upload (SFTP)
3. Tap **Import Key**, enter `id_rsa` (or full path), tap **Import**
4. Status shows "imported ✓" — the SD card file can now be deleted
5. All SFTP operations (flight upload, APK download) try the key automatically; password used as fallback if key is rejected or as passphrase if key is passphrase-protected

## Out of Scope

- Key pair generation on device (user already has a working key via Terminus)
- Multiple key slots (one key at a time)
- Passphrase prompt separate from the SFTP password (password field serves as passphrase)
- Public key display / `authorized_keys` helper
