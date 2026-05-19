# APK Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download & Install Update" button at the top of the Configuration editor that downloads a new APK from the pilot's SFTP server and launches the Android system installer.

**Architecture:** Two new methods (`download`, `installApk`) are added to the existing `SftpPlugin.java` Capacitor plugin. The config editor gains a new `apkRemotePath` field in its existing Flight Upload SFTP card, and a button bar at the top of the page body that triggers the download → install flow using the same encrypted password already stored for flight uploads.

**Tech Stack:** Java (Capacitor plugin / JSch SFTP / FileProvider), vanilla JS (no bundler), Android `REQUEST_INSTALL_PACKAGES` permission, `androidx.core.content.FileProvider`

**Spec:** `docs/superpowers/specs/2026-05-19-apk-update-design.md`

---

> **No unit test infrastructure exists** for Capacitor plugins or cockpit JS components in this repo (`npm test` covers only `web/shared/planning/`). Each task includes build-and-verify steps instead of TDD loops.

---

### Task 1: Add `apkRemotePath` to config + Flight Upload card

**Files:**
- Modify: `web/cockpit-config.json`
- Modify: `web/cockpit/config-editor.js` (lines 176–206 for card HTML, lines 354–364 for `_save()`)

- [ ] **Step 1: Add `apkRemotePath` field to `cockpit-config.json`**

In `web/cockpit-config.json`, locate the `"flightUpload"` block (currently lines 86–91):

```json
  "flightUpload": {
    "host": "",
    "port": 22,
    "username": "",
    "remotePath": "~/flights"
  },
```

Replace with:

```json
  "flightUpload": {
    "host": "",
    "port": 22,
    "username": "",
    "remotePath": "~/flights",
    "apkRemotePath": ""
  },
```

- [ ] **Step 2: Add `ce-fu-apk` input to the Flight Upload card in `_render()`**

In `web/cockpit/config-editor.js`, the Flight Upload card is built around line 176. Find the block ending with the hint text about password management:

```javascript
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Password is stored encrypted on device. Use More → Flight Upload to manage it.
                </div>
```

Insert a new field row **before** that hint row:

```javascript
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-apk">APK Remote Path</label>
                    <input type="text" id="ce-fu-apk" class="ce-input" style="width:220px"
                        placeholder="~/flytab/flytab-latest.apk"
                        value="${fu.apkRemotePath || ''}">
                </div>
```

The full updated card (for reference — replace the entire `sections.push(...)` for the Flight Upload card):

```javascript
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">Flight Upload (SFTP)</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-host">Host</label>
                    <input type="text" id="ce-fu-host" class="ce-input" style="width:220px"
                        placeholder="192.168.1.81 or hostname.ts.net"
                        value="${fu.host || ''}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-port">Port</label>
                    <input type="number" id="ce-fu-port" class="ce-input" style="width:80px"
                        min="1" max="65535" value="${fu.port || 22}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-user">Username</label>
                    <input type="text" id="ce-fu-user" class="ce-input" style="width:150px"
                        value="${fu.username || ''}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-path">Remote Path</label>
                    <input type="text" id="ce-fu-path" class="ce-input" style="width:220px"
                        placeholder="~/flights"
                        value="${fu.remotePath || '~/flights'}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-apk">APK Remote Path</label>
                    <input type="text" id="ce-fu-apk" class="ce-input" style="width:220px"
                        placeholder="~/flytab/flytab-latest.apk"
                        value="${fu.apkRemotePath || ''}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Password is stored encrypted on device. Use More → Flight Upload to manage it.
                </div>
            </div>
        </div>`);
```

- [ ] **Step 3: Collect `apkRemotePath` in `_save()`**

In `_save()`, find the Flight Upload block (lines ~354–364):

```javascript
            const fuHost = body.querySelector('#ce-fu-host');
            const fuPort = body.querySelector('#ce-fu-port');
            const fuUser = body.querySelector('#ce-fu-user');
            const fuPath = body.querySelector('#ce-fu-path');
            if (fuHost) {
                if (!this._cockpitConfig.flightUpload) this._cockpitConfig.flightUpload = {};
                this._cockpitConfig.flightUpload.host = fuHost.value.trim();
                this._cockpitConfig.flightUpload.port = parseInt(fuPort?.value || '22', 10) || 22;
                this._cockpitConfig.flightUpload.username = fuUser?.value.trim() || '';
                this._cockpitConfig.flightUpload.remotePath = fuPath?.value.trim() || '~/flights';
            }
