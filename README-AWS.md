# Huddle on AWS: Bedrock, Anchor, Daytona and Arize

**Live:** https://d2k5rbdeilbp1b.cloudfront.net/?room=demo

The same Huddle as [README.md](README.md): one link, everyone talks into their own laptop, and Huddle
keeps one living brief and runs agent work for the room. This build runs entirely on AWS with no
Supabase and no Gemini key, and adds three platforms to the agent loop:

- **Anchor Browser** reads research sources in a cloud browser and smoke-tests every prototype on its
  live URL.
- **Daytona** hosts each prototype in its own sandbox with a public URL, and checks its scripts there.
- **Arize AX** traces every pipeline and model call, scores each stage, and gates prompt changes in CI.

```
browser (each teammate)            AWS: CloudFront → EC2 (Docker Compose)                 outside services
──────────────────────            ──────────────────────────────────────                 ────────────────
REST, uploads, function calls ──►  Deno gateway ── PostgREST ── Postgres 16
realtime (WebSocket)          ◄──►    │ 11 agent functions, unchanged Supabase protocols
                                      ├──► Amazon Bedrock   Claude Haiku 4.5 · Claude Sonnet 5.5 · Nova 2 Lite
                                      ├──► Anchor Browser   read source pages · smoke-test prototypes (live view)
                                      ├──► Daytona          sandbox per prototype · node --check · public URL
                                      └──► Arize AX         OTLP traces · eval annotations · experiments
GitHub Actions ── evals/run.ts ──► eval-run function ──► Arize experiment ──► gate ──► `live` branch ──► EC2
```

## What each platform does

| Platform | Stage | What it adds | Measured on the live site |
|---|---|---|---|
| **AWS** | Everything | One box: Postgres, PostgREST and a Deno gateway behind CloudFront. Bedrock runs all the AI. | Brief update 3.5 s · image read 1.2 s |
| **Anchor** | Research | Web Unlocker renders the top 3 sources in a real browser; a judge checks the brief against them. | Groundedness 0.85–0.95 on recent runs |
| **Anchor** | Smoke test | Opens the Daytona URL and uses the prototype like a first-time user. The room can watch the live view; a screenshot lands in the stream. | Passed on both runs after the browser-session fix |
| **Daytona** | Publish | A public sandbox per prototype. `node --check` runs on every inline script inside it. A failed check or smoke test triggers one repair. | Sandbox serving in about 20 s |
| **Arize** | Every step | One trace per pipeline (function → stage → model/tool spans). Scores are attached to their stage spans. Low scores become lessons that later prompts include. | 18 spans for a 3-stage pipeline |
| **Arize** | CI | The regression set runs with the pull request's brief prompt. Each run is logged as an experiment on `huddle-brief-regression`. The check fails if scores drop. | About 2 min per run · a weakened prompt fell to 0.83 and failed |

**A full pipeline on the live site:** a spoken request ran research (Anchor, groundedness 0.95), review
(8/10), prototype, review (9/10), and Daytona publish (build pass, Anchor smoke test pass) in **140 s**.

## Setup (about 20 minutes)

You need:
- An AWS account with Bedrock access in `us-west-2` (Claude Haiku 4.5, Claude Sonnet 5.5, Nova 2 Lite)
- An Anchor Browser API key
- A Daytona API key
- An Arize AX API key, Space ID and project
- Docker locally (optional, for a local run)

No secrets live in this repo; they go in `aws/.env`, which is git-ignored.

```bash
git clone <this repo> && cd huddle && git checkout redesign-v4

# 1. Secrets. Generates DB passwords, a JWT secret, and anon/service keys signed with it.
PUBLIC_SITE_URL=https://<your-cloudfront>.cloudfront.net node aws/gen-env.mjs
cat >> aws/.env <<'ENV'
AI_PROVIDER=bedrock
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...            # or AWS_BEARER_TOKEN_BEDROCK=... (a Bedrock API key)
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...            # only for temporary credentials
ANCHOR_API_KEY=...
DAYTONA_API_KEY=...
ARIZE_API_KEY=...
ARIZE_SPACE_ID=...
ARIZE_PROJECT=huddle
ARIZE_PROJECT_ID=...             # ax projects list
ARIZE_PROJECT_URL=...            # link the job cards open
EVAL_TOKEN=<random string>       # shared with CI; protects the eval-run function
ENV

# 2. Run it locally (http://localhost/?room=team). The DB schema applies on first start.
cd aws && docker compose -p huddle-local up -d
```

