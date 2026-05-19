# Flight Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SFTP upload of completed flight CSV files from the on-device SD card to a user-configured server (LAN or Tailscale), with encrypted password storage and a More-drawer panel showing file status.

**Architecture:** A new Java Capacitor plugin (`SftpPlugin`) handles SFTP via the mwiede/jsch library and encrypts the password using Android EncryptedSharedPreferences. The JS panel (`FlightUpload`) lists files from the existing `/flights/list` NanoHTTPD endpoint (extended to include size/date metadata), tracks upload status in `localStorage`, and calls the plugin via `Capacitor.Plugins.Sftp`.

**Tech Stack:** mwiede/jsch 0.2.17, androidx.security:security-crypto 1.0.0, Capacitor 6, vanilla JS

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `android/app/src/main/java/app/flywhere/flytab/tileserver/TileServer.java` | Modify | Extend `handleFlightsList()` to return `[{name, size_bytes, modified_ms}]` |
| `android/app/build.gradle` | Modify | Add jsch + security-crypto dependencies |
| `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java` | Create | Capacitor plugin: upload, savePassword, getPassword, clearPassword |
| `android/app/src/main/java/app/flywhere/flytab/MainActivity.java` | Modify | Register SftpPlugin |
| `web/cockpit-config.json` | Modify | Add `flightUpload` default block |
| `web/cockpit/config-editor.js` | Modify | Add Flight Upload card to Connection section |
| `web/cockpit/flight-upload.js` | Create | Full-screen panel: file list, upload status, password modal |
| `web/index.html` | Modify | Add `<script>` tag for flight-upload.js |
| `web/app.js` | Modify | Instantiate FlightUpload, pass to TabBar, add to hide-all list |
| `web/cockpit/tab-bar.js` | Modify | Add "Flight Upload" row to More drawer |

---

### Task 1: Extend TileServer flights/list to include file metadata

