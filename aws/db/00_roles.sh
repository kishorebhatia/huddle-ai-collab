#!/bin/bash
# Supabase-shaped roles and stubs so supabase/migrations apply unchanged on plain Postgres.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d huddle <<SQL
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password '${AUTHENTICATOR_PASSWORD}';
grant anon, authenticated, service_role to authenticator;

-- Realtime is served by aws/server (LISTEN/NOTIFY); the publication only has to exist.
create publication supabase_realtime;

-- Storage is served from disk by aws/server; these stubs let the bucket/policy lines run.
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id bigserial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
SQL
