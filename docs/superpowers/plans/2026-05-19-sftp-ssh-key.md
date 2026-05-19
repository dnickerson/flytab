# SFTP SSH Key Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SSH private key authentication to the existing SFTP plugin so flight uploads and APK downloads work on servers that require key-based auth, with automatic fallback to password.

**Architecture:** Three new plugin methods (`importKey`, `clearKey`, `getKeyStatus`) and a private helper (`loadStoredKey`) are added to `SftpPlugin.java`. Both `upload()` and `download()` gain a pre-connect key-setup block that tries public key auth first, falls back to password automatically via `PreferredAuthentications`. The config editor's Flight Upload card gains an SSH Key status row with import/clear UI.

**Tech Stack:** Java (JSch `addIdentity` API, `android.util.Base64`, `EncryptedSharedPreferences`), vanilla JS (`wireTap`, async Capacitor plugin calls)

**Spec:** `docs/superpowers/specs/2026-05-19-sftp-ssh-key-design.md`

---

> **No unit test infrastructure** exists for Capacitor plugins or cockpit JS components. Each task includes a Gradle compile step and manual verification steps instead of TDD loops.

---

### Task 1: Add key management methods to `SftpPlugin.java`

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`

- [ ] **Step 1: Add `KEY_PRIVATE_KEY` constant and `StandardCharsets` import**

Add `import java.nio.charset.StandardCharsets;` after the existing `import java.io.FileInputStream;` line.

Add `private static final String KEY_PRIVATE_KEY = "sftp_private_key";` after the existing `KEY_PASSWORD` constant.

The updated constants + import block:

```java
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
```

```java
private static final String TAG = "SftpPlugin";
private static final String PREFS_NAME = "flytab_sftp_prefs";
private static final String KEY_PASSWORD = "sftp_password";
private static final String KEY_PRIVATE_KEY = "sftp_private_key";
```

- [ ] **Step 2: Add `importKey()` method**

Add the following method immediately after the closing `}` of `clearPassword()` (before `getEncryptedPrefs()`):

```java
    /**
     * Read a private key file from the SD card and store it encrypted on device.
     * keyPath: relative to Documents/ if no leading slash, else absolute.
     * Resolves {ok, error?} — never rejects.
     */
    @PluginMethod
    public void importKey(PluginCall call) {
        String keyPath = call.getString("keyPath");
        if (keyPath == null || keyPath.isEmpty()) {
            call.reject("Missing keyPath");
            return;
        }
        if (keyPath.contains("..")) {
            call.reject("Invalid keyPath");
            return;
        }

        File keyFile = keyPath.startsWith("/")
            ? new File(keyPath)
            : new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), keyPath);

        if (!keyFile.exists()) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", "File not found: " + keyFile.getAbsolutePath());
            call.resolve(result);
            return;
        }

        try {
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            try (FileInputStream fis = new FileInputStream(keyFile)) {
                while ((n = fis.read(buf)) != -1) baos.write(buf, 0, n);
            }
            String encoded = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.DEFAULT);
            getEncryptedPrefs().edit().putString(KEY_PRIVATE_KEY, encoded).apply();
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to import key", e);
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
            call.resolve(result);
        }
    }
```

- [ ] **Step 3: Add `clearKey()` method**

Add immediately after `importKey()`:

```java
    /** Remove the stored SSH private key. */
    @PluginMethod
    public void clearKey(PluginCall call) {
        try {
            getEncryptedPrefs().edit().remove(KEY_PRIVATE_KEY).apply();
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear key", e);
        }
        call.resolve();
    }
```

- [ ] **Step 4: Add `getKeyStatus()` method**

Add immediately after `clearKey()`:

```java
    /** Returns {hasKey: true} if a private key is stored, {hasKey: false} otherwise. */
    @PluginMethod
    public void getKeyStatus(PluginCall call) {
        try {
            String encoded = getEncryptedPrefs().getString(KEY_PRIVATE_KEY, null);
            JSObject result = new JSObject();
            result.put("hasKey", encoded != null);
            call.resolve(result);
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("hasKey", false);
            call.resolve(result);
        }
    }
```

- [ ] **Step 5: Add `loadStoredKey()` private helper**

Add immediately after `getKeyStatus()`, before `getEncryptedPrefs()`:

```java
    /** Decrypt and return stored private key bytes, or null if none stored. */
    private byte[] loadStoredKey() {
        try {
            String encoded = getEncryptedPrefs().getString(KEY_PRIVATE_KEY, null);
            if (encoded == null) return null;
            return android.util.Base64.decode(encoded, android.util.Base64.DEFAULT);
        } catch (Exception e) {
            Log.e(TAG, "Failed to load stored key", e);
            return null;
        }
    }