`handleFlightsList()` currently returns a plain JSON array of strings. Change it to return an array of objects with `name`, `size_bytes`, and `modified_ms` so the JS panel can display file size and date.

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/tileserver/TileServer.java:511-535`

- [ ] **Step 1: Replace the handleFlightsList method body**

  In `TileServer.java`, replace the `handleFlightsList()` method (lines 511–535) with:

  ```java
  /**
   * GET /flights/list
   * Returns JSON array of flight CSV metadata sorted newest-first.
   * [{name: "20260519_KLKR-KAVL.csv", size_bytes: 12340, modified_ms: 1747689600000}, ...]
   */
  private Response handleFlightsList() {
      File flightsDir = new File(baseDir, "flights");
      if (!flightsDir.isDirectory()) {
          return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
      }
      File[] files = flightsDir.listFiles();
      if (files == null || files.length == 0) {
          return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
      }
      java.util.List<File> csvs = new java.util.ArrayList<>();
      for (File f : files) {
          if (f.isFile() && f.getName().toLowerCase().endsWith(".csv")) {
              csvs.add(f);
          }
      }
      csvs.sort((a, b) -> b.getName().compareTo(a.getName()));
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < csvs.size(); i++) {
          File f = csvs.get(i);
          if (i > 0) sb.append(",");
          String escaped = f.getName().replace("\\", "\\\\").replace("\"", "\\\"");
          sb.append("{")
            .append("\"name\":\"").append(escaped).append("\",")
            .append("\"size_bytes\":").append(f.length()).append(",")
            .append("\"modified_ms\":").append(f.lastModified())
            .append("}");
      }
      sb.append("]");
      return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
  }
  ```

- [ ] **Step 2: Verify the change compiles (no build yet — just a compile check)**

  ```bash
  cd /home/dananickerson/flytab/android
  ./gradlew :app:compileDebugJavaSources 2>&1 | tail -20
  ```
  Expected: `BUILD SUCCESSFUL` with no errors in `TileServer.java`.

- [ ] **Step 3: Commit**

  ```bash
  git add android/app/src/main/java/app/flywhere/flytab/tileserver/TileServer.java
  git commit -m "feat(tileserver): extend /flights/list to return name, size_bytes, modified_ms"
  ```

---

### Task 2: Add Gradle dependencies for SFTP and encrypted storage

**Files:**
- Modify: `android/app/build.gradle:33-53`

- [ ] **Step 1: Add dependencies to app/build.gradle**

  In the `dependencies { }` block (after the okhttp3 line), add:

  ```groovy
  // SFTP upload for flight files
  implementation 'com.github.mwiede:jsch:0.2.17'
  // Encrypted password storage (Keystore-backed AES-256)
  implementation 'androidx.security:security-crypto:1.0.0'
  ```

- [ ] **Step 2: Sync and verify dependencies resolve**

  ```bash
  cd /home/dananickerson/flytab/android
  ./gradlew :app:dependencies --configuration debugRuntimeClasspath 2>&1 | grep -E "jsch|security-crypto"
  ```
  Expected output contains:
  ```
  com.github.mwiede:jsch:0.2.17
  androidx.security:security-crypto:1.0.0
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add android/app/build.gradle
  git commit -m "build(android): add mwiede/jsch and security-crypto dependencies"
  ```

---

### Task 3: Create SftpPlugin.java

New Capacitor plugin with four methods: `upload`, `savePassword`, `getPassword`, `clearPassword`. All I/O runs on a background executor thread so the Capacitor bridge is never blocked.

**Files:**
- Create: `android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java`

- [ ] **Step 1: Create the file**

  ```java
  package app.flywhere.flytab;

  import android.os.Environment;
  import android.util.Log;

  import androidx.security.crypto.EncryptedSharedPreferences;
  import androidx.security.crypto.MasterKey;

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

  @CapacitorPlugin(name = "Sftp")
  public class SftpPlugin extends Plugin {
      private static final String TAG = "SftpPlugin";
      private static final String PREFS_NAME = "flytab_sftp_prefs";
      private static final String KEY_PASSWORD = "sftp_password";

      private final ExecutorService executor = Executors.newSingleThreadExecutor();

      /**
       * Upload a flight CSV from Documents/FlyTab/flights/ to a remote SFTP server.
       * Runs on background thread; resolves with {ok, error?}.
       */
      @PluginMethod
      public void upload(PluginCall call) {
          String host = call.getString("host");
          int port = call.getInt("port", 22);
          String username = call.getString("username");
          String filename = call.getString("filename");
          String remotePath = call.getString("remotePath", "~/flights");
          String password = call.getString("password");

          if (host == null || username == null || filename == null || password == null) {
              call.reject("Missing required parameters: host, username, filename, password");
              return;
          }
          if (filename.contains("..") || filename.contains("/")) {
              call.reject("Invalid filename");
              return;
          }

          File flightsDir = new File(
              Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
              "FlyTab/flights"
          );
          File localFile = new File(flightsDir, filename);
          if (!localFile.exists()) {
              call.reject("File not found: " + filename);
              return;
          }

          final String finalHost = host;
          final int finalPort = port;
          final String finalUsername = username;
          final String finalRemotePath = remotePath;
          final String finalPassword = password;

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

                  // Create remote directory if it doesn't exist (ignore error if it does)
                  try { channel.mkdir(finalRemotePath); } catch (Exception ignored) {}
                  channel.cd(finalRemotePath);

                  try (FileInputStream fis = new FileInputStream(localFile)) {
                      channel.put(fis, filename);
                  }

                  JSObject result = new JSObject();
                  result.put("ok", true);
                  call.resolve(result);

              } catch (Exception e) {
                  Log.e(TAG, "SFTP upload failed for " + filename, e);
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

      /** Encrypt and persist the SFTP password using Android Keystore-backed AES-256. */
      @PluginMethod
      public void savePassword(PluginCall call) {
          String password = call.getString("password");
          if (password == null) { call.reject("Missing password"); return; }
          try {
              getEncryptedPrefs().edit().putString(KEY_PASSWORD, password).apply();
              call.resolve();
          } catch (Exception e) {
              Log.e(TAG, "Failed to save password", e);
              call.reject("Failed to save password: " + e.getMessage());
          }
      }

      /** Retrieve the stored password. Returns {password: null} if not set. */
      @PluginMethod
      public void getPassword(PluginCall call) {
          try {
              String password = getEncryptedPrefs().getString(KEY_PASSWORD, null);
              JSObject result = new JSObject();
              result.put("password", password);
              call.resolve(result);
          } catch (Exception e) {
              Log.e(TAG, "Failed to get password", e);
              JSObject result = new JSObject();
              result.put("password", (String) null);
              call.resolve(result);
          }
      }

      /** Remove the stored password. */
      @PluginMethod
      public void clearPassword(PluginCall call) {
          try {
              getEncryptedPrefs().edit().remove(KEY_PASSWORD).apply();
              call.resolve();
          } catch (Exception e) {
              Log.e(TAG, "Failed to clear password", e);
              call.reject("Failed to clear password: " + e.getMessage());
          }
      }

      private android.content.SharedPreferences getEncryptedPrefs() throws Exception {
          MasterKey masterKey = new MasterKey.Builder(getContext())
              .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
              .build();
          return EncryptedSharedPreferences.create(
              getContext(),
              PREFS_NAME,
              masterKey,
              EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
              EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
          );
      }
  }
  ```

- [ ] **Step 2: Verify the file compiles**

  ```bash
  cd /home/dananickerson/flytab/android
  ./gradlew :app:compileDebugJavaSources 2>&1 | tail -20
  ```
  Expected: `BUILD SUCCESSFUL`. No errors in `SftpPlugin.java`.

- [ ] **Step 3: Commit**

  ```bash
  git add android/app/src/main/java/app/flywhere/flytab/SftpPlugin.java
  git commit -m "feat(android): add SftpPlugin — SFTP upload with EncryptedSharedPreferences password"
  ```

---

### Task 4: Register SftpPlugin in MainActivity

**Files:**
- Modify: `android/app/src/main/java/app/flywhere/flytab/MainActivity.java:1-30`

- [ ] **Step 1: Add import and registration**

  After line 18 (`import app.flywhere.flytab.engineml.EngineMLPlugin;`), add:

  ```java
  import app.flywhere.flytab.SftpPlugin;
  ```

  After line 27 (`registerPlugin(EngineMLPlugin.class);`), add:

  ```java
  registerPlugin(SftpPlugin.class);
  ```

- [ ] **Step 2: Verify compilation**

  ```bash
  cd /home/dananickerson/flytab/android
  ./gradlew :app:compileDebugJavaSources 2>&1 | tail -10
  ```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

  ```bash
  git add android/app/src/main/java/app/flywhere/flytab/MainActivity.java
  git commit -m "feat(android): register SftpPlugin in MainActivity"
  ```

---

### Task 5: Add flightUpload config defaults

**Files:**
- Modify: `web/cockpit-config.json`

- [ ] **Step 1: Add the flightUpload block**

  In `web/cockpit-config.json`, after the `"flightRecording": { ... }` block, add:

  ```json
  "flightUpload": {
    "host": "",
    "port": 22,
    "username": "",
    "remotePath": "~/flights"
  },
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add web/cockpit-config.json
  git commit -m "feat(config): add flightUpload defaults block"
  ```

---

### Task 6: Add Flight Upload card to config-editor.js

Add a new card in the Connection section so the pilot can configure SFTP host, port, username, and remote path. Saved via custom logic in `_save()` the same way as the Home Server card.

**Files:**
- Modify: `web/cockpit/config-editor.js`

- [ ] **Step 1: Add the Flight Upload card to _render()**

  In `_render()`, find the block that renders the Stratux card (search for `ce-stratux-ip`). After the closing `</div>` of that card's outer `<div class="ds-card">`, add:

  ```javascript
  const fu = this._cockpitConfig.flightUpload || {};
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
          <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
              Password is stored encrypted on device. Use More → Flight Upload to manage it.
          </div>
      </div>
  </div>`);
  ```

- [ ] **Step 2: Collect Flight Upload fields in _save()**

  In `_save()`, find where Stratux IP is collected (search for `ce-stratux-ip`). After that block, add:

  ```javascript
  // Flight Upload settings
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

- [ ] **Step 3: Commit**

  ```bash
  git add web/cockpit/config-editor.js
  git commit -m "feat(config-editor): add Flight Upload SFTP configuration card"
  ```

---

### Task 7: Create flight-upload.js panel

Full-screen overlay following the `Logbook` pattern. Lists flight CSVs from `/flights/list`, shows date + size + upload badge per row, handles password prompting and encrypted storage, tracks upload status in `localStorage`.

**Files:**
- Create: `web/cockpit/flight-upload.js`

- [ ] **Step 1: Create the file**

  ```javascript
  /**
   * FlyTab — Flight Upload
   * Lists completed flight CSV files and uploads them via SFTP.
   * Upload status persisted in localStorage; password stored encrypted via SftpPlugin.
   */

  class FlightUpload {
      static LOCAL_BASE = 'http://localhost:9090';
      static STORAGE_KEY = 'flytab_uploaded_flights';

      constructor() {
          this._el = null;
          this._visible = false;
          this._flights = [];
          this._uploadedSet = new Set(
              JSON.parse(localStorage.getItem(FlightUpload.STORAGE_KEY) || '[]')
          );
          this._buildDOM();
      }

      show() {
          this._el.classList.add('visible');
          this._visible = true;
          this._setMapControlsVisible(false);
          this._loadFlights();
      }

      hide() {
          this._el.classList.remove('visible');
          this._visible = false;
          this._setMapControlsVisible(true);
      }

      toggle() { this._visible ? this.hide() : this.show(); }

      // ── Private ──────────────────────────────────────────────────────────────

      async _loadFlights() {
          const listEl = this._el.querySelector('.fu-list');
          listEl.innerHTML = '<div class="ds-loading">Loading flights...</div>';
          try {
              const resp = await fetch(`${FlightUpload.LOCAL_BASE}/flights/list`);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              this._flights = await resp.json();
              this._render();
          } catch (err) {
              listEl.innerHTML = `<div class="ds-error">Failed to load flights: ${err.message}</div>`;
          }
      }

      _render() {
          const listEl = this._el.querySelector('.fu-list');
          if (!this._flights.length) {
              listEl.innerHTML = '<div style="padding:24px;color:var(--text-secondary);text-align:center;">No flight files found.</div>';
              return;
          }
          listEl.innerHTML = '';
          for (const flight of this._flights) {
              const name = flight.name;
              const date = this._parseDate(name, flight.modified_ms);
              const size = this._formatSize(flight.size_bytes);
              const uploaded = this._uploadedSet.has(name);

              const row = document.createElement('div');
              row.className = 'fu-row';
              row.innerHTML = `
                  <div class="fu-row-info">
                      <div class="fu-filename">${name}</div>
                      <div class="fu-meta">${date}${size ? ' · ' + size : ''}</div>
                  </div>
                  <div class="fu-row-actions">
                      <span class="fu-badge ${uploaded ? 'fu-badge--uploaded' : 'fu-badge--pending'}">
                          ${uploaded ? 'UPLOADED' : 'PENDING'}
                      </span>
                      <button class="fu-upload-btn${uploaded ? ' fu-upload-btn--done' : ''}"
                              data-filename="${name}"${uploaded ? ' disabled' : ''}>
                          ${uploaded ? '✓' : 'Upload'}
                      </button>
                  </div>
              `;

              if (!uploaded) {
                  const btn = row.querySelector('.fu-upload-btn');
                  wireTap(btn, () => this._uploadOne(name, row));
              }
              listEl.appendChild(row);
          }
      }

      _parseDate(name, modifiedMs) {
          // Prefer filename prefix YYYYMMDD
          const m = name.match(/^(\d{4})(\d{2})(\d{2})/);
          if (m) {
              const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
              return d.toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
              });
          }
          // Fallback: use filesystem modified time
          if (modifiedMs) {
              return new Date(modifiedMs).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric'
              });
          }
          return '';
      }

      _formatSize(bytes) {
          if (!bytes) return '';
          if (bytes < 1024) return `${bytes} B`;
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
          return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      }

      async _uploadOne(filename, rowEl) {
          const cfg = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('flightUpload')) || {};
          if (!cfg.host || !cfg.username) {
              window.app?.showToast('Set SFTP host and username in Configuration → Flight Upload first.', null, 4000);
              return;
          }

          const password = await this._getOrPromptPassword();
          if (password === null) return;

          const btn = rowEl.querySelector('.fu-upload-btn');
          const origText = btn.textContent;
          btn.textContent = '...';
          btn.disabled = true;

          try {
              const result = await Capacitor.Plugins.Sftp.upload({
                  host: cfg.host,
                  port: cfg.port || 22,
                  username: cfg.username,
                  filename,
                  remotePath: cfg.remotePath || '~/flights',
                  password,
              });

              if (result.ok) {
                  this._markUploaded(filename, rowEl);
              } else {
                  btn.textContent = 'Retry';
                  btn.disabled = false;
                  window.app?.showToast(`Upload failed: ${result.error}`, null, 4000);
              }
          } catch (err) {
              btn.textContent = 'Retry';
              btn.disabled = false;
              window.app?.showToast(`Upload error: ${err.message}`, null, 4000);
          }
      }

      async _uploadAllPending() {
          const pending = this._flights.filter(f => !this._uploadedSet.has(f.name));
          if (!pending.length) {
              window.app?.showToast('No pending flights.', null, 2000);
              return;
          }

          const cfg = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('flightUpload')) || {};
          if (!cfg.host || !cfg.username) {
              window.app?.showToast('Set SFTP host and username in Configuration → Flight Upload first.', null, 4000);
              return;
          }

          const password = await this._getOrPromptPassword();
          if (password === null) return;

          const btn = this._el.querySelector('.fu-upload-all-btn');
          btn.disabled = true;
          btn.textContent = `Uploading 0 / ${pending.length}...`;

          let uploaded = 0;
          for (const flight of pending) {
              const rowEl = this._el.querySelector(`[data-filename="${flight.name}"]`)?.closest('.fu-row');
              try {
                  const result = await Capacitor.Plugins.Sftp.upload({
                      host: cfg.host,
                      port: cfg.port || 22,
                      username: cfg.username,
                      filename: flight.name,
                      remotePath: cfg.remotePath || '~/flights',
                      password,
                  });
                  if (result.ok) {
                      this._markUploaded(flight.name, rowEl);
                      uploaded++;
                      btn.textContent = `Uploading ${uploaded} / ${pending.length}...`;
                  } else {
                      window.app?.showToast(`Stopped: ${flight.name} — ${result.error}`, null, 4000);
                      break;
                  }
              } catch (err) {
                  window.app?.showToast(`Error: ${err.message}`, null, 4000);
                  break;
              }
          }

          btn.disabled = false;
          btn.textContent = 'Upload All Pending';
          if (uploaded > 0) {
              window.app?.showToast(`Uploaded ${uploaded} flight${uploaded !== 1 ? 's' : ''}.`, null, 3000);
          }
      }

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
                      <input type="password" id="_fu-pw" placeholder="Password" autocomplete="current-password"
                          style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
                                 border:1px solid #3a4a6a;background:#0e1628;color:#e8ecf0;
                                 font-size:16px;margin-bottom:12px;">
                      <label style="display:flex;align-items:center;gap:8px;color:#a0b0c8;font-size:14px;margin-bottom:20px;cursor:pointer;">
                          <input type="checkbox" id="_fu-save" checked style="width:18px;height:18px;">
                          Save password on device (encrypted)
                      </label>
                      <div style="display:flex;gap:12px;">
                          <button id="_fu-cancel" style="flex:1;padding:12px;border:none;border-radius:8px;
                                  background:#2a3a5c;color:#e8ecf0;font-size:16px;cursor:pointer;touch-action:manipulation;">
                              Cancel
                          </button>
                          <button id="_fu-ok" style="flex:1;padding:12px;border:none;border-radius:8px;
                                  background:#1e5caa;color:#fff;font-size:16px;font-weight:600;cursor:pointer;touch-action:manipulation;">
                              OK
                          </button>
                      </div>
                  </div>
              `;
              document.body.appendChild(modal);

              const pwEl = modal.querySelector('#_fu-pw');
              const saveEl = modal.querySelector('#_fu-save');
              setTimeout(() => pwEl.focus(), 100);

              modal.querySelector('#_fu-cancel').addEventListener('click', () => {
                  modal.remove();
                  resolve(null);
              });

              const doOk = async () => {
                  const pw = pwEl.value;
                  if (!pw) { pwEl.focus(); return; }
                  if (saveEl.checked) {
                      try { await Capacitor.Plugins.Sftp.savePassword({ password: pw }); } catch (_) {}
                  }
                  modal.remove();
                  resolve(pw);
              };

              modal.querySelector('#_fu-ok').addEventListener('click', doOk);
              pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOk(); });
          });
      }

      _markUploaded(filename, rowEl) {
          this._uploadedSet.add(filename);
          localStorage.setItem(FlightUpload.STORAGE_KEY,
              JSON.stringify([...this._uploadedSet]));
          if (!rowEl) return;
          const badge = rowEl.querySelector('.fu-badge');
          if (badge) { badge.className = 'fu-badge fu-badge--uploaded'; badge.textContent = 'UPLOADED'; }
          const btn = rowEl.querySelector('.fu-upload-btn');
          if (btn) { btn.textContent = '✓'; btn.className = 'fu-upload-btn fu-upload-btn--done'; btn.disabled = true; }
      }

      _buildDOM() {
          this._el = document.createElement('div');
          this._el.className = 'logbook-page';
          this._el.innerHTML = `
              <div class="logbook-header">
                  <span class="logbook-title">Flight Upload</span>
                  <button class="btn-close fu-close-btn">✕</button>
              </div>
              <div class="fu-toolbar">
                  <button class="fu-upload-all-btn">Upload All Pending</button>
                  <button class="fu-change-pw-btn">Change Password</button>
              </div>
              <div class="fu-list"></div>
          `;

          wireTap(this._el.querySelector('.fu-close-btn'), () => this.hide());
          wireTap(this._el.querySelector('.fu-upload-all-btn'), () => this._uploadAllPending());
          wireTap(this._el.querySelector('.fu-change-pw-btn'), async () => {
              try { await Capacitor.Plugins.Sftp.clearPassword(); } catch (_) {}
              window.app?.showToast('Password cleared. You will be prompted on next upload.', null, 3000);
          });

          document.body.appendChild(this._el);
      }

      _setMapControlsVisible(visible) {
          document.querySelectorAll('.leaflet-control-container')
              .forEach(c => c.style.display = visible ? '' : 'none');
      }
  }
  ```