```

Replace with:

```javascript
            const fuHost = body.querySelector('#ce-fu-host');
            const fuPort = body.querySelector('#ce-fu-port');
            const fuUser = body.querySelector('#ce-fu-user');
            const fuPath = body.querySelector('#ce-fu-path');
            const fuApk  = body.querySelector('#ce-fu-apk');
            if (fuHost) {
                if (!this._cockpitConfig.flightUpload) this._cockpitConfig.flightUpload = {};
                this._cockpitConfig.flightUpload.host = fuHost.value.trim();
                this._cockpitConfig.flightUpload.port = parseInt(fuPort?.value || '22', 10) || 22;
                this._cockpitConfig.flightUpload.username = fuUser?.value.trim() || '';
                this._cockpitConfig.flightUpload.remotePath = fuPath?.value.trim() || '~/flights';
                this._cockpitConfig.flightUpload.apkRemotePath = fuApk?.value.trim() || '';
            }
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit-config.json web/cockpit/config-editor.js
git commit -m "feat(apk-update): add apkRemotePath config field and Flight Upload card input"
```

---

### Task 2: Add `download()` + `installApk()` to `SftpPlugin.java` + manifest permission

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Add `REQUEST_INSTALL_PACKAGES` permission to `AndroidManifest.xml`**

In `android/app/src/main/AndroidManifest.xml`, find the existing permissions block (around line 61). Add immediately after `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`:

```xml
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

- [ ] **Step 2: Add imports to `SftpPlugin.java`**

At the top of `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`, the existing imports end around line 17. Add three new imports after the existing ones:

```java
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
```

Also add `FileOutputStream` to the java.io imports line. The full updated import block should be:

```java
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.io.File;
import java.io.FileInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
```

- [ ] **Step 3: Add `download()` plugin method**

In `SftpPlugin.java`, add the following method after the closing brace of the `upload()` method (after line 105):

```java
    /**
     * Download a file from the SFTP server to the app's cache dir as flytab-update.apk.
     * Runs on background thread; resolves with {ok, error?}.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 22);
        String username = call.getString("username");
        String password = call.getString("password");
        String remoteFile = call.getString("remoteFile");

        if (host == null || username == null || password == null || remoteFile == null) {
            call.reject("Missing required parameters: host, username, password, remoteFile");
            return;
        }

        final File localFile = new File(getContext().getCacheDir(), "flytab-update.apk");
        final String finalHost = host;
        final int finalPort = port;
        final String finalUsername = username;
        final String finalPassword = password;
        final String finalRemoteFile = remoteFile;

        executor.execute(() -> {
            Session session = null;
            ChannelSftp channel = null;
            try {
                JSch jsch = new JSch();
                session = jsch.getSession(finalUsername, finalHost, finalPort);
                session.setPassword(finalPassword);
                session.setConfig("StrictHostKeyChecking", "no");
                session.connect(30000);

                channel = (ChannelSftp) session.openChannel("sftp");
                channel.connect(10000);
                channel.get(finalRemoteFile, localFile.getAbsolutePath());

                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            } catch (Exception e) {
                Log.e(TAG, "SFTP download failed", e);
                JSObject result = new JSObject();
                result.put("ok", false);
                result.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
                call.resolve(result);
            } finally {
                if (channel != null) { try { channel.disconnect(); } catch (Exception ignored) {} }
                if (session != null) { try { session.disconnect(); } catch (Exception ignored) {} }
            }
        });
    }
```

- [ ] **Step 4: Add `installApk()` plugin method**

Add immediately after the closing brace of `download()`:

```java
    /**
     * Launch the system installer for flytab-update.apk in the app cache dir.
     * The user must tap Install in the system dialog — Android enforces this.
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        File apkFile = new File(getContext().getCacheDir(), "flytab-update.apk");
        if (!apkFile.exists()) {
            call.reject("APK not found — call download() first");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch installer", e);
            call.reject("Failed to launch installer: " + e.getMessage());
        }
    }
```

- [ ] **Step 5: Verify the plugin compiles**

