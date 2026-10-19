# Huddle on AWS: runbook

Use this to stand Huddle up again, keep it running, and take it down. What it is and why:
[README-AWS.md](../README-AWS.md). What we learned running it: [LEARNINGS.md](LEARNINGS.md).

```
aws/
  provision.sh        create key pair, security group, EC2 + Elastic IP, CloudFront
  gen-env.mjs         write aws/.env with fresh DB passwords, JWT secret, anon/service keys
  .env.example        every other variable, with what it is for
  docker-compose.yml  db (Postgres 16) + rest (PostgREST) + app (the Deno gateway and all functions)
  db/                 roles and realtime triggers so supabase/migrations apply on plain Postgres
  server/             the gateway: REST proxy, functions, storage, realtime, GitHub sign-in, MCP
  autodeploy.sh       forced command for CI's deploy key: pull `live`, apply new migrations, restart
  backup.sh           database (without secrets) + uploads -> a local folder
  restore.sh          load a backup onto a new box
```

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Site, API, functions, realtime, MCP | EC2 `t3.medium`, Amazon Linux 2023, Docker Compose | one box; 30 GB gp3 |
| HTTPS | CloudFront, default `*.cloudfront.net` certificate | caching off; WebSockets work as is |
| Database | Postgres 16 in the `db` container, volume `huddle_pgdata` | migrations in `supabase/migrations` |
| Uploads | `huddle_storage` volume on the box | not on S3 yet |
| Models | Bedrock, `us-west-2` | Haiku 4.5 (JSON steps), Sonnet 5.5 (builds), Nova 2 Lite (research) |
| Hosting of built apps | Daytona sandboxes | stop after 15 idle minutes |
| Research reads, smoke tests | Anchor | Web Unlocker for reads; one session per smoke test |
| Traces, evals, CI experiments | Arize AX | |
| Deploys | GitHub Actions `.github/workflows/evals.yml` | evals gate, then `live` branch, then SSH forced command |

The last deployment (hackathon account 484907531942, `us-west-2`) used these:
site `https://d2k5rbdeilbp1b.cloudfront.net`; instance `i-04386ab81571fe659`; security group `sg-0096696e98ce3c727`; CloudFront `ER84XU0SCDDSZ`.
That account closes after the event, so a new deploy gets new IDs.

## First deploy (about 30 minutes)

You need:
- AWS CLI credentials for an account with Bedrock model access in the region;
- keys for Anchor, Daytona and Arize;
- a GitHub OAuth App, plus a fine-grained token for the public-rooms org (optional; without them, rooms work and the GitHub features stay off).

```bash
# 1. AWS resources. Prints the site URL, instance and origin host.
AWS_REGION=us-west-2 aws/provision.sh huddle

# 2. Config. gen-env writes the generated block; copy the rest from .env.example and fill it in.
PUBLIC_SITE_URL=https://<dist>.cloudfront.net node aws/gen-env.mjs
sed -n '/--- models ---/,$p' aws/.env.example >> aws/.env && $EDITOR aws/.env

# 3. Ship config and start. First boot clones the repo; give user-data about 2 minutes.
H=ec2-user@<origin host>; K=aws/huddle-key.pem
scp -i $K aws/.env $H:huddle/aws/.env
ssh -i $K $H 'cd huddle/aws && sudo docker compose -p huddle up -d && sudo docker compose -p huddle ps'
curl -fsS https://<dist>.cloudfront.net/healthz
```

`provision.sh` scripts the steps the Oct 16 deploy did by hand. It hasn't been run end to end, so check each
resource it prints.

The database schema applies on the first start: every migration is mounted into `docker-entrypoint-initdb.d`.
**When you add a migration, add it to that list in `docker-compose.yml` as well.** `autodeploy.sh` applies new
migrations to running boxes; the list covers new boxes.

**Arize, once per space.** Scores attach to spans only if their annotation config exists. See README-AWS.md, "Arize eval configs".

**GitHub OAuth App.** Set the callback URL to `https://<dist>.cloudfront.net/auth/callback`. The first sign-in
by a login in `ADMIN_LOGINS` creates the operator room.

## Automatic deploys (CI)

Every push to `redesign-v4` runs `.github/workflows/evals.yml`:
1. Type-check, then `node --check web/*.js`.
2. The brief eval gate, then the plan and review gate.
3. Force-push the commit to `live`.
4. SSH with the deploy key, which can only run `aws/autodeploy.sh`.
5. Curl `/healthz`.

Pull requests run steps 1 and 2 only.

One-time setup:

```bash
ssh-keygen -t ed25519 -N '' -f /tmp/deploy_key -C huddle-ci
# on the box, append to ~/.ssh/authorized_keys (one line):
#   command="/home/ec2-user/huddle/aws/autodeploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <contents of /tmp/deploy_key.pub>
gh secret set DEPLOY_SSH_KEY < /tmp/deploy_key
ssh-keyscan -t ed25519 <origin host> | gh secret set DEPLOY_KNOWN_HOSTS
gh variable set DEPLOY_HOST --body <origin host>
gh variable set HUDDLE_URL --body https://<dist>.cloudfront.net
gh variable set ARIZE_SPACE_ID --body <space id>
grep ^EVAL_TOKEN= aws/.env | cut -d= -f2- | gh secret set EVAL_TOKEN
gh secret set ARIZE_API_KEY          # paste when prompted
rm /tmp/deploy_key /tmp/deploy_key.pub
```

**Deploy without a code change.** Run `gh workflow run evals.yml --ref redesign-v4`. Re-running a pull-request run doesn't deploy.

**Roll back.** Revert on `redesign-v4` and push, so the revert goes through the gate. In an emergency:
`git push --force origin <good sha>:live`, then trigger the workflow or wait for the next deploy.

