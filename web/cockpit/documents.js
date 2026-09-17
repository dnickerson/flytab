/**
 * FlyTab — Document Library panel. Full-screen MORE-drawer page listing
 * imported + bundled reference documents (POHs, checklists, chart legends).
 * File-picker import extracts text per-page via PDF.js and feeds a single
 * combined lunr.js index (spanning every imported document) that backs the
 * top search box -- see _importFile/_indexDocument/_saveIndex/_applySearch.
 */
class DocumentsPanel {
    constructor(nasrDb) {
        this._nasrDb = nasrDb;
        this._el = null;
        this._listEl = null;
        this._viewerEl = null;
        this._searchInput = null;
        // Promise-chain queue serializing every read-modify-write of the
        // shared 'documents_search_index' app_cache entry -- see _queueIndexOp.
        this._indexQueue = Promise.resolve();
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'documents-page';
        this._el.innerHTML = `
            <div class="documents-header">
                <div class="documents-header-left">
                    <span class="documents-title">Documents</span>
                    <button class="documents-import-btn">Import</button>
                    <input type="file" class="documents-file-input" accept="application/pdf" style="display:none">
                </div>
                <button class="documents-close" aria-label="Close">&times;</button>
            </div>
            <div class="documents-search-bar">
                <input type="search" class="documents-search-input" placeholder="Search documents…" autocomplete="off">
            </div>
            <div class="documents-list"></div>
            <div class="documents-viewer"></div>
        `;
        this._listEl = this._el.querySelector('.documents-list');
        this._viewerEl = this._el.querySelector('.documents-viewer');
        wireTap(this._el.querySelector('.documents-close'), () => this.hide());
        this._searchInput = this._el.querySelector('.documents-search-input');
        this._searchInput.addEventListener('input', () => this._applySearch(this._searchInput.value));
        const fileInput = this._el.querySelector('.documents-file-input');
        wireTap(this._el.querySelector('.documents-import-btn'), () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            try {
                if (fileInput.files[0]) await this._importFile(fileInput.files[0], fileInput.files[0].name);
            } catch (err) {
                // A malformed/corrupt PDF (or any other import failure) propagates
                // unhandled from _importFile/_indexDocument otherwise. Caught here
                // so it doesn't become an unhandled rejection; the input reset in
                // `finally` below is what actually matters -- without it the pilot
                // couldn't re-select the same failed file to retry (the browser
                // won't re-fire 'change' for an unchanged value).
                console.error('DocumentsPanel: import failed', err);
            } finally {
                fileInput.value = '';
            }
        });
        document.body.appendChild(this._el);
        this._checkPendingShare();
        window.Capacitor?.Plugins?.App?.addListener('resume', () => this._checkPendingShare());
    }

    // Polls the native ShareReceiver plugin for a PDF shared into FlyTab from
    // another app (file manager, email, etc.) via Android's SEND intent. Called
    // once at startup (covers cold start -- the panel is built once at app
    // startup) and on every Capacitor 'resume' event (covers a share arriving
    // while the app was already running, in the background).
    async _checkPendingShare() {
        const ShareReceiver = window.Capacitor?.Plugins?.ShareReceiver;
        if (!ShareReceiver) return;
        const result = await ShareReceiver.getPendingShare();
        if (result?.tooLarge) {
            // Awaited directly rather than via show() -- show() fires
            // _renderList() without awaiting it, and _renderList()'s own
            // `innerHTML = ''` reset (once its async doc-list read resolves)
            // would otherwise unconditionally wipe out the message appended
            // below, every time, since that reset always lands on a later
            // task than this synchronous continuation.
            this._el.classList.add('visible');
            await this._renderList();
            this._showMessage(`"${result.name}" is too large to share directly — use Import in the Documents panel instead.`);
            return;
        }
        if (result?.error) {
            // Native-side read failure (I/O error, revoked provider
            // permission, provider crash) -- distinct from the ordinary
            // "nothing pending" case below, which also has ok:false but no
            // error field. ShareReceiverPlugin already clears its pending
            // Uri before attempting the read, so there's no retry path on
            // the native side; without this the pilot gets zero feedback
            // that their share silently failed. Same await-then-message
            // ordering as the tooLarge branch above, for the same reason.
            this._el.classList.add('visible');
            await this._renderList();
            this._showMessage('Could not read the shared file. Please try sharing it again.');
            return;
        }
        if (!result?.ok) return;
        const binary = atob(result.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        try {
            await this._importFile(blob, result.name || 'shared-document.pdf');
        } catch (err) {
            // Matches the file-picker change handler's error handling above --
            // a malformed/corrupt PDF otherwise propagates unhandled from
            // _importFile/_indexDocument. Unlike that path the pilot has no
            // "try again" affordance here (the native side already consumed
            // the share), so surface it instead of failing silently.
            console.error('DocumentsPanel: shared file import failed', err);
            this._el.classList.add('visible');
            await this._renderList();
            this._showMessage(`Could not import "${result.name || 'shared-document.pdf'}" — the file may be corrupt or invalid.`);
            return;
        }
        this.show();
    }

    // Small pilot-facing message shown above the list, auto-dismissing.
    // textContent, not innerHTML — callers pass text that can include an
    // externally-controlled document name (see the same XSS note elsewhere
    // in this plan). Reused as-is by Task 7 for the quota-exceeded message.
    _showMessage(text) {
        const el = document.createElement('div');
        el.className = 'documents-message';
        el.textContent = text;
        this._listEl.prepend(el);
        setTimeout(() => el.remove(), 4000);
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
            // textContent, not innerHTML — doc.name traces back to a
            // pilot-supplied or (once Task 5 lands) another app's
            // attacker-controlled display name. Caught in plan review;
            // this repo's own route-table.js:2350 already uses textContent
            // for the same class of externally-sourced name.
            const nameSpan = document.createElement('span');
            nameSpan.className = 'documents-row-name';
            nameSpan.textContent = doc.name;
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'documents-row-delete';
            deleteBtn.textContent = '\u{1F5D1}'; // trash can
            deleteBtn.setAttribute('aria-label', `Delete ${doc.name}`);
            row.appendChild(nameSpan);
            row.appendChild(deleteBtn);
            wireTap(row, () => this._openDocument(doc));
            wireTap(deleteBtn, (e) => { e.stopPropagation(); this._deleteDocument(doc); });
            this._listEl.appendChild(row);
        }
    }

    // Also removes this document's pages from the shared search index --
    // otherwise a stale search result would point at a document that no
    // longer exists. Routed through _queueIndexOp, the same serialization
    // point _indexDocument uses, so a delete racing an in-flight import
    // can't corrupt the index.
    async _deleteDocument(doc) {
        await this._nasrDb.deleteDocument(doc.id);
        await this._queueIndexOp(async () => {
            const cache = await this._nasrDb.getAppCache('documents_search_index');
            if (!cache) return;
            const pages = cache.pages.filter(p => p.docId !== doc.id);
            await this._saveIndex(pages);
        });
        await this._renderList();
    }

    async _openDocument(doc) {
        this._viewerEl.innerHTML = '';
        this._viewerEl.style.display = '';
        const url = URL.createObjectURL(doc.blob);
        await renderPdfToContainer(url, this._viewerEl, { cssClass: 'documents-pdf' });
        URL.revokeObjectURL(url);
    }

    // Shared entry point for every import path -- file-picker (this task),
    // share-intent (Task 5), and bundled-asset seeding (Task 6) all funnel
    // through here so persistence + indexing + list refresh stay in one place.
    async _importFile(blob, name) {
        const doc = { name, type: 'imported', sizeBytes: blob.size, blob };
        await this._nasrDb.saveDocument(doc);
        await this._indexDocument(doc);
        await this._renderList();
    }

    // Serializes every read-modify-write of the single shared
    // 'documents_search_index' app_cache entry (see the concurrency note
    // above) -- work runs only after every previously-queued op has settled,
    // regardless of which caller queued it. Uses .then(work, work) so a
    // prior failure doesn't permanently wedge the queue for later callers.
    _queueIndexOp(work) {
        this._indexQueue = this._indexQueue.then(work, work);
        return this._indexQueue;
    }

    async _saveIndex(pages) {
        const idx = lunr(function () {
            this.ref('id');
            this.field('text');
            this.field('docName');
            for (const page of pages) this.add(page);
        });
        await this._nasrDb.putAppCache('documents_search_index', { lunrIndexJSON: idx.toJSON(), pages });
    }

    async _indexDocument(doc) {
        return this._queueIndexOp(async () => {
            const pdfjs = window.pdfjsLib;
            if (!pdfjs) return;
            const url = URL.createObjectURL(doc.blob);
            const cache = (await this._nasrDb.getAppCache('documents_search_index')) || { pages: [] };
            // Drop any stale pages for this doc id (re-import/re-index case) before adding fresh ones.
            let pages = cache.pages.filter(p => p.docId !== doc.id);
            try {
                const pdf = await pdfjs.getDocument(url).promise;
                for (let p = 1; p <= pdf.numPages; p++) {
                    // Awaited per-page, not one synchronous pass over every page --
                    // avoids a long blocking JS execution on a large PDF (see this
                    // repo's documented NASR-import IDB-hang failure mode).
                    const page = await pdf.getPage(p);
                    const content = await page.getTextContent();
                    const text = content.items.map(item => item.str).join(' ');
                    pages.push({ id: `${doc.id}:${p}`, docId: doc.id, pageNum: p, docName: doc.name, text });
                }
            } finally {
                URL.revokeObjectURL(url);
            }
            await this._saveIndex(pages);
        });
    }

    async _applySearch(query) {
        if (!query) { this._renderList(); return; }
        const cache = await this._nasrDb.getAppCache('documents_search_index');
        if (!cache?.lunrIndexJSON) { this._listEl.innerHTML = '<div class="documents-empty">No results.</div>'; return; }
        const idx = lunr.Index.load(cache.lunrIndexJSON);
        let results;
        try {
            results = idx.search(query);
        } catch (_) {
            // lunr's query parser throws on ordinary pilot-typed input -- e.g.
            // "time 12:30" (unrecognised field '12'), "engine~" (edit distance
            // must be numeric), "engine^" (boost must be numeric), "+" (expecting
            // term or field). Treat exactly like the zero-results case below
            // rather than letting it become an unhandled rejection off this
            // unguarded input listener.
            results = [];
        }
        this._listEl.innerHTML = '';
        if (results.length === 0) { this._listEl.innerHTML = '<div class="documents-empty">No results.</div>'; return; }
        for (const result of results) {
            const page = cache.pages.find(p => p.id === result.ref);
            if (!page) continue;
            // textContent, not innerHTML — page.docName traces back to a
            // pilot-supplied or (for share-intent) another app's attacker-
            // controlled display name (caught in plan review; this repo's own
            // route-table.js:2350 already uses textContent for the same class
            // of externally-sourced name, this was a deviation from precedent).
            const row = document.createElement('div');
            row.className = 'documents-row';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'documents-row-name';
            nameSpan.textContent = `${page.docName} — p.${page.pageNum}`;
            row.appendChild(nameSpan);
            wireTap(row, async () => {
                const doc = await this._nasrDb.getDocument(page.docId);
                if (doc) await this._openDocument(doc);
            });
            this._listEl.appendChild(row);
        }
    }
}