```bash
cd /home/dananickerson/flytab/android && ./gradlew :app:compileDebugJavaSources 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`. If any import or method errors appear, fix them before proceeding.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(apk-update): add download() and installApk() to SftpPlugin + REQUEST_INSTALL_PACKAGES"
```

---

### Task 3: Add "Download & Install Update" bar + flow to `config-editor.js` + CSS

**Files:**
- Modify: `web/cockpit/config-editor.js`
- Modify: `web/style.css`

- [ ] **Step 1: Add `.ce-update-bar` CSS to `style.css`**

In `web/style.css`, find the `.ce-actions` block (around line 2614). Add the following block immediately **before** `.ce-actions`:

```css
.ce-update-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    background: var(--bg-surface-raised, #1a2540);
    border-bottom: 2px solid var(--border, #2a3a5c);
    margin-bottom: 4px;
}
.ce-update-btn {
    padding: 12px 20px;
    border: none;
    border-radius: 8px;
    background: #1e5caa;
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    touch-action: manipulation;
    white-space: nowrap;
    letter-spacing: 0.3px;
}
.ce-update-btn:disabled { opacity: 0.6; cursor: default; }
.ce-update-status {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-secondary, #a0b8d0);
    flex: 1;
}
```

- [ ] **Step 2: Add `ce-update-bar` to `_render()` as the first item in `sections`**

In `config-editor.js`, `_render()` starts building `sections` with `const sections = [];`. Add the update bar as the first push, immediately after `const sections = [];`:

```javascript
        sections.push(`<div class="ce-update-bar">
            <button class="ce-update-btn">&#11015; Download &amp; Install Update</button>
            <span class="ce-update-status"></span>
        </div>`);
```

- [ ] **Step 3: Wire the button with `wireTap` and exclude bar from search**

In `_render()`, the button wiring block currently ends at:

```javascript
        wireTap(body.querySelector('.ce-save-btn'), () => this._save());
        wireTap(body.querySelector('.ce-reload-btn'), () => this._load());
```

Add the update button wire immediately after those two lines:

```javascript
        wireTap(body.querySelector('.ce-update-btn'), () => this._downloadAndInstall());
```

Then in `_applySearch()`, find:

```javascript
            if (child.classList.contains('ce-actions')) {
                child.style.display = '';
                return;
            }
```

Replace with:

```javascript
            if (child.classList.contains('ce-actions') || child.classList.contains('ce-update-bar')) {
                child.style.display = '';
                return;
            }
```

- [ ] **Step 4: Add `_getOrPromptPassword()` to `ConfigEditor`**

Add this method to the `ConfigEditor` class, before the closing `}` of the class. It mirrors `FlightUpload._getOrPromptPassword()` but uses `_ce-pw` / `_ce-save` / `_ce-cancel` / `_ce-ok` element IDs to avoid conflicts if both panels are somehow open simultaneously:

```javascript
    async _getOrPromptPassword() {
        try {
            const stored = await Capacitor.Plugins.Sftp.getPassword();
            if (stored.password) return stored.password;
        } catch (_) {}

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:300000',
                'background:rgba(0,0,0,0.75)',
                'display:flex', 'align-items:center', 'justify-content:center',
                'font-family:-apple-system,system-ui,sans-serif'
            ].join(';');
            modal.innerHTML = `
                <div style="background:#1a2540;border-radius:12px;padding:24px;max-width:340px;width:90%;">
                    <div style="color:#e8ecf0;font-size:17px;font-weight:600;margin-bottom:16px;">SFTP Password</div>
                    <input type="password" id="_ce-pw" placeholder="Password" autocomplete="current-password"
                        style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
                               border:1px solid #3a4a6a;background:#0e1628;color:#e8ecf0;
                               font-size:16px;margin-bottom:12px;">
                    <label style="display:flex;align-items:center;gap:8px;color:#a0b0c8;font-size:14px;margin-bottom:20px;cursor:pointer;">
                        <input type="checkbox" id="_ce-save" checked style="width:18px;height:18px;">
                        Save password on device (encrypted)
                    </label>
                    <div style="display:flex;gap:12px;">
                        <button id="_ce-cancel" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#2a3a5c;color:#e8ecf0;font-size:16px;cursor:pointer;touch-action:manipulation;">
                            Cancel
                        </button>
                        <button id="_ce-ok" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#1e5caa;color:#fff;font-size:16px;font-weight:600;cursor:pointer;touch-action:manipulation;">
                            OK
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const pwEl  = modal.querySelector('#_ce-pw');
            const saveEl = modal.querySelector('#_ce-save');
            setTimeout(() => pwEl.focus(), 100);

            const doOk = async () => {
                const pw = pwEl.value;
                if (!pw) { pwEl.focus(); return; }
                if (saveEl.checked) {
                    try { await Capacitor.Plugins.Sftp.savePassword({ password: pw }); } catch (_) {}
                }
                modal.remove();
                resolve(pw);
            };

            wireTap(modal.querySelector('#_ce-cancel'), () => { modal.remove(); resolve(null); });
            wireTap(modal.querySelector('#_ce-ok'), doOk);
            pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOk(); });
        });
    }
```