**Arize eval configs** (one-time). Scores attach to spans only if their config exists:

```bash
uv tool install arize-ax-cli && ax profiles create huddle --api-key "$ARIZE_API_KEY" --auth-method api-key
for n in review_score groundedness faithfulness smoke_test build_success completeness; do
  ax annotation-configs create continuous --name $n --space "$ARIZE_SPACE_ID" --min-score 0 --max-score 1 --optimization-direction MAXIMIZE
done
```

On macOS with python.org Python, export `SSL_CERT_FILE=/etc/ssl/cert.pem` first. If `ax` returns 404,
remove the `region` line from `~/.arize/profiles/huddle.toml`.

## Deploy to AWS (EC2 + CloudFront)

1. **EC2:** a `t3.medium` with Amazon Linux 2023, Docker and the Compose plugin, and a 30 GB disk.
   Security group: port 80 only from the CloudFront origin-facing prefix list, and port 22 from your IPs.
2. **CloudFront:** origin is the instance's public DNS name over HTTP on port 80.
   - Caching disabled; origin request policy `AllViewerExceptHostHeader`; all HTTP methods allowed.
   - Origin read timeout 60 s. WebSockets work with no extra settings, and the default
     `*.cloudfront.net` certificate gives HTTPS, which the mic needs.
3. **On the instance:**

   ```bash
   git clone --branch live https://github.com/<you>/huddle-ai-collab.git huddle
   # copy aws/.env in, with PUBLIC_SITE_URL set to the CloudFront URL
   cd huddle/aws && sudo docker compose -p huddle up -d
   ```

4. **Deploys after that are automatic.** GitHub Actions deploys every commit that passes evals:
   - It SSHes to the box with a key whose forced command is `aws/autodeploy.sh`. That key can't open a
     shell or forward ports.
   - The script pulls `live`, applies any new migrations, and restarts the app.
   - Install the key once in `~/.ssh/authorized_keys` as:
     `command="/home/ec2-user/huddle/aws/autodeploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 …`
   - Store the private key as the `DEPLOY_SSH_KEY` secret, the host key as `DEPLOY_KNOWN_HOSTS`, and the
     address as the `DEPLOY_HOST` variable.
   - The security group allows port 22 from anywhere, because GitHub's runners have no fixed IPs.
     Password login is off.

Send teammates `https://<cloudfront>/?room=<anything>`.

**Accounts without instance roles:** some accounts, including AWS workshop accounts, can't attach a new
IAM role to EC2. There, use an IAM user's Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) or session
credentials. Session credentials expire with the session.

## CI/CD for evals

`.github/workflows/evals.yml`, on every pull request to `redesign-v4` and every push to it:

1. Type-checks the server and all functions.
2. Runs `evals/run.ts`: 8 regression cases in [evals/dataset.json](evals/dataset.json).
   - Each brief is built on the live server with **this checkout's** `SYNTH_SYSTEM` prompt, from
     [prompts.ts](supabase/functions/_shared/prompts.ts).
   - Each brief is judged for faithfulness and completeness.
3. Logs the run to Arize as an experiment on the `huddle-brief-regression` dataset, so baseline and
   candidate can be compared side by side.
4. **Gate:** fails if mean faithfulness drops more than 0.05 below
   [evals/baseline.json](evals/baseline.json) (and never passes below 0.75), or completeness drops more
   than 0.1.
5. **On push only, if it passed:** moves the `live` branch to the commit and deploys it to EC2 (see
   Deploy). Only commits that passed evals reach production.
6. **Gate rules:** each case runs twice and the scores are averaged. The check also fails if any
   single case's faithfulness drops more than 0.35, which is what a bad prompt does to the "noise"
   case.

Repository settings: secrets `EVAL_TOKEN` and `ARIZE_API_KEY`; variables `HUDDLE_URL` and `ARIZE_SPACE_ID`.
To accept a new baseline, run `deno run -A evals/run.ts --update-baseline` and commit the file.

