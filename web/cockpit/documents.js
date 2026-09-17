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

    // No search-index cleanup yet at this point in the build-up (Task 4
    // adds indexing) -- extended there to also remove this document's pages
    // from the search index once one exists.
    async _deleteDocument(doc) {
        await this._nasrDb.deleteDocument(doc.id);
        await this._renderList();
    }

    async _openDocument(doc) {
        this._viewerEl.innerHTML = '';
        this._viewerEl.style.display = '';
        const url = URL.createObjectURL(doc.blob);
        await renderPdfToContainer(url, this._viewerEl, { cssClass: 'documents-pdf' });
        URL.revokeObjectURL(url);
    }
}
