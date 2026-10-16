# Huddle on AWS, Daytona, Arize and Anchor

**Live:** https://d2k5rbdeilbp1b.cloudfront.net/?room=demo

## Executive summary

Huddle is a shared, listening workspace for small teams. Teammates talk, type, paste or sketch, and
Huddle keeps one living brief. When someone asks for something ("Huddle, research X and build us Y"),
Huddle runs it as a pipeline of agent stages. Each of the four platforms owns a part of that loop:

| Platform | What it does in Huddle | Value it adds | Status (Oct 16) |
|---|---|---|---|
| **AWS** | Runs the whole app. EC2 hosts the database, the API and the agent functions; CloudFront serves it over HTTPS. Bedrock runs the AI: Claude Haiku 4.5 for briefs and reviews, Claude Sonnet 5.5 for prototypes, and Nova 2 Lite for web-grounded research and video. | One account for the app, its data and its models. No Supabase and no Gemini key required. | **Live, tested end to end** |
| **Anchor Browser** | A cloud browser for the agent. Research opens and reads the top source pages. After a deploy, it opens the prototype's public URL and uses it like a person would. | Research cites pages the agent actually read. Prototypes are tested by using them, not by reading their code. The room can watch the browser work live. | Planned |
| **Daytona** | A sandbox where agent-built prototypes are installed, started and given a public URL. If a build fails, its log goes back to the model for one repair. | The agent ships running apps with real links, not mockups, and it fixes its own failed builds. | Planned |
| **Arize** | Traces every pipeline, stage and model call, and scores outputs with evals. Low scores become lessons the agent reuses and test cases for CI. | You can see why the agent did what it did. Quality is measured on every run, and a prompt change can't ship if it lowers the scores. | Planned |

**The loop in one line:** Anchor gathers evidence → Bedrock writes → Daytona runs it → Anchor tests it
→ Arize scores it → lessons and regression tests feed the next run.

## What runs today on AWS

```
browser ──HTTPS──► CloudFront ──► EC2 (t3.medium, Docker Compose)
                                    ├─ Postgres 16 (our own database)
                                    ├─ PostgREST (data API)
                                    └─ Deno gateway: 10 agent functions, realtime, file storage,
                                       once-a-minute pipeline sweep
                                            │
                                            └─► Amazon Bedrock
```

| Job | Model on Bedrock |
|---|---|
| Brief, request intake, reviews (structured JSON) | Claude Haiku 4.5 |
| Reading images | Claude Haiku 4.5 |
| Prototype HTML | Claude Sonnet 5.5 |
| Web research with sources | Nova 2 Lite with `nova_grounding` |
| Video and PDF | Nova 2 Lite / Claude |
| Live speech | The browser's own speech recognition, since no Bedrock model accepts audio |

**Measured run on the live site.** One spoken request went through every stage in about four minutes:

1. Research returned five web sources.
2. A review scored the research.
3. The agent asked the room two clarifying questions.
4. It built a prototype and reviewed it.
5. Once publishing was approved, the prototype went live at
   https://d2k5rbdeilbp1b.cloudfront.net/p.html?id=7.

Updating the brief takes about 3.5 seconds and reading an image about 1.2 seconds.

## The planned pipeline

```
spoken request
  → research    Anchor reads the top sources in a cloud browser
  → review      Arize eval: is every claim backed by a page that was read?
  → build       Daytona installs and starts the project; one repair if it fails
  → smoke test  Anchor opens the public URL and uses the feature that was asked for
  → review      Arize eval: did the smoke test pass?
  → publish     Daytona public preview URL
Every step is traced to Arize. Low scores become lessons and regression tests.
```

### Anchor Browser
- **Research:** Bedrock's web grounding finds sources quickly. Anchor then opens two or three of them,
  pulls out the facts and takes screenshots, so the brief cites what the agent actually read.
- **Smoke test:** after a deploy, Anchor opens the Daytona URL and does the task the prototype was built
  for, such as "add an item, then filter". The result, a screenshot and any console errors go to the
  review stage.
- **Live view:** each browser session has a live-view link, shown on the job card.

### Daytona
- **Build:** the agent writes a small multi-file project and a start command. Daytona creates a
  sandbox, uploads the files, installs and starts the app, and returns a public preview URL. That URL
  becomes the link Huddle shares.
- **Repair:** a failed install or start sends its log back to the model for one fix and retry.
- **Demo settings:** a longer auto-stop time so links stay up during judging, and public previews.

### Arize
- **Tracing:** each pipeline is one trace. Every stage and function is a span, and every Bedrock call is
  an LLM span with its prompt, output, model, tokens and latency. Job cards link to their trace.
- **Evals:**
  - Brief faithfulness: does the brief match what was said?
  - Research groundedness: is every claim backed by a page that was read?
  - Prototype pass rate: the Anchor smoke-test result.
  - The agent's existing 1–10 review score.
- **Learning from evals:** a low score becomes a one-line lesson that is added to that stage's prompt on
  later runs. The failing input joins a regression dataset. This is lesson memory and a growing test
  set, not automatic prompt optimization.
- **Lean CI/CD:** prompts live in the repo. On each pull request, a GitHub Action runs the regression
  set against the changed prompts, logs the run as an Arize experiment, and fails if scores drop below
  the `main` baseline. Merging deploys to EC2.

## Demo for judges (about 5 minutes)

1. **AWS:** open the live link on two laptops and talk. The brief fills in from Bedrock as people speak.
2. **Anchor:** say "Huddle, research X and build us Y". The job card shows Anchor's live browser
   reading the sources.
3. **Daytona:** watch the build log, then open the public URL Daytona returns.
4. **Anchor again:** the smoke-test screenshot and its pass/fail result appear in the review.
5. **Arize:** open the pipeline's trace to see every stage, model call and eval score, then show the
   lesson the last low score produced.
6. **CI/CD:** a pull request that weakens a prompt fails its eval check, and Arize shows which examples
   got worse. The fix passes and deploys.

## Known gaps

- **Credentials expire.** Bedrock uses this workshop session's temporary credentials. An IAM user with a
  Bedrock API key would make it permanent.
- **Voice notes and audio uploads** need a Gemini key or Amazon Transcribe streaming.
- **Open rooms.** Anyone with a room link can read and write it.
- **One server.** Uploads live on the instance's disk and there are no backups. Stopping the instance
  changes its address. S3 plus an Elastic IP is the next step.
