# Document Library Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the document library feature from the approved spec — import PDFs (file picker + Android share-intent), store and full-text search them offline, and ship the official FAA VFR/IFR chart legends pre-loaded.

**Architecture:** New IndexedDB store for document blobs, a shared PDF-page renderer extracted from the existing plate viewer, a new full-screen MORE-drawer panel with search, a text-extraction/lunr-indexing pipeline shared by both import paths (file picker and share-intent), and a native Android share-intent receiver (new Capacitor plugin, since this app has no share-receiving code today).

**Tech Stack:** Vanilla JS, no bundler, `<script>`-tag loading. PDF.js (already vendored) for rendering and text extraction. lunr.js 2.3.9 (vendored this session, `web/lib/lunr.min.js`) for search. IndexedDB via `NasrDB`'s existing generic helpers. Capacitor Java plugin for the native share-intent receiver.

**Spec:** `docs/superpowers/specs/2026-09-16-document-library-design.md`

## Global Constraints

- No `flypi_` prefix on the new IndexedDB store or any new key — see this repo's CLAUDE.md on why that prefix is legacy-only.
- All work happens fully offline — no network calls anywhere in this feature (matches the spec's Non-goals and this repo's Network Constraint rule).
- New cockpit UI follows this repo's Design Token Standards (`var(--touch-min, 56px)` touch targets, `font-weight: 700+`, no hardcoded hex, light theme only — no `data-mode="cockpit"`).
- **Prerequisite assets already committed to this branch** (done during plan-writing, not a task below): `web/lib/lunr.min.js` (vendored from the same CDN-fetch process as this repo's other `web/lib/` libs) and `android/app/src/main/assets/vfr-chart-legend.pdf` / `ifr-chart-legend.pdf` (extracted from the FAA's official Aeronautical Chart Users' Guide, `aeronav.faa.gov`, page ranges verified against its own table of contents — see those two commits' messages for full provenance).
- **Testability gap, closed as part of Task 1:** this repo has no existing IndexedDB mock in its test suite (`tests/shared/*.test.js` never touches IDB — confirmed during planning). Multiple tasks below need to test real IndexedDB CRUD behavior, so Task 1 adds `fake-indexeddb` as a devDependency — a small, standard, dev-only package (not shipped in the APK).
- **Spec correction, found during planning:** the spec assumed share-intent handling could "mirror the existing `flytab://` deep-link handling" (`appUrlOpen`). That's wrong — `appUrlOpen` fires for `VIEW`-intent custom-scheme URLs; a `SEND` intent carrying a shared file is structurally different (the file arrives as an intent extra, not a URL) and needs real native code this app doesn't have yet: `MainActivity.java` doesn't override `onNewIntent()` at all (needed because `launchMode="singleTask"` routes intents to a running instance there, not `onCreate()`), and no share-receiving Capacitor plugin exists. Task 5 below adds both, following this repo's own established custom-plugin pattern (`ThermalMonitorPlugin`, `SftpPlugin`, etc.), not the deep-link pattern.
- **No automated verification exists in this repo for native Java compiles or on-device UI behavior.** Every task touching `android/`, the MORE drawer, or a new panel's visual behavior includes a required manual/on-device (or at minimum `bash build.sh` compile-check) verification step, per this repo's own precedent (CLAUDE.md's Tap Handler Regression Rule) — not satisfied by an automated test passing.

---

## Task 1: `flytab_documents` IndexedDB store

**Files:**
- Modify: `web/shared/nasr-db.js` (`DB_VERSION` line 17, `onupgradeneeded` block starting line 29)
- Modify: `package.json` (add `fake-indexeddb` devDependency)
- Test: `tests/shared/nasr-db-documents.test.js` (new)

**Interfaces:**
- Produces: `NasrDB.saveDocument(doc)`, `NasrDB.getDocument(id)`, `NasrDB.getAllDocuments()`, `NasrDB.deleteDocument(id)`. Document shape: `{id: string, name: string, type: 'bundled'|'imported', sizeBytes: number, importedAt: string (ISO), blob: Blob}`.

**Context:** `NasrDB.DB_VERSION` is currently `8` (`nasr-db.js:17`). New stores are added via a guarded block inside `onupgradeneeded` (`nasr-db.js:29-...`), each wrapped in `if (!db.objectStoreNames.contains('name'))`. The generic `_get`/`_put`/`_getAll`/`_delete` helpers (`nasr-db.js:154-194`) already handle all transaction/promise boilerplate — new document methods are thin wrappers around those, matching the existing `flight_plans` store's own wrapper methods (`saveFlightPlan`/`getFlightPlan`) exactly.

- [ ] **Step 1: Add fake-indexeddb and write the failing test**

```bash
npm install --save-dev fake-indexeddb
```

```js
// tests/shared/nasr-db-documents.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();

describe('NasrDB document storage', () => {
    let db;

    beforeEach(() => {
        indexedDB = new IDBFactory(); // fresh in-memory DB per test — fake-indexeddb/auto polyfills IDBFactory globally
        db = new NasrDB();
    });

    it('saves and retrieves a document', async () => {
        const blob = new Blob(['%PDF-1.4 fake content'], { type: 'application/pdf' });
        const doc = { name: 'Test POH.pdf', type: 'imported', sizeBytes: blob.size, blob };
        await db.saveDocument(doc);
        expect(doc.id).toBeTruthy(); // saveDocument assigns an id if missing

        const fetched = await db.getDocument(doc.id);
        expect(fetched.name).toBe('Test POH.pdf');
        expect(fetched.type).toBe('imported');
        expect(fetched.importedAt).toBeTruthy();
    });

    it('getAllDocuments returns both bundled and imported types', async () => {
        await db.saveDocument({ name: 'a.pdf', type: 'bundled', sizeBytes: 1, blob: new Blob(['a']) });
        await db.saveDocument({ name: 'b.pdf', type: 'imported', sizeBytes: 1, blob: new Blob(['b']) });
        const all = await db.getAllDocuments();
        expect(all.length).toBe(2);
    });

    it('deleteDocument removes it', async () => {
        await db.saveDocument({ id: 'fixed-id', name: 'c.pdf', type: 'imported', sizeBytes: 1, blob: new Blob(['c']) });
        await db.deleteDocument('fixed-id');
        expect(await db.getDocument('fixed-id')).toBeNull();
    });
});
```

**Verify-before-trusting note:** `fake-indexeddb/auto`'s exact global-polyfill mechanism (whether it needs `new IDBFactory()` per test as written above, or auto-resets on its own) should be confirmed against the installed package's own README once added — this repo has no prior usage to copy from. Adjust `beforeEach` if the real behavior differs; the assertions themselves don't depend on this detail.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/nasr-db-documents.test.js`
Expected: FAIL — `saveDocument`/`getDocument`/`getAllDocuments`/`deleteDocument` don't exist yet, and the `flytab_documents` store doesn't exist (opening the DB at the current `DB_VERSION` won't create it).

- [ ] **Step 3: Write minimal implementation**

In `nasr-db.js`, change:
```js
static DB_VERSION = 8;
```
to:
```js
static DB_VERSION = 9;
```

Inside `onupgradeneeded` (anywhere among the other guarded store blocks, e.g. right after the `flight_plans` block ending `nasr-db.js:91`):
```js
// Document library — imported/bundled PDFs (POHs, checklists, chart legends)
if (!db.objectStoreNames.contains('flytab_documents')) {
    const store = db.createObjectStore('flytab_documents', { keyPath: 'id' });
    store.createIndex('type', 'type', { unique: false });
    store.createIndex('importedAt', 'importedAt', { unique: false });
}
```

Add the wrapper methods (place near `saveFlightPlan`/`getFlightPlan`, matching that pattern exactly):
```js
async saveDocument(doc) {
    if (!doc.id) doc.id = crypto.randomUUID ? crypto.randomUUID() : `doc-${Date.now()}`;
    doc.importedAt = doc.importedAt || new Date().toISOString();
    return this._put('flytab_documents', doc);
}
async getDocument(id) { return this._get('flytab_documents', id); }
async getAllDocuments() { return this._getAll('flytab_documents'); }
async deleteDocument(id) { return this._delete('flytab_documents', id); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/nasr-db-documents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/shared/nasr-db.js package.json package-lock.json tests/shared/nasr-db-documents.test.js
git commit -m "feat: add flytab_documents IndexedDB store (DB_VERSION 8->9)"
```

---

## Task 2: Extract shared PDF-page renderer from the plate viewer

**Files:**
- Create: `web/shared/pdf-render.js`
- Modify: `web/cockpit/approach-charts.js` (`_renderPdf`, lines 779-814)
- Modify: `web/index.html` (add new `<script>` tag)
- Test: `tests/shared/pdf-render-extraction.test.js` (new, source-inspection style — see note below)

**Interfaces:**
- Produces: `renderPdfToContainer(url, containerEl, {scale, cssClass} = {})` — a global function (classic script, not a class), returns the wrapper element it created. Renders every page of the PDF at `url` as stacked `<canvas>` elements inside a new child of `containerEl`.
- Consumes: `window.pdfjsLib` (already loaded, `web/index.html:65-66`, before this new script per the load-order note below).

**Context:** `approach-charts.js`'s `_renderPdf(url, body)` (lines 779-814) is genuinely self-contained — its only couplings are writing to `this._panContainer` (an instance field) and a hardcoded CSS class `approach-plate-pdf`; zoom/pan (`_setupPanZoom()`) and plate-to-plate navigation are entirely separate methods that never touch this one. Resolves the spec's open question #3 (plate-viewer refactor boundary) by extracting now rather than duplicating PDF.js rendering code in the new Documents panel.

**Load order:** must load after `pdf.js` (`web/index.html:65-66`) and before `approach-charts.js` (`web/index.html:119` per plan-time research) and before the new `documents.js` (Task 3). Place the new `<script src="./shared/pdf-render.js"></script>` tag in the "Shared modules" block of `index.html`, after the PDF.js `<script>` tags.

- [ ] **Step 1: Write the failing test**

This is plain-function extraction with no state/DOM-interaction complex enough to warrant a full jsdom behavioral test (PDF.js's actual page-rendering can't meaningfully run under jsdom — no real `<canvas>` 2D context). Source-inspection test, matching this repo's `tests/cockpit/route-table-plan-picker.test.js` pattern, confirming the extraction happened correctly and `approach-charts.js` now delegates rather than duplicates:

```js
// tests/shared/pdf-render-extraction.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const PDF_RENDER_SRC = readFileSync('web/shared/pdf-render.js', 'utf8');
const APPROACH_CHARTS_SRC = readFileSync('web/cockpit/approach-charts.js', 'utf8');
const INDEX_HTML = readFileSync('web/index.html', 'utf8');

describe('shared PDF renderer extraction', () => {
    it('defines the shared renderPdfToContainer function', () => {
        expect(PDF_RENDER_SRC).toMatch(/function renderPdfToContainer\s*\(/);
        expect(PDF_RENDER_SRC).toMatch(/pdfjs\.getDocument/);
        expect(PDF_RENDER_SRC).toMatch(/page\.render\(/);
    });

    it('approach-charts.js delegates to the shared renderer instead of duplicating PDF.js calls', () => {
        const methodStart = APPROACH_CHARTS_SRC.indexOf('_renderPdf(');
        const methodBody = APPROACH_CHARTS_SRC.slice(methodStart, methodStart + 600);
        expect(methodBody).toMatch(/renderPdfToContainer\s*\(/);
        // The duplicated per-page loop should be gone from this file now.
        expect(methodBody).not.toMatch(/pdf\.getPage\(/);
    });

    it('index.html loads pdf-render.js after pdf.js and before approach-charts.js', () => {
        const pdfJsIdx = INDEX_HTML.indexOf('lib/pdfjs/pdf.js');
        const rendererIdx = INDEX_HTML.indexOf('shared/pdf-render.js');
        const approachChartsIdx = INDEX_HTML.indexOf('cockpit/approach-charts.js');
        expect(rendererIdx).toBeGreaterThan(pdfJsIdx);
        expect(rendererIdx).toBeLessThan(approachChartsIdx);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/pdf-render-extraction.test.js`
Expected: FAIL — `web/shared/pdf-render.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/shared/pdf-render.js`:
```js
/**
 * FlyTab — Shared PDF page renderer.
 * Renders every page of a PDF as stacked <canvas> elements. Extracted from
 * approach-charts.js's plate viewer so the Documents panel (documents.js)
 * doesn't duplicate PDF.js rendering logic. Zoom/pan and page-to-page
 * navigation between different documents are NOT this function's concern —
 * callers layer those on top, exactly as approach-charts.js already does.
 */
async function renderPdfToContainer(url, containerEl, { scale, cssClass } = {}) {
    const pdfjs = window.pdfjsLib;
    const wrapper = document.createElement('div');
    if (cssClass) wrapper.className = cssClass;
    containerEl.appendChild(wrapper);
    if (!pdfjs) {
        wrapper.innerHTML = '<div class="pdf-render-error">PDF renderer unavailable</div>';
        return wrapper;
    }
    try {
        const pdf = await pdfjs.getDocument(url).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const effectiveScale = scale || (window.devicePixelRatio || 2);
            const viewport = page.getViewport({ scale: effectiveScale });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            wrapper.appendChild(canvas);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
    } catch (err) {
        wrapper.innerHTML = `<div class="pdf-render-error">Failed to load document: ${err.message}</div>`;
    }
    return wrapper;
}
```

In `web/index.html`, add right after the existing PDF.js `<script>` tags (`index.html:65-66`):
```html
<script src="./shared/pdf-render.js"></script>
```

Read `approach-charts.js`'s `_renderPdf` (lines 779-814) in full before editing, then replace its body (keep the method signature and the `prev`-removal line, which is plate-viewer-specific state cleanup that stays in this file):
```js
async _renderPdf(url, body) {
    const prev = this._panContainer.querySelector('.approach-plate-pdf');
    if (prev) prev.remove();
    await renderPdfToContainer(url, this._panContainer, { cssClass: 'approach-plate-pdf' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/pdf-render-extraction.test.js`
Expected: PASS

- [ ] **Step 5: Required manual verification — plate viewer regression check**

This refactors working, plate-viewer-critical code. Open the plate viewer on-device or in a browser dev build, load any approach plate, confirm it renders identically to before this change (same zoom/pan behavior, same page stacking for multi-page plates, same error message if a plate fails to load). This is not optional — the automated test above only confirms the delegation happened structurally, not that rendering still looks right.

- [ ] **Step 6: Commit**

```bash
git add web/shared/pdf-render.js web/cockpit/approach-charts.js web/index.html tests/shared/pdf-render-extraction.test.js
git commit -m "refactor: extract shared PDF-page renderer from the plate viewer"
```

---

## Task 3: Documents panel shell + MORE drawer wiring

**Files:**
- Create: `web/cockpit/documents.js`
- Modify: `web/cockpit/tab-bar.js` (MORE drawer rows, close-everything list, `FS_OVERLAY_SELECTORS`)
- Modify: `web/app.js` (construct `DocumentsPanel`, pass into `TabBar`)
- Modify: `web/index.html` (add `<script>` tag)
- Modify: `web/style.css` (new `.documents-page` styles)
- Test: `tests/cockpit/documents-panel.test.js` (new)

**Interfaces:**
- Produces: `DocumentsPanel` class — `constructor(nasrDb)`, `show()`, `hide()`. Consumes `NasrDB.getAllDocuments()` (Task 1).
- Produces (for Task 2 reuse): the panel's document-viewer area calls `renderPdfToContainer(url, containerEl, {cssClass})` (Task 2) to display a selected document.

**Context:** Modeled on two existing precedents (confirmed during planning): the full-screen `-page` panel family (Logbook: `_buildDOM()` in constructor, DOM appended to `document.body` once, `show()`/`hide()` toggle a `.visible` class, CSS `position:fixed; z-index:800`) and `ConfigEditor`'s header+search-box+body structure (`.ce-search-wrap`/`.ce-search-input` pattern). This task builds the shell only — list view of whatever's already in the store, and tapping a row opens it via the shared renderer. Import and search come in Task 4, so this task's list is read-only against whatever `getAllDocuments()` returns (nothing yet, until Task 4/6 add data) — still independently testable and committable per this plan's task-sizing rule.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/documents-panel.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

describe('DocumentsPanel shell', () => {
    let nasrDb, panel;

    beforeEach(() => {
        document.body.innerHTML = '';
        nasrDb = { getAllDocuments: vi.fn().mockResolvedValue([
            { id: 'd1', name: 'Sample POH.pdf', type: 'imported', sizeBytes: 1024, importedAt: '2026-09-17T00:00:00Z' },
        ]) };
        panel = new DocumentsPanel(nasrDb);
    });

    it('builds its DOM once at construction and appends to document.body', () => {
        expect(document.body.contains(panel._el)).toBe(true);
        expect(panel._el.className).toBe('documents-page');
    });

    it('show() adds the visible class and lists documents from the store', async () => {
        panel.show();
        expect(panel._el.classList.contains('visible')).toBe(true);
        await Promise.resolve(); // let the async _renderList settle
        await Promise.resolve();
        expect(nasrDb.getAllDocuments).toHaveBeenCalled();
        expect(panel._listEl.textContent).toMatch(/Sample POH\.pdf/);
    });

    it('hide() removes the visible class', () => {
        panel.show();
        panel.hide();
        expect(panel._el.classList.contains('visible')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/documents-panel.test.js`
Expected: FAIL — `web/cockpit/documents.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/cockpit/documents.js`:
```js
/**
 * FlyTab — Document Library panel. Full-screen MORE-drawer page listing
 * imported + bundled reference documents (POHs, checklists, chart legends).
 * Import and search are added in a later task; this is the list/view shell.
 */
class DocumentsPanel {
    constructor(nasrDb) {
        this._nasrDb = nasrDb;
        this._el = null;
        this._listEl = null;
        this._viewerEl = null;
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'documents-page';
        this._el.innerHTML = `
            <div class="documents-header">
                <span class="documents-title">Documents</span>
                <button class="documents-close" aria-label="Close">&times;</button>
            </div>
            <div class="documents-list"></div>
            <div class="documents-viewer"></div>
        `;
        this._listEl = this._el.querySelector('.documents-list');
        this._viewerEl = this._el.querySelector('.documents-viewer');
        wireTap(this._el.querySelector('.documents-close'), () => this.hide());
        document.body.appendChild(this._el);
    }

    show() {
        this._el.classList.add('visible');
        this._renderList();
    }

    hide() {
        this._el.classList.remove('visible');
    }

    async _renderList() {
        const docs = await this._nasrDb.getAllDocuments();
        this._listEl.innerHTML = '';
        if (docs.length === 0) {
            this._listEl.innerHTML = '<div class="documents-empty">No documents yet.</div>';
            return;
        }
        for (const doc of docs) {
            const row = document.createElement('div');
            row.className = 'documents-row';
            row.innerHTML = `<span class="documents-row-name">${doc.name}</span>`;
            wireTap(row, () => this._openDocument(doc));
            this._listEl.appendChild(row);
        }
    }

    async _openDocument(doc) {
        this._viewerEl.innerHTML = '';
        this._viewerEl.style.display = '';
        const url = URL.createObjectURL(doc.blob);
        await renderPdfToContainer(url, this._viewerEl, { cssClass: 'documents-pdf' });
        URL.revokeObjectURL(url);
    }
}
```

In `web/index.html`, add near `logbook.js`/`checklist.js` in the "Cockpit modules" block, before `tab-bar.js` and `app.js`:
```html
<script src="./cockpit/documents.js"></script>
```

In `web/cockpit/tab-bar.js`:
1. Add a row to the `rows` array inside `_buildMoreDrawer()` (near the Logbook row):
```js
{ icon: '📄', label: 'Documents', action: () => {
    if (c.documents?.show) c.documents.show();
    this._closeMoreDrawer();
}},
```
2. Add to the "close everything" prologue in `_selectTab()` (alongside the existing `c.logbook?.hide()` call): `c.documents?.hide();`
3. Add `.documents-page` to `FS_OVERLAY_SELECTORS`.

In `web/app.js`, near the existing `Logbook` construction (`this.logbook = new Logbook(nasrDb);`):
```js
if (typeof DocumentsPanel !== 'undefined') {
    this.documents = new DocumentsPanel(nasrDb);
}
```
And add `documents: this.documents,` to the object passed into `new TabBar({...})`.

In `web/style.css`, add (matching the `logbook-page` full-screen family and this repo's Design Token Standards):
```css
.documents-page {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: var(--tab-bar-height);
    z-index: 800;
    flex-direction: column;
    background: var(--bg-primary);
}
.documents-page.visible { display: flex; }
.documents-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px; border-bottom: 1px solid var(--border);
}
.documents-title { font-family: var(--font-ui); font-weight: 800; font-size: 20px; color: var(--text-primary); }
.documents-close { min-width: var(--touch-min, 56px); min-height: var(--touch-min, 56px); font-size: 28px; font-weight: 800; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); }
.documents-list { overflow-y: auto; flex: 0 0 auto; max-height: 40vh; }
.documents-row { min-height: var(--touch-min, 56px); display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--border-light); }
.documents-row-name { font-family: var(--font-ui); font-weight: 700; color: var(--text-secondary); }
.documents-empty { padding: 16px; font-family: var(--font-ui); font-weight: 700; color: var(--text-muted); }
.documents-viewer { flex: 1; overflow-y: auto; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/documents-panel.test.js`
Expected: PASS

- [ ] **Step 5: Required manual verification**

On-device or browser dev build: open MORE drawer, confirm "Documents" row appears and opens an (empty, at this stage) panel; confirm the close button works; confirm switching to another tab while the panel is open correctly hides it (the close-everything wiring).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/documents.js web/cockpit/tab-bar.js web/app.js web/index.html web/style.css tests/cockpit/documents-panel.test.js
git commit -m "feat: Documents panel shell + MORE drawer wiring"
```

---

## Task 4: File-picker import + text extraction + lunr search

**Files:**
- Modify: `web/cockpit/documents.js` (add import button, search box, extraction/indexing pipeline)
- Modify: `web/index.html` (add `lunr.min.js` script tag)
- Test: `tests/cockpit/documents-import-search.test.js` (new)

**Interfaces:**
- Produces: `DocumentsPanel._importFile(file)` — the shared entry point Task 5 (share-intent) and Task 6 (bundled seeding) both call, given any `File`/`Blob`-like PDF input plus a display name. Persists via `NasrDB.saveDocument` (Task 1), extracts text via PDF.js `getTextContent()`, builds/updates a `lunr.Index`, persists the index via `NasrDB.putAppCache('documents_search_index', {lunrIndexJSON, pages})` / reads via `getAppCache('documents_search_index')` (both already exist, `nasr-db.js:658-665`).
- `pages` shape: `[{id: "<docId>:<pageNum>", docId, pageNum, docName, text}, ...]` — doubles as the lunr document set (indexed on `text`+`docName`) and the lookup table to resolve a search hit's `ref` back to a real page.

**Context:** Reuses `NasrDB`'s generic `app_cache` store (via the already-existing `getAppCache`/`putAppCache` wrappers) for the search index rather than adding a second new IndexedDB store — one combined lunr index spans all documents (so the top search box searches everything at once), not a per-document index. Text extraction is chunked page-by-page (`await` between pages, not one synchronous pass) per the spec's explicit caution about the NASR-import IDB-hang failure mode from exactly this class of mistake.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/documents-import-search.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
global.lunr = new Function(read('web/lib/lunr.min.js') + '\nreturn lunr;')();
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

function mockPdfjs(pageTexts) {
    global.window.pdfjsLib = {
        getDocument: () => ({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage: (n) => Promise.resolve({
                    getTextContent: () => Promise.resolve({
                        items: pageTexts[n - 1].split(' ').map(str => ({ str })),
                    }),
                }),
            }),
        }),
    };
}

describe('DocumentsPanel import + search', () => {
    let nasrDb, panel, savedDocs, savedCache;

    beforeEach(() => {
        document.body.innerHTML = '';
        savedDocs = [];
        savedCache = null;
        nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue(savedDocs),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = doc.id || 'new-doc-id'; savedDocs.push(doc); return doc.id; }),
            getAppCache: vi.fn().mockImplementation(async () => savedCache),
            putAppCache: vi.fn().mockImplementation(async (key, data) => { savedCache = data; }),
        };
        panel = new DocumentsPanel(nasrDb);
        mockPdfjs(['Cessna 172 checklist before landing', 'Emergency engine failure procedure']);
    });

    it('extracts text page-by-page and builds a searchable lunr index', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf');

        expect(nasrDb.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ name: 'checklist.pdf', type: 'imported' }));
        expect(nasrDb.putAppCache).toHaveBeenCalledWith('documents_search_index', expect.objectContaining({
            lunrIndexJSON: expect.anything(),
            pages: expect.arrayContaining([
                expect.objectContaining({ docId: 'new-doc-id', pageNum: 1, text: expect.stringContaining('checklist') }),
                expect.objectContaining({ docId: 'new-doc-id', pageNum: 2, text: expect.stringContaining('Emergency') }),
            ]),
        }));
    });

    it('a search finds the right page and the index survives a lunr.Index.load round-trip', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf');

        const idx = lunr.Index.load(savedCache.lunrIndexJSON);
        const results = idx.search('emergency');
        expect(results.length).toBeGreaterThan(0);
        const hitPage = savedCache.pages.find(p => p.id === results[0].ref);
        expect(hitPage.pageNum).toBe(2);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/documents-import-search.test.js`
Expected: FAIL — `_importFile` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`, add before `documents.js`'s own script tag (anywhere in the libraries block, alongside `pdf.js`/`chart.min.js`):
```html
<script src="./lib/lunr.min.js"></script>
```

In `web/cockpit/documents.js`, add to `_buildDOM()`'s template (inside `.documents-header`, after the title, before the close button) an import button + hidden file input, and a search box (new div before `.documents-list`):
```html
<input type="search" class="documents-search-input" placeholder="Search documents…" autocomplete="off">
<button class="documents-import-btn">Import</button>
<input type="file" class="documents-file-input" accept="application/pdf" style="display:none">
```
Wire them in `_buildDOM()`, after the existing `wireTap` call for the close button:
```js
this._searchInput = this._el.querySelector('.documents-search-input');
this._searchInput.addEventListener('input', () => this._applySearch(this._searchInput.value));
const fileInput = this._el.querySelector('.documents-file-input');
wireTap(this._el.querySelector('.documents-import-btn'), () => fileInput.click());
fileInput.addEventListener('change', async () => {
    if (fileInput.files[0]) await this._importFile(fileInput.files[0], fileInput.files[0].name);
    fileInput.value = '';
});
```

Add the import/extraction/indexing methods:
```js
async _importFile(blob, name) {
    const doc = { name, type: 'imported', sizeBytes: blob.size, blob };
    await this._nasrDb.saveDocument(doc);
    await this._indexDocument(doc);
    await this._renderList();
}

async _indexDocument(doc) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) return;
    const url = URL.createObjectURL(doc.blob);
    const cache = (await this._nasrDb.getAppCache('documents_search_index')) || { lunrIndexJSON: null, pages: [] };
    // Drop any stale pages for this doc id (re-import/re-index case) before adding fresh ones.
    cache.pages = cache.pages.filter(p => p.docId !== doc.id);
    try {
        const pdf = await pdfjs.getDocument(url).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
            // Awaited per-page, not one synchronous pass over every page --
            // avoids a long blocking JS execution on a large PDF (see this
            // repo's documented NASR-import IDB-hang failure mode).
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const text = content.items.map(item => item.str).join(' ');
            cache.pages.push({ id: `${doc.id}:${p}`, docId: doc.id, pageNum: p, docName: doc.name, text });
        }
    } finally {
        URL.revokeObjectURL(url);
    }
    const idx = lunr(function () {
        this.ref('id');
        this.field('text');
        this.field('docName');
        for (const page of cache.pages) this.add(page);
    });
    cache.lunrIndexJSON = idx.toJSON();
    await this._nasrDb.putAppCache('documents_search_index', cache);
}

async _applySearch(query) {
    if (!query) { this._renderList(); return; }
    const cache = await this._nasrDb.getAppCache('documents_search_index');
    if (!cache?.lunrIndexJSON) { this._listEl.innerHTML = '<div class="documents-empty">No results.</div>'; return; }
    const idx = lunr.Index.load(cache.lunrIndexJSON);
    const results = idx.search(query);
    this._listEl.innerHTML = '';
    if (results.length === 0) { this._listEl.innerHTML = '<div class="documents-empty">No results.</div>'; return; }
    for (const result of results) {
        const page = cache.pages.find(p => p.id === result.ref);
        if (!page) continue;
        const row = document.createElement('div');
        row.className = 'documents-row';
        row.innerHTML = `<span class="documents-row-name">${page.docName} — p.${page.pageNum}</span>`;
        wireTap(row, async () => {
            const doc = await this._nasrDb.getDocument(page.docId);
            if (doc) await this._openDocument(doc);
        });
        this._listEl.appendChild(row);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/documents-import-search.test.js`
Expected: PASS

- [ ] **Step 5: Required manual verification**

On-device: tap Import, pick a real multi-page PDF from device storage, confirm it appears in the list; type a word known to be on a specific page into the search box, confirm the matching page shows in results and tapping it opens the document. Confirm a large (20+ page) PDF doesn't visibly freeze the UI during import (the page-by-page `await` chunking).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/documents.js web/index.html tests/cockpit/documents-import-search.test.js
git commit -m "feat: file-picker import with per-page text extraction and lunr search"
```

---

## Task 5: Android share-intent receiving

**Files:**
- Create: `android/app/src/main/java/app/flywhere/flytab/ShareReceiverPlugin.java`
- Modify: `android/app/src/main/AndroidManifest.xml` (new `SEND` intent-filter)
- Modify: `android/app/src/main/java/app/flywhere/flytab/MainActivity.java` (register plugin, override `onNewIntent`, check `onCreate`'s initial intent)
- Modify: `web/cockpit/documents.js` (poll the plugin for a pending share on app init/resume)
- Test: none automated (Java, no test harness in this repo for native code) — `bash build.sh` compile-check + required manual on-device verification

**Interfaces:**
- Produces (native → JS): `ShareReceiverPlugin.getPendingShare()` — Capacitor plugin method, no args, resolves `{ok: true, name: string, base64: string}` if a share is pending (and clears it), or `{ok: false}` if none.
- Consumes (JS side): `web/app.js` or `documents.js` calls `window.Capacitor.Plugins.ShareReceiver.getPendingShare()` on app init and on `App.addListener('resume', ...)` (the app can receive a share while already running, in the background).

**Context, established during planning — read before implementing:** `AndroidManifest.xml`'s `<activity>` has `launchMode="singleTask"` and exactly one existing `<intent-filter>` (the `flytab://plan` VIEW/BROWSABLE one). No `SEND` filter exists. Because of `singleTask`, a new intent arriving while FlyTab is already running does NOT go through `onCreate()` — it goes to `onNewIntent()`, which `MainActivity.java` does not currently override at all. This is real native code to add, not a JS-side extension of the existing `appUrlOpen` deep-link listener (that listener is Capacitor's own machinery for `VIEW`-intent URLs and does not fire for `SEND` intents carrying file data).

- [ ] **Step 1: AndroidManifest.xml — add the SEND intent-filter**

Read the `<activity>` block in full (`AndroidManifest.xml:26-46`) before editing. Add a new `<intent-filter>` inside it, after the existing `flytab://plan` one:
```xml
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="application/pdf" />
</intent-filter>
```

- [ ] **Step 2: Create the plugin**

Modeled directly on `ThermalMonitorPlugin.java`'s structure (`@CapacitorPlugin`/`Plugin`/`@PluginMethod`/`PluginCall.resolve(JSObject)`):
```java
package app.flywhere.flytab;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Capacitor plugin receiving a PDF shared into FlyTab via Android's SEND
 * intent (e.g. "Share to FlyTab" from a file manager or another app).
 * MainActivity stashes the incoming Uri here (onNewIntent for a running
 * instance, onCreate's initial intent for a cold start); the JS side polls
 * getPendingShare() on app init/resume rather than this plugin pushing an
 * event, since a share can arrive before the WebView has any listener
 * registered to receive one.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static final String TAG = "ShareReceiver";
    private static Uri pendingUri = null;

    /** Called by MainActivity, not by JS. */
    public static void setPendingShare(Uri uri) {
        pendingUri = uri;
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        if (pendingUri == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        Uri uri = pendingUri;
        pendingUri = null; // clear so a later poll doesn't re-import the same file
        try {
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) throw new Exception("Could not open shared file stream");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
            in.close();
            String name = queryDisplayName(uri);
            ret.put("ok", true);
            ret.put("name", name);
            ret.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to read shared file", e);
            ret.put("ok", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    private String queryDisplayName(Uri uri) {
        String name = "shared-document.pdf";
        try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = cursor.getString(idx);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not resolve shared file display name, using default", e);
        }
        return name;
    }
}
```

**Verify-before-trusting note:** `PluginCall.resolve(JSObject)` never rejecting (matching `SftpPlugin`'s documented `{ok:false, error}` convention per the spec's own APK-update design doc) is followed here deliberately — confirm this matches how other plugins in this exact codebase signal failure before assuming it's universal Capacitor convention rather than this repo's specific one.

- [ ] **Step 3: MainActivity.java — capture the intent**

Read `MainActivity.java` in full before editing (74 lines, single `onCreate` + a few helpers, no existing `onNewIntent`). Add the import:
```java
import android.content.Intent;
```
(likely already present — check before adding a duplicate; `MainActivity.java` already imports `android.content.Intent` for `FlightService`, confirm and reuse.)

Register the plugin alongside the existing ones in `onCreate()` (before `super.onCreate(...)`, matching the existing block):
```java
registerPlugin(ShareReceiverPlugin.class);
```

Add a private helper and call it from both `onCreate()` (after `super.onCreate(savedInstanceState)`) and a new `onNewIntent` override:
```java
private void handleIncomingIntent(Intent intent) {
    if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri != null) {
            Log.i(TAG, "Received shared file: " + uri);
            ShareReceiverPlugin.setPendingShare(uri);
        }
    }
}

@Override
public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleIncomingIntent(intent);
}
```
And in `onCreate()`, after `super.onCreate(savedInstanceState);` (handles the cold-start case — app not running, launched fresh via a share):
```java
handleIncomingIntent(getIntent());
```

- [ ] **Step 4: JS side — poll for a pending share**

In `web/cockpit/documents.js`, add a method and call it from app startup:
```js
async _checkPendingShare() {
    const ShareReceiver = window.Capacitor?.Plugins?.ShareReceiver;
    if (!ShareReceiver) return;
    const result = await ShareReceiver.getPendingShare();
    if (!result?.ok) return;
    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    await this._importFile(blob, result.name || 'shared-document.pdf');
    this.show();
}
```
Call `this._checkPendingShare();` at the end of `_buildDOM()` (covers cold start — the panel is constructed once at app startup) and register for the Capacitor `resume` event (covers a share arriving while the app is backgrounded, matching the existing `appUrlOpen` global-bridge-access convention in `app.js`'s `_initDeepLink`):
```js
window.Capacitor?.Plugins?.App?.addListener('resume', () => this._checkPendingShare());
```

- [ ] **Step 5: Compile-check**

Run: `bash build.sh`
Expected: `BUILD SUCCESSFUL` — confirms the new Java compiles and the manifest is well-formed. This does not confirm the intent-handling logic actually works; only that it builds.

- [ ] **Step 6: Required manual on-device verification**

Not optional — this task cannot be verified any other way. Install the built APK. From a file manager or another app, share a PDF to FlyTab ("Share" → FlyTab) with FlyTab already running in the background, and separately with FlyTab not running at all (cold start via share). Confirm both cases: the Documents panel opens automatically and the shared PDF appears in the list, searchable.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/app/flywhere/flytab/ShareReceiverPlugin.java android/app/src/main/AndroidManifest.xml android/app/src/main/java/app/flywhere/flytab/MainActivity.java web/cockpit/documents.js
git commit -m "feat: receive PDFs shared into FlyTab via Android's SEND intent"
```

---

## Task 6: Seed bundled VFR/IFR legend PDFs on first launch

**Files:**
- Modify: `web/cockpit/documents.js` (seed check + Android-asset read path)
- Test: `tests/cockpit/documents-seed-bundled.test.js` (new)

**Interfaces:**
- Produces: `DocumentsPanel._seedBundledDocuments()`, called once at app startup (after `_checkPendingShare`, same startup hook). Reads `android/app/src/main/assets/vfr-chart-legend.pdf` / `ifr-chart-legend.pdf` (already committed to this branch) via a `fetch()` against the WebView's own asset-serving (Capacitor's WebView serves `android_asset` content at a reachable local path — see verify-before-trusting note below) and imports them through the same `_importFile` pipeline as Task 4, tagged `type: 'bundled'`.

**Context:** `_importFile` (Task 4) currently always sets `type: 'imported'`. This task needs `type: 'bundled'` for these two specific documents (matters for a future revert/re-seed decision, and so the UI could eventually distinguish them, even though this task doesn't build that UI distinction itself — out of scope here, just don't lose the information).

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/documents-seed-bundled.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
global.lunr = new Function(read('web/lib/lunr.min.js') + '\nreturn lunr;')();
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

describe('DocumentsPanel bundled-legend seeding', () => {
    let nasrDb, panel, savedDocs;

    beforeEach(() => {
        document.body.innerHTML = '';
        savedDocs = [];
        nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue(savedDocs),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = doc.id || `id-${savedDocs.length}`; savedDocs.push(doc); return doc.id; }),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: 'legend' }] }) }) }) }) };
        global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['%PDF-1.4'], { type: 'application/pdf' })) });
        panel = new DocumentsPanel(nasrDb);
    });

    it('seeds both bundled legends on first run when the store is empty', async () => {
        await panel._seedBundledDocuments();
        expect(savedDocs.length).toBe(2);
        expect(savedDocs.every(d => d.type === 'bundled')).toBe(true);
        expect(savedDocs.map(d => d.name)).toEqual(expect.arrayContaining([expect.stringContaining('VFR'), expect.stringContaining('IFR')]));
    });

    it('does not re-seed if a bundled legend is already present', async () => {
        savedDocs.push({ id: 'existing', name: 'VFR Chart Legend.pdf', type: 'bundled' });
        await panel._seedBundledDocuments();
        // Only the missing IFR one should get added, not a duplicate VFR.
        expect(savedDocs.filter(d => d.name.includes('VFR')).length).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/documents-seed-bundled.test.js`
Expected: FAIL — `_seedBundledDocuments` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Refactor `_importFile` (Task 4) to accept a type, defaulting to `'imported'` so existing call sites don't need to change:
```js
async _importFile(blob, name, type = 'imported') {
    const doc = { name, type, sizeBytes: blob.size, blob };
    await this._nasrDb.saveDocument(doc);
    await this._indexDocument(doc);
    await this._renderList();
}
```

Add the seeding method:
```js
async _seedBundledDocuments() {
    const BUNDLED = [
        { path: 'vfr-chart-legend.pdf', name: 'VFR Chart Legend.pdf' },
        { path: 'ifr-chart-legend.pdf', name: 'IFR Chart Legend.pdf' },
    ];
    const existing = await this._nasrDb.getAllDocuments();
    for (const item of BUNDLED) {
        if (existing.some(d => d.type === 'bundled' && d.name === item.name)) continue;
        try {
            const resp = await fetch(`file:///android_asset/${item.path}`);
            if (!resp.ok) continue;
            const blob = await resp.blob();
            await this._importFile(blob, item.name, 'bundled');
        } catch (err) {
            console.warn('[Documents] Failed to seed bundled legend', item.name, err.message);
        }
    }
}
```
Call `this._seedBundledDocuments();` in `_buildDOM()`, alongside `_checkPendingShare()`.

**Verify-before-trusting note, flagged rather than assumed:** the exact reachable URL for Android asset files from inside a Capacitor WebView (`file:///android_asset/...` vs. Capacitor's own `Capacitor.convertFileSrc()` helper, which this repo may need for its configured WebView origin — `capacitor.config.ts` sets `androidScheme: 'http'`, and a raw `file://` fetch may be blocked by the WebView's origin policy under that scheme) was not verified against a running instance during planning. Confirm which form actually resolves before trusting the snippet above verbatim — test with `console.log` of the fetch result on-device before relying on it silently failing open (the `try/catch` above means a wrong URL scheme degrades to "legends never appear" with only a console warning, not a crash — acceptable degradation, but confirm it's not silently wrong from day one).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/documents-seed-bundled.test.js`
Expected: PASS