```

- [ ] **Step 6: Compile verify**

```bash
cd /home/dananickerson/flytab/android && ./gradlew :app:compileDebugSources 2>&1 | grep -E "error:|BUILD"
```

Expected: `BUILD SUCCESSFUL`. Fix any errors before committing.

- [ ] **Step 7: Commit**

```bash
cd /home/dananickerson/flytab
git add android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java
git commit -m "feat(sftp-key): add importKey, clearKey, getKeyStatus, loadStoredKey to SftpPlugin"
```

---

### Task 2: Add key auth to `upload()` and `download()`

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`

- [ ] **Step 1: Update auth setup in `upload()`**

In `upload()`, find this exact block (lines 76–80):

```java
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setPassword(finalPassword);
                session.setConfig("StrictHostKeyChecking", "no");
                session.connect(30000);
```

Replace with:

```java
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setConfig("StrictHostKeyChecking", "no");
                byte[] keyBytes = loadStoredKey();
                if (keyBytes != null) {
                    byte[] passphrase = finalPassword != null
                        ? finalPassword.getBytes(StandardCharsets.UTF_8) : null;
                    jsch.addIdentity("flytab", keyBytes, null, passphrase);
                }
                session.setConfig("PreferredAuthentications", "publickey,password");
                session.setPassword(finalPassword);
                session.connect(30000);
```

- [ ] **Step 2: Update auth setup in `download()`**

In `download()`, find this exact block (lines 138–142):

```java
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setPassword(finalPassword);
                session.setConfig("StrictHostKeyChecking", "no");
                session.connect(30000);
```

Replace with:

```java
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setConfig("StrictHostKeyChecking", "no");
                byte[] keyBytes = loadStoredKey();
                if (keyBytes != null) {
                    byte[] passphrase = finalPassword != null
                        ? finalPassword.getBytes(StandardCharsets.UTF_8) : null;
                    jsch.addIdentity("flytab", keyBytes, null, passphrase);
                }
                session.setConfig("PreferredAuthentications", "publickey,password");
                session.setPassword(finalPassword);
                session.connect(30000);
```

- [ ] **Step 3: Compile verify**

```bash
cd /home/dananickerson/flytab/android && ./gradlew :app:compileDebugSources 2>&1 | grep -E "error:|BUILD"
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
cd /home/dananickerson/flytab
git add android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java
git commit -m "feat(sftp-key): try key auth first in upload() and download(), fallback to password"
```

---

### Task 3: SSH Key UI in config editor + CSS

**Files:**
- Modify: `web/style.css`
- Modify: `web/cockpit/config-editor.js`

- [ ] **Step 1: Add `.ce-key-btn` CSS to `style.css`**

In `web/style.css`, find the `.ce-update-bar` block (the one added for the APK update feature, around line 2614). Add the following immediately **before** `.ce-update-bar`:

```css
.ce-key-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    background: var(--bg-surface-raised, #2a3a5c);
    color: var(--text-primary, #e8ecf0);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
    white-space: nowrap;
}
.ce-key-btn--cancel {
    background: transparent;
    border: 1px solid var(--border, #3a4a6a);
    color: var(--text-secondary, #a0b8d0);
}
```

- [ ] **Step 2: Add SSH Key rows to the Flight Upload card in `_render()`**

In `config-editor.js`, inside the Flight Upload card template string, find this exact block (the APK Remote Path field row):

```javascript
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-apk">APK Remote Path</label>
                    <input type="text" id="ce-fu-apk" class="ce-input" style="width:220px"
                        placeholder="~/flytab/flytab-latest.apk"
                        value="${fu.apkRemotePath || ''}">
                </div>
```

Insert the following two rows **before** that block:

