# What we learned running Huddle on AWS (Oct 16–19)

Field notes from the hackathon deployment, for whoever deploys this next.
- How to deploy: [README.md](README.md).
- Model numbers: [evals/BAKEOFF.md](../evals/BAKEOFF.md).

## Results

- **Model bake-off.** 238 runs across 10 Bedrock models on Huddle's own tasks, logged to Arize as 4 datasets and 37 experiments.
  - Claude Haiku 4.5 stays the default for brief, plan and review. It is within 0.04 of the best (GPT-5.5) and 2–3× faster than Sonnet and Opus, which scored no better.
  - Every model's review mistakes were false rejections, so we fixed the review prompt (below).
- **Simulated teams.** 12 of 12 scenarios finished end to end on the live site: 4 research, 6 static apps and 2 ElevenLabs voice apps with a backend.
  - All 8 builds passed their Anchor smoke test on the first try.
  - The runs used 3 sandboxes at a time, and each one was stopped when its run ended.
- **Review fix.** "Pass" is now the default for usable work, and a revision that reviews lower is dropped in favor of the earlier version.
  - Bake-off re-run: Nova Pro 0.83 → 1.00, Sonnet 5.5 0.67 → 1.00.
  - Live: the keep-earlier rule fired correctly (pricing research 4/10 kept over its 3/10 revision; EU AI Act 5/10 over 4/10).
- **CI gates** run on every push:
  - Brief: faithfulness 0.92, completeness 0.91 on 8 cases.
  - Plan: 1.00 on 8 goals.
  - Review: 0 mistakes on 14 artifacts.
  - Checked: a lenient review prompt fails the gate.
- **Datasets distilled** into `evals/datasets/`: 11 research runs labeled good, bad or unclear; 8 builds; 15 plans.

## Platform gotchas

**AWS / Bedrock**
- **Workshop credentials expire, and so does everything that uses them.** Session credentials in `.env` died twice. Each time, CI's eval gate failed first because it calls the live server.
  - For anything that outlives the event, use a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) or IAM user keys.
  - Workshop accounts also can't attach a new IAM role to EC2.
- **Don't import the AWS SDK at runtime in Deno.** It wouldn't load from npm inside the container. SigV4 over `fetch` in [bedrock.ts](../supabase/functions/_shared/bedrock.ts) is about 60 lines and has no dependencies.
- **Not every model takes a forced tool choice.**
  - Sonnet 5.5 and Opus 5.5 reject it but answer when offered the tool with `auto`.
  - Llama 4, Pixtral and DeepSeek R1 can't do it at all.
  - Some models were blocked by account rules: Haiku 5.5 (marketplace eligibility), Fable 5.1 (data retention), Palmyra X5 (denied).
- **Nova grounding returns its own `toolUse` blocks.** Accept only your `respond` tool's output, and strip `<thinking>`. Otherwise research comes back as `{"query": …}`.
- **Per-model output caps.** Nova Pro and Llama 4 hit their max-token limits on builds, so set `maxTokens` per model.
- **Stopping an EC2 instance changes its public DNS name**, which breaks the CloudFront origin. `provision.sh` now attaches an Elastic IP.
- **CloudFront for a Supabase-style API**:
  - caching disabled;
  - `AllViewerExceptHostHeader`;
  - all methods;
  - a 60 s origin timeout.
  WebSockets need no extra settings. Lock port 80 to the `com.amazonaws.global.cloudfront.origin-facing` prefix list.
- **SSH has to stay open to the world for GitHub-hosted runners.** The deploy key's forced command (`autodeploy.sh`) is what keeps that safe. Password login is off.

**Replacing Supabase with Postgres + PostgREST + a Deno gateway**
- `docker-entrypoint-initdb.d` scripts must be executable (`00_roles.sh`).
- Storage uploads arrived as multipart with a `text/plain` label. Parse the body yourself, decoding as latin1 to keep the bytes.
- Realtime runs on LISTEN/NOTIFY. NOTIFY payloads cap at 8 KB, so send only the table and key, and let the gateway read the row.
- RLS: `room_visible` let anonymous users through on a NULL owner check. Use `coalesce(…, false)`.
- A job marked "running" when the server restarts never finishes. On start, the server now marks those jobs as failed.

**Arize**
- **OTLP JSON wants trace and span IDs as base64 of the hex bytes.** Otherwise spans import but annotations never match them.
- Scores attach only if their annotation config exists in the space.
- Revoked keys return 401. The key is used in three places: the server's `.env`, the local env and the GitHub secret.

**Daytona**
- **The account has a total disk cap.** Creates start failing once the cap is reached. Huddle now archives its oldest prototype sandbox (never deletes) and retries.
- Idle auto-stop at 15 minutes keeps credits low. A visit restarts the sandbox, and stopped sandboxes keep their files.
- Repairs must not overwrite the sandbox's `.env`; it is written only on the first deploy.
- Role sandboxes (`operator`, `secret-scan`) are found and restarted, not re-created, so stopping them never leaks new ones.

**Anchor**
- **Opening a browser session per page read hit the free plan's 429 quota.** Use the sessionless Web Unlocker (`/v1/tools/fetch/webpage`) for reads. Keep sessions for smoke tests, and close each one.
- Smoke tests tried to "find" API keys in the page. The prompt now says keys are configured server-side and hidden.

**GitHub**
- A user's OAuth token can be revoked, and then every operator PR fails with 401 "Bad credentials". The admin has to sign in again.
- Test rooms (`test-…`) are never auto-published to the public org, so simulated runs don't create repos.

## Pipeline behavior

- **Forced revisions often made research worse.** In 2 of 3 runs, the revised version was less grounded (0.60 → 0.40, 0.92 → 0.75). The fix is to pass usable work and keep the better version. On a tie, the better-grounded version wins.
- **Pricing research stays weakly grounded (0.35–0.75)** with Nova grounding. Vendor pricing pages are dynamic. Better page reads (Anchor) are the next lever.
- **The lesson feedback loop can feed itself.** Lessons were judged as part of the brief and wrote 33 junk lessons. Now only human events are judged, lesson events are filtered out of the brief's input, and lessons are capped at 1 per stage per 10 minutes.
- **The operator room needs guardrails before it can merge.** An early auto-merged PR (3/10, unrequested) led to:
  - a triage stage;
  - review ≥ 7, CI green, no sensitive files and no manual steps;
  - checking the deploy and the live site;
  - reverting only its own merge.
  Its own redeploy killed the ship stage mid-run, so it now resumes from the merged SHA.
- **Code from members' AIs must not run where room secrets live.** Member AIs aren't given prototype stages that need keys. Keyless MCP sessions can't claim tasks.

## Credits and cost hygiene

- The simulated runs used at most 3 sandboxes at once, stopped each one right after its run, and never deleted any.
- Bake-off build checks ran static checks only (no sandbox). Runtime builds went through the simulated teams.
- CI's evals cost about 50 small Bedrock calls per push: brief 8×2, plan 8×2, review 14×2.

## Before the next event

- [ ] Bedrock API key, or a decision on another model provider (see README.md, "Change provider or host").
- [ ] Where Huddle lives after the workshop account closes. Restore from the latest backup there.
- [ ] Rotate every key that was pasted into chat during the event: Arize, Daytona, Anchor, ElevenLabs, the GitHub org token and the OAuth secret.
- [ ] S3 for uploads and an Elastic IP (already in `provision.sh`).