- [ ] **Step 5: Required manual on-device verification**

Fresh install (or clear app data) on-device, open the Documents panel for the first time, confirm both "VFR Chart Legend.pdf" and "IFR Chart Legend.pdf" appear without any import action, and confirm each opens and renders real content (not a blank/error page — this is the step that actually resolves the verify-before-trusting note above). Reopen the app a second time, confirm they don't duplicate.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/documents.js tests/cockpit/documents-seed-bundled.test.js
git commit -m "feat: seed bundled VFR/IFR chart legends into the document library on first launch"
```

---

## Task 7: Storage-quota handling

**Files:**
- Modify: `web/cockpit/documents.js` (`_importFile`)
- Test: `tests/cockpit/documents-quota.test.js` (new)

**Interfaces:**
- Produces: nothing new externally — `_importFile` gains a caught-error path with pilot-facing feedback instead of an unhandled rejection.

**Context:** No IndexedDB quota-handling exists anywhere in this repo today (confirmed during planning — the only "storage full" comments in the whole codebase are bare `localStorage` try/catches that swallow silently, no pilot-facing UI). This task is the first real one. `NasrDB._put` (which `saveDocument` wraps) rejects via the IndexedDB request's `onerror`, which for a quota failure carries `err.name === 'QuotaExceededError'` — `_importFile` needs to catch that specifically and surface it, not let it become an unhandled promise rejection with the import silently not happening.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/documents-quota.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

describe('DocumentsPanel storage-quota handling', () => {
    it('shows a pilot-facing message instead of throwing when storage is full', async () => {
        document.body.innerHTML = '';
        const quotaError = new Error('Quota exceeded');
        quotaError.name = 'QuotaExceededError';
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            saveDocument: vi.fn().mockRejectedValue(quotaError),
        };
        const panel = new DocumentsPanel(nasrDb);
        const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });

        await expect(panel._importFile(blob, 'big.pdf')).resolves.not.toThrow();
        expect(panel._el.textContent).toMatch(/storage full/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/documents-quota.test.js`
