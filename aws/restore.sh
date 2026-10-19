#!/bin/bash
# Restore a backup made by aws/backup.sh onto a box whose stack is up (`docker compose up -d` made the schema).
#   aws/restore.sh <ssh-host | local> <backup-dir>
# Replaces everything in the public schema, so run it on a new box, not one with data you want to keep.
set -euo pipefail
HOST=${1:?ssh host or "local"}; DIR=${2:?backup dir}
PROJECT=${PROJECT:-$([ "$HOST" = local ] && echo huddle-local || echo huddle)}
if [ "$HOST" = local ]; then DC="docker compose -f aws/docker-compose.yml -p $PROJECT"; run() { bash -c "$1"; }
else DC="sudo docker compose -f huddle/aws/docker-compose.yml -p $PROJECT"; run() { ssh ${SSH_OPTS:-} "$HOST" "$1"; }; fi
PSQL="$DC exec -T db psql -U postgres -d huddle -v ON_ERROR_STOP=1 -q"
run "$PSQL -c 'drop schema public cascade'"
gunzip -c "$DIR/db-pre-data.sql.gz" | run "$PSQL"
gunzip -c "$DIR/db-data.sql.gz" | run "$PSQL"
run "$PSQL -c \"copy users (id, github_id, login, name, avatar_url, email, token_enc, scopes, created_at, updated_at) from stdin csv header\"" < "$DIR/users-no-tokens.csv"
run "$PSQL -c \"select setval(pg_get_serial_sequence('users','id'), coalesce(max(id), 1)) from users\"" >/dev/null
gunzip -c "$DIR/db-post-data.sql.gz" | run "$PSQL"
# Grants PostgREST needs (the dump has table grants, not the schema's).
run "$PSQL -c 'grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to anon, authenticated, service_role; grant all on all sequences in schema public to anon, authenticated, service_role;'"
run "$DC exec -T app sh -c 'mkdir -p /data/storage && tar -C /data/storage -xzf -'" < "$DIR/uploads.tar.gz"
run "$DC kill -s SIGUSR1 rest >/dev/null; $DC restart app >/dev/null"
echo "restored data from $(cat "$DIR/deployed-commit.txt" 2>/dev/null || echo '?') onto $HOST"