**Demo:** open a pull request that weakens the brief prompt. For example, replace "Never invent facts or
decisions nobody stated" with "Be decisive… fill gaps with assumed decisions". The check fails: the
"noise" case falls from 0.95 to 0.35 because the brief invents a goal from small talk. Revert it and the
check passes.

## Autonomous agent work

The same pipelines as [README.md](README.md#autonomous-agent-work-auto-with-gates), with these stages
on AWS:

```
research ──► review ──► prototype ──► review ──► [gate: publish?] ──► host
  │ Anchor reads top 3 sources                                       │ Daytona sandbox + node --check
  │ groundedness eval                                                │ Anchor smoke test (live view)
  └ lessons from earlier low scores in the prompt                    └ one repair if either fails
```

**The learning loop**
1. Every eval goes three places: an Arize annotation on its stage span, the `evals` table, and the job
   card's `meta.evals`.
2. Below a threshold, a short Bedrock call turns the judge's explanation into a one-line general lesson.
   - Thresholds: review 0.7, groundedness 0.7, faithfulness 0.8, smoke and build on failure.
3. The lesson is saved to `lessons` and posted to the room ("Learned from a low groundedness…").
4. The next research, prototype or brief prompt includes that stage's six most recent lessons.

**Tracing**
- **Trace per pipeline:** the trace ID comes from the pipeline ID, so stages that run in separate
  requests share one trace. The root span is sent when the pipeline finishes.
- **Everything else** gets its own trace, grouped by room in Arize sessions (`session.id`).
- Spans use OpenInference attributes, so Arize shows prompts, outputs, models and token counts.

## Goal to live link, with secrets

Every pipeline starts with a **plan** stage (Claude Haiku). It decides:
- whether the deliverable is an app or research only;
- whether to research first;
- whether a backend is needed;
- which keys the room must supply (`required_inputs`, e.g. `ELEVENLABS_API_KEY`);
- what "done" means.

The plan rewrites the pipeline's stages. A research pipeline whose answer says "build it too" gets the
build stages added.

**Secret gate:**
- **Entering a key:** builds that need keys wait at a `secret` gate. The Work panel shows masked fields
  that post to the `secrets` function, which is write-only.
- **Storage:** keys are stored encrypted in `room_secrets`. A signed-in owner can also save them to
  `user_secrets`, for every room they own.
- **Use:** they reach only the build's Daytona sandbox, as `.env`.
- **Scrubbing:** any span that contains a key's value has it replaced with `[secret]`. Keys pasted
  into the stream or board are redacted before storage.

**Builds with a backend:**
- **Output:** the app builder writes `server.js` (Node, no dependencies, reading keys from
  `process.env`), `public/index.html` and a README.
- **Check and test:** Daytona runs it. `node --check` and the Anchor smoke test decide whether it
  works. Up to two repairs use the server log and the browser's report.
- **Smoke tester:** it's told keys are configured and hidden from it, so "not configured" counts as a
  failure, while guessing a secret isn't expected.

**Full auto:** questions become recorded assumptions. Keys and the hourly job budget
(`rooms.max_jobs_per_hour`, default 20) still need the room.

## GitHub-backed rooms

1. **Sign in with GitHub** (OAuth App). The default scopes are `public_repo user:email`; `repo` is
   requested only when a room is turned private.
2. **Publish to GitHub** previews the exact files, then:
   - creates the repo from `kishorebhatia/huddle-room-template`;
   - redacts secrets (patterns, then `gitleaks` in Daytona);
   - commits only what changed, with members as co-authors;
   - logs a `secret_free` eval.
3. **Private rooms** are visible only to the owner and invited GitHub users. RLS (`room_visible`)
   guards REST; the gateway guards function calls and realtime joins.

Env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TEMPLATE`. The OAuth callback is
`<site>/auth/github/callback`.

**Next:** public rooms backed automatically by the `Huddle-public-repos` org, with no sign-in. Sign-in
becomes needed only for private (paid) rooms.

## Huddle improving Huddle (operator room)

`huddle-operator` (env `OPERATOR_ROOM`) is a private room owned by the admin (`ADMIN_LOGINS`, default
`kishorebhatia`), created on the admin's first GitHub sign-in.

Every request there becomes an `improve → review → pr` pipeline (see `_shared/operator.ts`):
1. **Evidence:** low evals, lessons and failed pipelines from the last 24 h.
2. **Change:** a minimal edit to `supabase/functions/_shared/prompts.ts`.
3. **Check:** `deno check` in a Daytona sandbox with Deno 2.1.4, the same as CI.
4. **Pull request:** a PR against `redesign-v4` (env `SELF_REPO`, `SELF_BRANCH`), opened with the
   admin's token. CI's eval gate runs on it.

Nothing merges or deploys without a human. Only `prompts.ts` changes for now.

## Using it

The same as [README.md](README.md#using-it), plus:
- **Work panel chips** under each pipeline:
  - **● Watch Anchor live** while a smoke test runs, and **Anchor screenshot** afterwards
  - **Daytona sandbox ↗**
  - Eval scores (green at 0.7 or above, red below; hover for the judge's explanation)
  - **Arize trace ↗**
- **Talk** uses the browser's own speech recognition (Chrome, Edge, Safari) when the server has no
  Gemini key, because no Bedrock model accepts audio. With `GEMINI_API_KEY` set, speech and voice notes
  go to Gemini and everything else stays on Bedrock.

## 3-minute demo

1. **AWS:** open the live link on two laptops and talk through a decision. The brief fills in from
   Bedrock.
2. **Anchor:** say "Huddle, research how hackathon judges score demos and build us a scoring sheet."
   The research shows "Checked by Anchor" with a groundedness score.
3. **Daytona:** at the publish gate, say "yes, publish it". Click **● Watch Anchor live** to watch the
   browser use the prototype on its Daytona URL. The screenshot and pass/fail result land in the stream.
4. **Arize:** open **Arize trace ↗** to see one trace with every stage, model call and tool call, and the
   scores on each stage. Point at a "Learned from a low…" line in the stream.
5. **CI/CD:** show the red check on a weakened-prompt pull request, the Arize experiment comparison, and
   the green check after the fix. Only green commits reach `live`.

## Models and measured speed (tested end to end, Oct 16)

| Step | Model or service | Time | Notes |
|---|---|---|---|
| Update the brief, intake, reviews, judges | Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) | 3–4 s | JSON through a forced tool call |
| Read an image | Claude Haiku 4.5 | ~1.2 s | |
| Prototype HTML, repairs | Claude Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`) | 30–60 s | |
| Research with web sources | Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) with `nova_grounding` | ~16 s | Citations become sources |
| Read source pages | Anchor Web Unlocker | ~2–3 s per page | Sessionless; doesn't use browser slots |
| Smoke test | Anchor `perform-web-task` in a session | ~35 s | Live view; true PNG screenshot |
| Host | Daytona sandbox, `python3 -m http.server` | ~20 s to serving | Public; stops after 2 h idle, deleted a day later |
| Speech | Browser speech recognition | live | Or Gemini, when a key is set |

