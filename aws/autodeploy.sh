#!/bin/bash
# Runs every minute on the EC2 box (systemd timer, see aws/README section in the doc). Follows the `live`
# branch, which CI only moves after the evals pass, and redeploys when it changes.
set -euo pipefail
cd /home/ec2-user/huddle
git fetch -q origin live
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/live)" ] && exit 0
old=$(git rev-parse HEAD)
git reset -q --hard origin/live
# Apply migrations added since the last deploy (each one is written to be safe to re-run).
for f in $(git diff --name-only --diff-filter=A "$old" HEAD -- supabase/migrations); do
  sudo docker compose -f aws/docker-compose.yml -p huddle exec -T db psql -U postgres -d huddle -v ON_ERROR_STOP=1 < "$f"
done
sudo docker compose -f aws/docker-compose.yml -p huddle kill -s SIGUSR1 rest >/dev/null 2>&1 || true
sudo docker compose -f aws/docker-compose.yml -p huddle up -d --force-recreate app
echo "deployed $(git rev-parse --short HEAD)"