```javascript
                <div class="ce-field-row">
                    <label class="ce-label">SSH Key</label>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="ce-fu-key-status" style="color:var(--text-secondary,#a0b8d0);font-size:14px;">checking…</span>
                        <button id="ce-fu-import-btn" class="ce-key-btn" style="display:none;">Import Key</button>
                        <button id="ce-fu-clear-btn" class="ce-key-btn" style="display:none;">Clear Key</button>
                    </div>
                </div>
                <div id="ce-fu-key-import-row" style="display:none;" class="ce-field-row">
                    <label class="ce-label"></label>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <input type="text" id="ce-fu-key-path" class="ce-input" style="width:200px"
                               placeholder="Documents/id_rsa">
                        <button id="ce-fu-key-do-import" class="ce-key-btn">Import</button>
                        <button id="ce-fu-key-cancel" class="ce-key-btn ce-key-btn--cancel">Cancel</button>
                        <span id="ce-fu-key-error" style="color:var(--status-danger,#c0392b);font-size:13px;width:100%;display:none;"></span>
                    </div>
                </div>
```

- [ ] **Step 3: Wire SSH Key buttons and load initial status in `_render()`**

In `_render()`, find this exact line:

```javascript
        wireTap(body.querySelector('.ce-update-btn'), () => this._downloadAndInstall());
```

Add the following block immediately after it:

```javascript
        // SSH key management
        if (typeof Capacitor !== 'undefined' && Capacitor.Plugins?.Sftp) {
            Capacitor.Plugins.Sftp.getKeyStatus()
                .then(({hasKey}) => this._updateKeyStatus(hasKey))
                .catch(() => this._updateKeyStatus(false));
        }
        wireTap(body.querySelector('#ce-fu-import-btn'), () => {
            body.querySelector('#ce-fu-key-import-row').style.display = '';
            body.querySelector('#ce-fu-key-path').value = '';
            const errEl = body.querySelector('#ce-fu-key-error');
            errEl.textContent = '';
            errEl.style.display = 'none';
        });
        wireTap(body.querySelector('#ce-fu-key-cancel'), () => {
            body.querySelector('#ce-fu-key-import-row').style.display = 'none';
        });
        wireTap(body.querySelector('#ce-fu-key-do-import'), async () => {
            const pathEl = body.querySelector('#ce-fu-key-path');
            const errEl = body.querySelector('#ce-fu-key-error');
            const keyPath = pathEl.value.trim();
            if (!keyPath) { pathEl.focus(); return; }
            const result = await Capacitor.Plugins.Sftp.importKey({ keyPath });
            if (result.ok) {
                body.querySelector('#ce-fu-key-import-row').style.display = 'none';
                this._updateKeyStatus(true);
            } else {
                errEl.textContent = result.error || 'Import failed';
                errEl.style.display = '';
            }
        });
        wireTap(body.querySelector('#ce-fu-clear-btn'), async () => {
            await Capacitor.Plugins.Sftp.clearKey();
            this._updateKeyStatus(false);
        });
```

- [ ] **Step 4: Add `_updateKeyStatus()` method to `ConfigEditor`**

Add the following method to the `ConfigEditor` class, immediately before the closing `}` of the class (after `_downloadAndInstall()`):

```javascript
    _updateKeyStatus(hasKey) {
        const body = this._el.querySelector('.config-editor-body');
        if (!body) return;
        const statusEl = body.querySelector('#ce-fu-key-status');
        const importBtn = body.querySelector('#ce-fu-import-btn');
        const clearBtn = body.querySelector('#ce-fu-clear-btn');
        if (!statusEl) return;
        if (hasKey) {
            statusEl.textContent = 'imported ✓';
            statusEl.style.color = '#1a8c35';
            if (importBtn) importBtn.style.display = 'none';
            if (clearBtn) clearBtn.style.display = '';
        } else {
            statusEl.textContent = 'not imported';
            statusEl.style.color = 'var(--text-secondary, #a0b8d0)';
            if (importBtn) importBtn.style.display = '';
            if (clearBtn) clearBtn.style.display = 'none';
        }
    }
```

- [ ] **Step 5: Commit**

```bash
cd /home/dananickerson/flytab
git add web/cockpit/config-editor.js web/style.css
git commit -m "feat(sftp-key): SSH Key import/clear UI in Flight Upload config card"
```

---

### Task 4: Bump version and build

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Bump `FLYTAB_VERSION`**

In `web/app.js`, line 1, change:

```javascript
const FLYTAB_VERSION = 'v8.71';
```

to:

```javascript
const FLYTAB_VERSION = 'v8.72';
```

- [ ] **Step 2: Build**

```bash
cd /home/dananickerson/flytab && bash build.sh
```

Expected: APK produced, `BUILD SUCCESSFUL`, no Java errors.

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "build: bump to v8.72 — SFTP SSH key auth"
```