- [ ] **Step 5: Add `_downloadAndInstall()` to `ConfigEditor`**

Add immediately after `_getOrPromptPassword()`, before the closing `}` of the class:

```javascript
    async _downloadAndInstall() {
        const body = this._el.querySelector('.config-editor-body');
        const btn = body.querySelector('.ce-update-btn');
        const statusEl = body.querySelector('.ce-update-status');

        // Read directly from DOM so unsaved form edits are honoured without a Save first.
        const host       = body.querySelector('#ce-fu-host')?.value.trim() || '';
        const port       = parseInt(body.querySelector('#ce-fu-port')?.value || '22', 10) || 22;
        const username   = body.querySelector('#ce-fu-user')?.value.trim() || '';
        const apkRemote  = body.querySelector('#ce-fu-apk')?.value.trim() || '';

        if (!host || !username || !apkRemote) {
            statusEl.textContent = 'Set Host, Username, and APK Remote Path in Flight Upload (SFTP) below.';
            statusEl.style.color = 'var(--status-danger, #c0392b)';
            return;
        }

        const password = await this._getOrPromptPassword();
        if (password === null) return;

        btn.disabled = true;
        statusEl.textContent = 'Downloading…';
        statusEl.style.color = 'var(--text-secondary, #a0b8d0)';

        try {
            const result = await Capacitor.Plugins.Sftp.download({
                host,
                port,
                username,
                password,
                remoteFile: apkRemote,
            });

            if (!result.ok) {
                statusEl.textContent = `Download failed: ${result.error}`;
                statusEl.style.color = 'var(--status-danger, #c0392b)';
                btn.disabled = false;
                return;
            }

            statusEl.textContent = 'Download complete. Launching installer…';
            statusEl.style.color = 'var(--status-ok, #1e8c3a)';
            await Capacitor.Plugins.Sftp.installApk();
            statusEl.textContent = '';
            btn.disabled = false;
        } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
            statusEl.style.color = 'var(--status-danger, #c0392b)';
            btn.disabled = false;
        }
    }
```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/config-editor.js web/style.css
git commit -m "feat(apk-update): Download & Install Update button in config editor"
```

---

### Task 4: Bump version and build

**Files:**
- Modify: `web/app.js` (version constant)

- [ ] **Step 1: Bump `FLYTAB_VERSION`**

In `web/app.js`, line 1:

```javascript
const FLYTAB_VERSION = 'v8.71';
```

- [ ] **Step 2: Build**

```bash
cd /home/dananickerson/flytab && bash build.sh
```

Expected: APK written to `data/flytab-debug.apk`, no compile errors.

- [ ] **Step 3: Verify config editor renders correctly**

```bash
adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)
```

Open `http://localhost:9223` in Chrome DevTools console and run:

```javascript
// Check the update bar rendered
document.querySelector('.ce-update-bar') !== null
// → true

// Check the APK field rendered (open config editor first)
document.querySelector('#ce-fu-apk') !== null
// → true
```

- [ ] **Step 4: Verify `Sftp.download` and `Sftp.installApk` are registered**

In the DevTools console:

```javascript
Object.keys(Capacitor.Plugins.Sftp)
// → should include 'download' and 'installApk' alongside 'upload', 'getPassword', etc.
```

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "build: bump to v8.71 — APK update feature"
```