## Operate

Set this up once:

```bash
H=ec2-user@<origin host>; K=aws/huddle-key.pem
DC='cd huddle/aws && sudo docker compose -p huddle'
```

Then:

| Task | Command |
|---|---|
| Status | `ssh -i $K $H "$DC ps"` |
| Logs (app) | `ssh -i $K $H "$DC logs --tail 200 -f app"` |
| Restart the app (reloads `.env`) | `ssh -i $K $H "$DC up -d --force-recreate app"` |
| SQL shell | `ssh -t -i $K $H "$DC exec db psql -U postgres -d huddle"` |
| Deployed commit | `ssh -i $K $H 'git -C huddle log --oneline -1'` |
| Disk | `ssh -i $K $H 'df -h /; sudo docker system df'` |

**Rotate a key.** Edit `aws/.env` locally, copy it to the box, and restart the app.
- If the key is also a GitHub secret (`ARIZE_API_KEY`, `EVAL_TOKEN`), update it there too.
- Admins can set some server keys from the operator room's secret form; those are kept in `server_secrets` and override `.env` on start.
- Signs a key has expired or been revoked:
  - Bedrock returns `ExpiredTokenException` or 403.
  - Arize or Daytona return 401.
  - GitHub returns 401 "Bad credentials". For an admin's own token, the admin signs in again.

**Daytona credits.**
- Built apps run in sandboxes that stop after `SANDBOX_IDLE_MINUTES` (15). A visit wakes them.
- At the account's disk limit, Huddle archives its oldest prototype sandbox. Nothing is ever deleted.
- To stop every running Huddle sandbox:
  ```bash
  curl -s -H "Authorization: Bearer $DAYTONA_API_KEY" https://app.daytona.io/api/sandbox \
    | jq -r '(.items // .)[] | select(.labels.app=="huddle" and .state=="started") | .id' \
    | xargs -I{} curl -s -X POST -H "Authorization: Bearer $DAYTONA_API_KEY" https://app.daytona.io/api/sandbox/{}/stop
  ```

**Anchor.** The free plan has few concurrent browser sessions.
- Page reads use the sessionless Web Unlocker. Each smoke test opens one session and closes it.
- If you hit 429s, list and close leftover sessions in the Anchor dashboard.

**Credential lifetimes.** Workshop/SSO session credentials in `.env` expire, often within hours.
For a box that should keep running, use `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key) or an IAM user's keys.

## Backup and restore

```bash
# Back up the live box to ~/huddle-backups/huddle-backup-<date>/ (the private key stays local)
SSH_OPTS="-i aws/huddle-key.pem" aws/backup.sh ec2-user@<origin host>
# Restore onto a new box after "First deploy" step 3
SSH_OPTS="-i aws/huddle-key.pem" aws/restore.sh ec2-user@<new host> ~/huddle-backups/huddle-backup-<date>
```

**What's in a backup:**
- the public schema in three sections (schema, data, constraints);
- users without their GitHub tokens;
- the uploads volume;
- the deployed commit.

**What's not:**
- room, user and server secrets;
- MCP links.

After a restore, people sign in again, room keys are entered again, and agents get new MCP links.
`aws/.env` is not in the backup either: keep it in a password manager.

**Tested.** The Oct 19 backup was restored into a fresh Postgres from `docker-compose.yml`. It brought back 32 rooms, 284 events, 152 jobs, 18 RLS policies, the realtime triggers and the foreign keys. The secret tables came back empty.

## Change provider or host

**Models.** `AI_PROVIDER=gemini` with `GEMINI_API_KEY` runs everything on Gemini. To stay on Bedrock outside a workshop account, use `AWS_BEARER_TOKEN_BEDROCK`.
- Model IDs can be overridden with `BEDROCK_FAST_MODEL`, `BEDROCK_SMART_MODEL`, `BEDROCK_SEARCH_MODEL` and `BEDROCK_MEDIA_MODEL`.
- For another provider, add an adapter next to [bedrock.ts](../supabase/functions/_shared/bedrock.ts) with the same `geminiJson` and `gemini` shape.
- Then run `evals/bakeoff.ts` and the CI gates before switching.

**Hosting.** Nothing here is EC2-specific beyond `provision.sh`. Any VM with Docker works. Run the same compose file, point HTTPS at port 80, and set `PUBLIC_SITE_URL` and the CI variables.
- To move, back up the old box, provision the new one, restore, then switch DNS or CloudFront.
- Update the GitHub OAuth callback and `HUDDLE_URL`.

## Tear down

Take a backup first. Then delete in this order:
1. Disable and delete the CloudFront distribution.
2. Terminate the instance.
3. Release the Elastic IP.
4. Delete the security group and the key pair.

```bash
aws cloudfront get-distribution-config --id $DIST > /tmp/cf.json   # set Enabled=false, then:
aws cloudfront update-distribution --id $DIST --if-match $(jq -r .ETag /tmp/cf.json) --distribution-config "$(jq .DistributionConfig /tmp/cf.json | jq '.Enabled=false')"
aws cloudfront wait distribution-deployed --id $DIST
aws cloudfront delete-distribution --id $DIST --if-match <new ETag>
aws ec2 terminate-instances --instance-ids $ID && aws ec2 wait instance-terminated --instance-ids $ID
aws ec2 release-address --allocation-id <alloc id>
aws ec2 delete-security-group --group-id $SG && aws ec2 delete-key-pair --key-name huddle-key
```

Then:
- In GitHub, remove `DEPLOY_SSH_KEY` and set `HUDDLE_URL` to the new site, or disable the workflow.
- Stop the Daytona sandboxes, and revoke the keys you no longer need.
