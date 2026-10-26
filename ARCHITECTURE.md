# Architecture checkpoint

```text
Electron / React UI (host)
        │
        ├── article intent → localhost live OCR federation
        │                     └── five-minute bounded metadata cache
        │
        ├── exact-issue intent → trusted IPC coverage router
        │                         └── curated Newsstand registry (49 sources)
        │
        ├── source-view intent → trusted main-process URL builder
        │                        └── isolated persistent WebContentsView
        │                            ├── strict per-source HTTPS navigation
        │                            ├── denied permissions and pop-ups
        │                            └── provider-owned sign-in/cache/downloads
        │
        ├── issue-reel intent → trusted native file picker
        │                       └── PDF/JPEG/PNG validation + bounded local conversion
        │                           └── atomic private reel store
        │                               └── opaque microfiche-reel:// page assets
        │
        │ localhost HTTP
        ▼
FastAPI federation service (container)
        │
        ├── adapter: Library of Congress / Chronicling America
        ├── adapter: Internet Archive Newspapers
        └── adapter: DigitalNZ / Papers Past
        │
        ▼
Normalization layer
        │
        ├── response → desktop UI
        ├── short-lived metadata → bounded process-local LRU
        └── durable cache/catalog → PostgreSQL 18 [planned; schema exists, runtime persistence is not active]
```

## Rules

1. External archives are never allowed to leak provider-specific shapes into the UI.
2. One failed provider must not fail the whole search.
3. Large page images are lazy-loaded only when a result is opened.
4. Original source provenance and rights metadata stay attached to every normalized result.
5. The source catalog and live search engine are separate concerns.
6. Provider secrets stay server-side, never in the Electron renderer.
7. Renderer requests identify a source; only the trusted main process may build and allowlist an external URL.
8. Source viewers open one source at a time. No bulk query spraying.
9. Exact-issue routing requires one publication and one valid date; an article keyword is optional and never substitutes for either field.
10. Coverage ranges select archive doors, not individual issues. The UI must not claim that an edition exists until the destination archive confirms it.
11. Structured handoff context is validated and converted to clipboard text in Electron's trusted main process; the renderer never supplies an external URL.
12. Issue Reel file paths never cross into the renderer. The trusted main process owns selection, copying, validation, conversion, and storage.
13. Reel media is exposed only through manifest-resolved, read-only `microfiche-reel://` page and thumbnail identifiers; arbitrary `file:` access is forbidden.
14. Imported issues remain local. A PDF text layer may be indexed per page, but image-only scans must be labeled honestly until OCR is installed.
15. Authenticated website sources are not represented as official APIs. Their cookies stay in an isolated Electron partition, and the renderer receives only source identity plus an origin-only display address.
16. Paid page content uses the provider's normal browser cache and controls. Durable Issue Reels require an explicit user-selected download; Microfiche does not silently harvest or bulk-cache subscription pages.
17. Public API metadata caching is small, short-lived, and in memory only. Failed runs, binary data, and credential-shaped metadata are never cached.
