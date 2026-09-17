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
