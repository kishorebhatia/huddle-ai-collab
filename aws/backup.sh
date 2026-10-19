#!/bin/bash
# Back up a running Huddle box to a local folder: the database (without secrets), uploads, and the commit.
#   aws/backup.sh <ssh-host | local> [out-dir]        e.g. aws/backup.sh huddle ~/huddle-backups
# Secrets stay out: room_secrets, user_secrets, server_secrets and mcp_links (hashed links) keep their schema
# but no rows, and users are saved without token_enc (their GitHub tokens). After a restore, people sign in
# again, room keys are re-entered, and MCP links are re-issued.
set -euo pipefail
HOST=${1:?ssh host or "local"}; OUT=${2:-$HOME/huddle-backups}/huddle-backup-$(date +%Y%m%d-%H%M)
mkdir -p "$OUT" && chmod 700 "$OUT"
# SSH_OPTS (e.g. "-F path/to/ssh_config") is passed to ssh. HOST=local runs against this machine's stack (PROJECT=huddle-local, from the repo root); anything else is an ssh host.
PROJECT=${PROJECT:-$([ "$HOST" = local ] && echo huddle-local || echo huddle)}
if [ "$HOST" = local ]; then DC="docker compose -f aws/docker-compose.yml -p $PROJECT"; GIT=.; run() { bash -c "$1"; }
else DC="sudo docker compose -f huddle/aws/docker-compose.yml -p $PROJECT"; GIT=huddle; run() { ssh ${SSH_OPTS:-} "$HOST" "$1"; }; fi
DUMP="$DC exec -T db pg_dump -U postgres -d huddle -n public --no-owner"
NODATA="--exclude-table-data=public.room_secrets --exclude-table-data=public.user_secrets --exclude-table-data=public.server_secrets --exclude-table-data=public.mcp_links --exclude-table-data=public.users"
# Three sections so restore can load users (without tokens) after the data and before the foreign keys.
for s in pre-data data post-data; do run "$DUMP --section=$s $NODATA" | gzip > "$OUT/db-$s.sql.gz"; done
run "$DC exec -T db psql -U postgres -d huddle -c \"copy (select id, github_id, login, name, avatar_url, email, null as token_enc, scopes, created_at, updated_at from users) to stdout csv header\"" \
  > "$OUT/users-no-tokens.csv"
run "$DC exec -T app tar -C /data/storage -czf - ." > "$OUT/uploads.tar.gz"
run "git -C $GIT rev-parse HEAD" > "$OUT/deployed-commit.txt"
ls -la "$OUT"