Overrides: `BEDROCK_FAST_MODEL`, `BEDROCK_SMART_MODEL`, `BEDROCK_MEDIA_MODEL`, `BEDROCK_SEARCH_MODEL`,
`BEDROCK_REGION`, `HOST_MODE` (`daytona` when `DAYTONA_API_KEY` is set; also `vercel`, or the
built-in `p.html` page).

## Known limits (hackathon build)

- **Open rooms.** Anyone with a room link can read and write it.
- **Expiring credentials.** On the demo box, Bedrock uses temporary workshop credentials that expire with
  the session. Use a Bedrock API key for anything longer.
- **Voice notes and audio uploads** need a Gemini key; the Bedrock route would be Amazon Transcribe
  streaming.
- **One server.** Uploads live on the instance's disk with no backups, and stopping the instance changes
  its DNS name, which breaks the CloudFront origin. The next step is S3 plus an Elastic IP.
- **Small eval set.** The judge is an LLM and scores vary by a few hundredths between runs. Eight cases
  make a useful regression check, not proof.
- **Anchor's free plan** limits concurrent browsers. Page reads use the sessionless Web Unlocker; smoke
  tests use one short-lived session each, and if none is free the prototype still publishes, marked
  untested.
- **Arize link.** The job card's "Arize trace" opens the project page built from `ARIZE_PROJECT_URL`;
  check that link in your account.