Expected: FAIL — `saveDocument` rejecting currently propagates as an unhandled rejection from `_importFile`, not a caught, displayed message.

- [ ] **Step 3: Write minimal implementation**

Wrap `_importFile`'s body (all tasks so far have been building this method up — read its current full body before editing):
```js
async _importFile(blob, name, type = 'imported') {
    const doc = { name, type, sizeBytes: blob.size, blob };
    try {
        await this._nasrDb.saveDocument(doc);
    } catch (err) {
        if (err?.name === 'QuotaExceededError') {
            this._showMessage('Storage full — delete a document to import more.');
            return;
        }
        throw err;
    }
    await this._indexDocument(doc);
    await this._renderList();
}

_showMessage(text) {
    const el = document.createElement('div');
    el.className = 'documents-message';
    el.textContent = text;
    this._listEl.prepend(el);
    setTimeout(() => el.remove(), 4000);
}
```

Add a matching style in `web/style.css` (Design Token Standards — danger-on-light for readable warning text, not the raw fill token, per this repo's own documented rule against using the bright fill colors as text):
```css
.documents-message {
    padding: 12px 16px;
    font-family: var(--font-ui);
    font-weight: 700;
    color: var(--color-danger-on-light);
    background: var(--bg-surface);
    border: 1px solid var(--color-danger-on-light);
    border-radius: 8px;
    margin: 8px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/documents-quota.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/documents.js web/style.css tests/cockpit/documents-quota.test.js
git commit -m "fix: show a pilot-facing message on IndexedDB quota exceeded during import"
```

---

## User manual update

Per this repo's CLAUDE.md, this whole feature is user-visible (new MORE drawer item, new panel, new workflow) and needs a `docs/user-manual.md` update in the same commit as the feature — do this as part of Task 3 (when the MORE drawer entry first appears) and expand it in Task 4 (import) and Task 6 (bundled legends), rather than batching it to the end.

## Self-Review

**Spec coverage:** All 4 spec goals covered — import via both paths (Tasks 4, 5), accessible library (Task 3), full-text search (Task 4), bundled legends (Task 6). All 3 spec open questions resolved during planning: search library/index format (lunr.js, `app_cache`-stored JSON + page lookup — Task 4), storage quota (Task 7), plate-viewer refactor boundary (extracted — Task 2).

**Placeholder scan:** No TBD/TODO markers. Three spots explicitly flagged as unverified-until-manual-check rather than asserted as fact: the `fake-indexeddb/auto` reset mechanism (Task 1), `PluginCall.resolve` never-rejects convention (Task 5), and the Android-asset fetch URL scheme (Task 6) — each has a concrete verification instruction attached, not left vague.

**Type consistency:** `_importFile(blob, name, type = 'imported')`'s signature is introduced in Task 4 and extended (not changed) in Task 6 — existing Task 4/5 call sites keep working unchanged since `type` defaults. `pages` array shape (`{id, docId, pageNum, docName, text}`) is defined once in Task 4 and consumed identically in `_applySearch` — no drift.

**Cross-task dependencies:** Strictly linear — each task's Interfaces section consumes the prior task's Produces. Tasks 5 and 6 both call Task 4's `_importFile`, so both must land after Task 4; Tasks 5 and 6 don't touch each other's files and could run in parallel with each other once Task 4 is done. Task 7 wraps Task 4's `saveDocument` call, so it must come after Task 4 (or after Task 6, since Task 6 also calls the same method — ordering 4→5→6→7 as written avoids any ambiguity about which version of `_importFile` Task 7 is wrapping).

**Known limitation carried forward from the spec, not resolved here:** OCR for scanned/image-only PDFs remains explicitly out of scope (Non-goals) — a scanned POH with no text layer imports and displays fine but won't be found by search, silently (not a bug, matches the spec's stated scope, but worth remembering if a pilot reports "I imported X but can't find it by search").
