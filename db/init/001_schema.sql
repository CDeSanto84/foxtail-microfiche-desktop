CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sources (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    access_kind TEXT NOT NULL DEFAULT 'api',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS publications (
    id BIGSERIAL PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    city TEXT,
    region TEXT,
    country TEXT,
    language TEXT,
    external_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS publications_name_trgm_idx
    ON publications USING gin (canonical_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS coverage (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    publication_id BIGINT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    date_start DATE,
    date_end DATE,
    searchable BOOLEAN NOT NULL DEFAULT FALSE,
    ocr_available BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    UNIQUE (source_id, publication_id, date_start, date_end)
);

CREATE TABLE IF NOT EXISTS cached_results (
    id UUID PRIMARY KEY,
    source_slug TEXT NOT NULL,
    external_id TEXT NOT NULL,
    publication TEXT NOT NULL,
    published_date DATE,
    location TEXT,
    page_number INTEGER,
    frame_number INTEGER,
    headline TEXT,
    snippet TEXT,
    ocr_text TEXT,
    thumbnail_url TEXT,
    image_url TEXT,
    source_url TEXT,
    rights TEXT,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_slug, external_id)
);
CREATE INDEX IF NOT EXISTS cached_results_ocr_fts_idx
    ON cached_results USING gin (to_tsvector('english', COALESCE(ocr_text, '')));

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saved_searches (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    query JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clippings (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    cached_result_id UUID REFERENCES cached_results(id) ON DELETE SET NULL,
    title TEXT,
    crop JSONB,
    image_path TEXT,
    ocr_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    cached_result_id UUID REFERENCES cached_results(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sources (slug, name, base_url, access_kind)
VALUES ('demo', 'Foxtail Demo Archive', NULL, 'local')
ON CONFLICT (slug) DO NOTHING;
