# Document Library — Design Spec

## Problem

No way to import reference documents (POHs, personal checklists, VFR/IFR
chart legends, other flight-safety reference material) into FlyTab and keep
them accessible and searchable while the app is open. The only existing
PDF-handling code is the approach-plate viewer (`web/cockpit/approach-charts.js`)
— it renders pages but never extracts or searches text, and it's scoped to
plates specifically, not arbitrary documents.

## Goals

- Import a PDF document into FlyTab via Android share-intent or an in-app
  file picker.
- Keep imported documents available in a dedicated library, reachable
  anytime the app is open, fully offline.
- Full-text search across the library — both filenames and the text content
  inside each document — with no network dependency (per this repo's
  Network Constraint rule: the tablet has no internet in the air, ever).
- Ship the standard FAA VFR and IFR Aeronautical Chart legend PDFs
  pre-loaded in the library by default, so they work from first launch
  without the pilot needing to source and import them separately.

## Non-goals (this iteration)

- **On-device "AI search."** Investigated during triage: the target tablet
  (Lenovo Yoga Tab Plus, Snapdragon 8 Gen 3, 20 TOPS NPU) has real on-device
  AI hardware, and Lenovo has announced its own "AI Now" document-search
  feature — but that appears to be a first-party OS-shell capability; no
  public third-party API was found for it. Android's own ML Kit GenAI APIs
  (Gemini Nano via AICore) *are* documented for third-party apps, but are
  primarily confirmed on Pixel devices, and integrating them would need a
  new native Capacitor plugin — comparable scope to the existing EngineML
  TFLite integration. If AI-powered semantic search is wanted later, it
  needs its own feasibility spike (confirm device/AICore support first)
  before any design work — not assumed available here.
- **OCR for scanned/image-only PDFs.** Text extraction in this spec is via
  PDF.js's `getTextContent()`, which only reads an existing text layer.
  Scanned documents with no text layer won't be searchable by content (title
  and manually-entered metadata only) until/unless OCR is added separately.
- Document editing, annotation, or cloud sync/backup — this app has no
  cloud storage anywhere in its architecture (`localStorage`/IndexedDB
  only), and nothing here changes that.

## Architecture

### Storage

Follow the existing IndexedDB caching pattern already used for plates, NASR,
and CIFP data (`approach-charts.js`, `web/shared/nasr-db.js`) rather than
introducing a new dependency. Checked whether Capacitor's Filesystem plugin
was a better fit for large binary files first — it's referenced only in
forward-looking comments elsewhere in this repo (`web/app.js:1061`,
`web/cockpit/flight-sync.js:54`, `web/cockpit/fuel-overlay.js:708`, all
"Phase N will use Capacitor Filesystem..." — never actually implemented),
so it isn't an established pattern here. IndexedDB blob storage is.

New object store, tentatively `flytab_documents` (new feature, not migrating
legacy data — no `flypi_` prefix; see this repo's CLAUDE.md on why that
prefix is legacy-only). Records: `{id, name, type: 'bundled'|'imported',
sizeBytes, importedAt, blob, indexed: boolean}`. Exact field list finalized
at implementation time.

### Import

- **Share-intent**: new `<intent-filter>` in `AndroidManifest.xml` for
  `android.intent.action.SEND` with PDF mime type, routed to a "Documents"
  landing handler — mirrors the existing `flytab://` deep-link handling
  already in `web/app.js` (`_initDeepLink`/`_loadPlanById`).
- **In-app file picker**: a file-picker entry point inside the new
  Documents panel for browsing device storage directly.

### Search & indexing

- Extract text per-page via PDF.js's `getTextContent()` API — vendored
  already (`web/lib/`) for the plate viewer, but that viewer only renders
  pages today and never calls this API; this is a new code path.
- Index with **lunr.js**: zero-build, ships a plain-global browser build (no
  bundler in this app — new modules load via `<script>` tags per this
  repo's Key Conventions), and is proven at this scale (dozens to low
  hundreds of documents — not a search-at-scale problem). Vendor into
  `web/lib/` alongside the other unbundled third-party libs (Leaflet,
  Chart.js, PDF.js, jszip).
- Index built **at import time**, not lazily. Imports happen on the ground
  as part of pilot prep, matching the existing preflight-prefetch pattern
  already used for NOTAMs and weather. Large PDFs are extracted
  page-by-page (not as one synchronous pass) to avoid a long blocking JS
  execution — this repo already documents a real IDB-transaction-hang
  failure mode from exactly this class of mistake during NASR import; the
  same caution applies here.
- The built index is persisted in IndexedDB alongside document metadata so
  it doesn't need to be rebuilt on every app launch.

### UI

- New MORE-drawer item, "Documents" — matches the existing navigation
  pattern (checklists, logbook, etc. all live in the MORE drawer).
- List view of all documents (bundled + imported), with a search box at the
  top searching both filenames and indexed content.
- Tapping a search result opens the document at the matching page.
- The document viewer reuses the plate viewer's existing PDF.js rendering
  code rather than duplicating it. Whether that becomes a shared base
  component or the plate viewer calls into a common renderer is an
  implementation-time refactor decision, not resolved here.

### Bundled VFR/IFR legends

**Decision: ship as static Android assets in the APK** (same delivery
mechanism as the TFLite anomaly-detection model), not fetched from the
home-server pipeline the way NASR/tiles/plates are.

Reasoning: legends are small and essentially static content, and need to be
available from first launch — including before the tablet has ever reached
home WiFi to sync with the home-server pipeline. NASR/tiles/plates are
large, airport-specific, and change often enough to need periodic pipeline
updates; legends don't have that same pressure. Trade-off accepted:
updating a legend later requires an app release rather than a pipeline
refresh — acceptable given how rarely FAA legend content changes.

## Explicitly out of scope

Covered under Non-goals above (on-device AI search, OCR) — repeated here
per this repo's spec convention of listing out-of-scope items alongside
open questions.

## Open questions

Still genuinely open:

1. **Search library API surface / index-persistence format** — `lunr.js`'s
   serialized index format and exact rebuild-on-schema-change strategy is
   an implementation-time detail, not resolved here.
2. **Storage quota handling.** IndexedDB has browser-imposed storage
   limits; large imported POHs/manuals could hit them. Needs a "storage
   full" UX — check whether an existing pattern for this exists elsewhere
   in the app (other caches) before inventing a new one.
3. **Plate-viewer refactor boundary.** Whether PDF.js rendering becomes a
   shared component between the plate viewer and the new document viewer,
   or the document viewer gets its own copy, is an implementation-time
   call — flagged here so it isn't silently decided either way during
   implementation.