- [ ] **Step 2: Add CSS for the panel rows to web/style.css**

  In `web/style.css`, find the logbook styles section (search for `.logbook-page`). After those styles, add:

  ```css
  /* Flight Upload panel */
  .fu-toolbar {
      display: flex;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color, #2a3a5c);
      flex-shrink: 0;
  }
  .fu-upload-all-btn,
  .fu-change-pw-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      color: #fff;
  }
  .fu-upload-all-btn { background: var(--status-ok, #1e8c3a); }
  .fu-change-pw-btn  { background: var(--bg-surface-raised, #2a3a5c); }
  .fu-list { flex: 1; overflow-y: auto; }
  .fu-row {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color, #2a3a5c);
      gap: 12px;
  }
  .fu-row-info { flex: 1; min-width: 0; }
  .fu-filename {
      color: var(--text-primary, #e8ecf0);
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
  }
  .fu-meta {
      color: var(--text-secondary, #6a8aaa);
      font-size: 13px;
      margin-top: 2px;
  }
  .fu-row-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
  }
  .fu-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 7px;
      border-radius: 4px;
      letter-spacing: 0.5px;
  }
  .fu-badge--uploaded { background: #1e4a1e; color: #4cdd6a; }
  .fu-badge--pending  { background: #2a2a2a; color: #8090a8; }
  .fu-upload-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      background: var(--status-ok, #1e8c3a);
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      min-width: 72px;
  }
  .fu-upload-btn--done {
      background: var(--bg-surface-raised, #2a3a5c);
      color: #4cdd6a;
      cursor: default;
  }
  .fu-upload-btn:disabled { opacity: 0.6; cursor: default; }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add web/cockpit/flight-upload.js web/style.css
  git commit -m "feat(web): add FlightUpload panel with SFTP upload, status tracking, encrypted password"
  ```

