# Foxtail Microfiche

A microfiche-inspired desktop research workstation for federated historical-newspaper search.

## Architecture

- **Desktop:** Electron + React + TypeScript + Vite
- **API:** FastAPI
- **Database:** PostgreSQL 18
- **Runtime split:** Electron runs natively; API/database run in Docker Compose
- **Search model:** provider adapters fan out concurrently and normalize results into one schema

## Newspaper Research Room — v0.3.0

Working foundation:

- Electron security baseline: context isolation on, Node integration off, sandbox on
- Microfiche-style Reader with live page imagery, OCR, provenance, citation copy, and film-strip navigation
- Interactive zoom, brightness, contrast, invert and film-strip controls
- FastAPI `/health`, `/sources`, and federated `/search` endpoints
- Three live, keyless provider adapters: Library of Congress Chronicling America, Internet Archive Newspapers, and DigitalNZ / Papers Past
- Fair concurrent fan-out with one bounded transient retry and a five-minute, 96-entry metadata-only cache
- Newsstand catalog with 49 reviewed newspaper engines across six shelves
- Exact Issue mode that treats publication-and-date browsing separately from OCR article search
- Coverage-aware routing to the official Philadelphia Inquirer archive and the Free Library's 1860–2001 full-page collection
- Private Issue Reels that import one PDF or an ordered JPEG/PNG page set into the existing Microfiche reader
- A persistent local Reel cabinet, full-issue horizontal filmstrip, page keyboard controls, embedded PDF text, and per-page hashes/provenance
- A main-process-owned file picker, copy-before-decode pipeline, bounded converters, strict file signatures, atomic storage, and opaque read-only page URLs
- Secure, one-source-at-a-time in-app viewing for specialist, state, international, library, paid, and legacy collections
- A private persistent Newsstand browser session with Back, Forward, Reload, explicit external opening, strict source navigation boundaries, and browser-managed website cache
- PostgreSQL source/publication/coverage/cache/project/search/clipping/note schema
- Docker Compose backend bound to localhost only

The Newsstand deliberately distinguishes live federation from source viewers. It never sprays a query across all 49 sites, and renderer code cannot construct or open arbitrary URLs. The three documented public APIs run together; every other reviewed source opens on demand inside the retro viewer with its query prepared. Live filters refine a bounded provider result window, so the current release does not claim an exhaustive holdings search.

Exact Issue mode does not send a blank keyword query to the live OCR adapters. It matches a publication and date against reviewed coverage records, then offers one deliberate archive handoff at a time. A coverage match means the archive says its date range includes that day; it does not prove an edition was published that day, that the issue is complete, or that access is free. The official Inquirer image archive is labeled **PAID**. The Free Library Inquirer Digital Archive is labeled **LIBRARY** and requires a Free Library card for online access.

Issue Reels bridge that handoff back into the reader. After lawfully downloading an issue, open **Reels**, enter its publication/date/provenance, and choose either one PDF or numbered JPEG/PNG pages. Microfiche makes normalized local reading frames without changing the selected files. PDF text is shown only when the document contains an embedded text layer; image-only scans are not advertised as OCR because an image OCR engine is not installed.

Newspapers.com is integrated as an authenticated website viewer, not described as an official developer API. Sign-in and ordinary Chromium cache stay in Microfiche's dedicated local partition. The provider owns the search results, page controls, access decisions, and permitted downloads. Microfiche does not bulk-download or turn paid pages into an offline cache; a page or issue the user lawfully downloads can be imported explicitly as an Issue Reel.

Not implemented yet:

- Authenticated adapters such as Trove or Europeana
- clipping persistence and notes persistence
- OCR for image-only Issue Reel scans
- authentication / API-key secrets management for providers that require keys
- production desktop packaging

Retired or discontinued projects are not presented as live APIs. Google News Archive is labeled as a legacy handoff, and Newspaper Navigator is intentionally excluded.

## Prerequisites on Debian/Foxtail

- Docker Engine + Docker Compose plugin
- Node.js 22.12 or newer
- npm
- Poppler command-line tools (`pdfinfo`, `pdftoppm`, and `pdftotext`)
- ImageMagick 7 (`magick`)
- `prlimit` and Bubblewrap (`bwrap`); Issue Reel conversion fails closed when the filesystem/network sandbox cannot start

## Run

```bash
cp .env.example .env
./scripts/dev.sh
```

API health endpoint:

```bash
curl http://127.0.0.1:8787/api/v1/health
```

Desktop verification:

```bash
cd apps/desktop
npm run check
```

Optional live-provider probe (from the API container/runtime):

```bash
python -m app.tests_live
```

Stop backend:

```bash
./scripts/stop.sh
```

## Real adapter contract

Create `apps/api/app/adapters/<provider>.py`, subclass `ArchiveAdapter`, normalize provider responses into `SearchResult`, then register the adapter in `registry.py`.

That is deliberately the only provider-specific boundary. The React desktop never needs to know whether a result came from LOC, Internet Archive, DigitalNZ, or a future archive.

## Source policy

- Public and lawfully accessible collections only
- Exact source and result host allowlists in Electron's trusted main process
- Original URL, provider, date, rights, and source metadata stay attached to results
- Provider failures are isolated and shown as source health, not hidden
- Public search metadata may be held in a small process-local cache for five minutes; page binaries, cookies, and credentials are never placed in it
- Account, library, paid, mixed-access, and legacy sources are labeled before handoff
- Paid-provider sign-in cookies remain inside the isolated Electron partition and never enter FastAPI, PostgreSQL, logs, or the renderer
- Exact-issue clipboard details are assembled in the trusted main process and copied only after an explicit source click
