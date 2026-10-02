-- Onboarding workbench tables. attribute_mapper creates its own history
-- tables; the LangGraph checkpointer creates its own checkpoint tables.

CREATE TABLE IF NOT EXISTS sponsors (
    id          text PRIMARY KEY CHECK (id <> '*' AND length(trim(id)) > 0),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
    id           text PRIMARY KEY,
    sponsor_id   text NOT NULL CHECK (sponsor_id <> '*'),
    entity       text NOT NULL,
    status       text NOT NULL,
    upload_uri   text NOT NULL,
    upload_name  text NOT NULL DEFAULT '',
    upload_sha   text NOT NULL,
    fingerprint  text NOT NULL,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_sponsor ON runs (sponsor_id, created_at DESC);

-- Append-only: no UPDATE or DELETE is ever issued against this table.
CREATE TABLE IF NOT EXISTS run_decisions (
    run_id   text NOT NULL REFERENCES runs (id),
    seq      integer NOT NULL,
    kind     text NOT NULL,
    payload  jsonb NOT NULL,
    actor    text NOT NULL,
    at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS recipes (
    id           text PRIMARY KEY,
    sponsor_id   text NOT NULL CHECK (sponsor_id <> '*'),
    entity       text NOT NULL,
    fingerprint  text NOT NULL,
    version      integer NOT NULL,
    sha256       text NOT NULL,
    source_uri   text NOT NULL,
    origin       text NOT NULL CHECK (origin IN ('standard', 'authored')),
    bindings     jsonb NOT NULL DEFAULT '{}'::jsonb,
    layout       jsonb NOT NULL DEFAULT '{}'::jsonb,
    approved_by  text NOT NULL,
    approved_at  timestamptz NOT NULL,
    active       boolean NOT NULL DEFAULT true,
    UNIQUE (sponsor_id, entity, fingerprint, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_one_active
    ON recipes (sponsor_id, entity, fingerprint) WHERE active;

CREATE TABLE IF NOT EXISTS artifacts (
    run_id  text NOT NULL REFERENCES runs (id),
    name    text NOT NULL,
    uri     text NOT NULL,
    sha256  text NOT NULL,
    kind    text NOT NULL,
    PRIMARY KEY (run_id, name)
);