---

### Task 8: Wire FlightUpload into index.html, app.js, and tab-bar.js

**Files:**
- Modify: `web/index.html:130`
- Modify: `web/app.js:63-82` (constructor), `web/app.js:632-636` (instantiation), `web/app.js:863-881` (TabBar)
- Modify: `web/cockpit/tab-bar.js:59-72` (hide-all), `web/cockpit/tab-bar.js:146-149` (More drawer rows)

- [ ] **Step 1: Add script tag to index.html**

  In `web/index.html`, after line 130 (`<script src="./cockpit/flight-recorder.js"></script>`), add:

  ```html
  <script src="./cockpit/flight-upload.js"></script>
  ```

- [ ] **Step 2: Add flightUpload property to FlyTabApp constructor (app.js)**

  In `web/app.js`, in the constructor where other components are declared (around line 69–77), add:

  ```javascript
  this.flightUpload = null;
  ```

- [ ] **Step 3: Instantiate FlightUpload after Logbook (app.js)**

  In `web/app.js`, after the Logbook block (around line 636), add:

  ```javascript
  // Flight Upload panel
  if (typeof FlightUpload !== 'undefined') {
      this.flightUpload = new FlightUpload();
  }
  ```

- [ ] **Step 4: Pass flightUpload to TabBar and add to hide-all (app.js)**

  In `web/app.js`, in the `new TabBar({...})` call (around line 864), add `flightUpload: this.flightUpload,` to the components object.

  In `_selectTab()` in `web/cockpit/tab-bar.js` (around line 59–72, where `c.planSync?.hide` is called), add:

  ```javascript
  if (c.flightUpload?.hide) c.flightUpload.hide();
  ```

- [ ] **Step 5: Add "Flight Upload" to the More drawer rows (tab-bar.js)**

  In `web/cockpit/tab-bar.js`, in the `rows` array inside `_buildMoreDrawer()`, after the Logbook entry (`{ icon: '📋', label: 'Logbook', ...}`), add:

  ```javascript
  { icon: '📤', label: 'Flight Upload', action: () => {
      if (c.flightUpload?.show) c.flightUpload.show();
      this._hideRadarControls();
      this._closeMoreDrawer();
  }},
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add web/index.html web/app.js web/cockpit/tab-bar.js
  git commit -m "feat(web): wire FlightUpload into app — index.html, app.js, tab-bar More drawer"
  ```

---

### Task 9: Build and verify

- [ ] **Step 1: Increment FLYTAB_VERSION in web/app.js**

  Find `FLYTAB_VERSION` at the top of `web/app.js` and increment the minor version (e.g. `v8.69` → `v8.70`).

- [ ] **Step 2: Build**

  ```bash
  cd /home/dananickerson/flytab
  bash build.sh
  ```
  Expected: `BUILD SUCCESSFUL`. APK copied to `data/`.

- [ ] **Step 3: Install on tablet and smoke-test**

  ```bash
  adb connect 192.168.1.82
  adb install -r data/flytab-debug-v8.70.apk
  ```

  Verify:
  1. More drawer shows "Flight Upload" entry
  2. Tapping it opens the panel; panel shows list of CSV filenames with dates and sizes
  3. PENDING badge shows on unuploaded files
  4. Tapping Upload prompts for password (with "Save password" checkbox)
  5. After entry, upload proceeds and badge flips to UPLOADED (green)
  6. Second upload attempt does not prompt for password — uses stored value
  7. "Change Password" clears the stored password; next upload prompts again
  8. Configuration → Flight Upload card shows Host / Port / Username / Remote Path fields and saves correctly

- [ ] **Step 4: Commit version bump**

  ```bash
  git add web/app.js
  git commit -m "chore: bump version to v8.70"
  ```
