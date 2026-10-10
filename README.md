# Huddle — a shared, listening workspace for small teams

**Live:** https://huddle-nu-gules.vercel.app

One link. Everyone talks into their own laptop, types notes, pastes screenshots or sketches on a
shared whiteboard. Gemini transcribes and reads the images, folds everything into one living brief
(goal, decisions, open questions, ideas, next steps), proposes research and prototype jobs, runs
them, and shows the outputs in place. Feedback on an output makes the agent revise it.

```
browser (each teammate)                     Supabase                               Gemini
──────────────────────                      ────────                               ──────
mic → on-device voice detect → WAV  ──►  fn transcribe ──► events  ◄── Realtime ──  gemini-3.8-flash (audio)
paste / photo / whiteboard PNG     ──►  Storage + fn see ──► events                gemini-3.8-flash (vision)
notes, links                       ──►  events (direct insert)
leader browser every 45 s          ──►  fn synthesize ──► brain + proposed jobs    structured JSON
"Run" on a job                     ──►  fn run-job ──► jobs (running → done)       Google Search grounding / HTML generation
your own Claude / Gemini           ──►  fn brain-api  (GET brief as markdown, POST findings)
whiteboard strokes + presence      ◄──►  Realtime broadcast / presence
```

## Setup (about 10 minutes)

You need a Supabase project (free tier is fine), a Gemini API key from https://aistudio.google.com/apikey,
and Node 18+. No secrets live in this repo: the browser config is generated from env vars at build time.

```bash
git clone <this repo> && cd huddle
cp .env.example .env                    # SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY (Project Settings → API)
cp supabase/.env.example supabase/.env  # GEMINI_API_KEY

# Backend: tables + realtime + storage bucket, the Gemini secret, and the five Edge Functions
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push                     # edit YOUR-PROJECT-REF in the sweep_cron migration first
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy --use-api   # config.toml turns off JWT checks for the hackathon

# Frontend: generate web/config.js from .env, then run locally (mic works on localhost)
node scripts/write-config.mjs
npx serve web                            # → http://localhost:3000/?room=team
```

**Deploy to Vercel** (HTTPS is required for the mic on other devices). `vercel.json` runs
`scripts/write-config.mjs` and serves only `web/`, so set the two values as project env vars:

```bash
npx vercel link
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_PUBLISHABLE_KEY production
npx vercel deploy --prod
```

Send teammates `https://<your-deploy>/?room=<anything>`. A new room is created automatically when there is no `?room=`.

**What is git-ignored:** `.env`, `supabase/.env`, `web/config.js` (generated), `.vercel/`, `supabase/.temp/`.
The publishable key is designed to be public (it ships to every browser); access is governed by RLS.

## Autonomous agent work (Auto with gates)

Say it, and it happens: **"Huddle, research X and build us Y."** The `intake` function spots requests
in speech and typed notes and starts a **pipeline** immediately; the brief update also starts pipelines
for clear next steps. Each pipeline runs on its own:

```
research ──► review ──► prototype ──► review ──► [gate: publish?] ──► host (public share link)
              │ revise once if weak        │ revise once
              └─ may ask the room a question (answer by voice or button)
```

- **Context pack:** every stage gets the brief, the last 40 lines of conversation, and earlier stage outputs.
- **Review:** a separate Gemini pass scores the work 1–10 against the goal; one automatic revision if needed.
- **Gates:** publishing, questions only the humans can answer, and the hourly budget. Answer out loud
  ("yes, publish it", "target hackathon teams") — the brief update matches answers to waiting gates.
- **Modes (top bar):** *Suggest only* (propose, you press Start) · *Auto with gates* (default) · *Full auto*.
  **Stop all** pauses every pipeline in the room.
- **Hosting:** published prototypes get a public page at `<your site>/p.html?id=<job>` (sandboxed).
  Set `HOST_MODE=vercel` + `VERCEL_TOKEN`/`VERCEL_TEAM_ID` to deploy each prototype as its own Vercel
  project instead (new Vercel projects may have Deployment Protection on; turn it off yourself if you want them public).
- **Orchestration:** `run-job` hands back to `orchestrate` when a stage ends; a pg_cron job calls
  `orchestrate {sweep:true}` every minute to restart anything stalled.

Measured on the live project: spoken request → research (16 s) → review → prototype (~40 s) → review →
publish gate ≈ 80 s; publishing after approval ≈ 3 s.

## Using it

- **Mic**: "Auto" sends a clip whenever you stop talking (~1 s pause). In a noisy room use
  **Push-to-talk** (hold Space) or headsets. The transcribe function drops near-duplicate lines picked
  up by other laptops within 25 s.
- **Images**: paste a screenshot anywhere, attach a photo (phones open the camera), or draw on
  **Board** — strokes show live for everyone — then "Send to brain".
- **Brain**: one browser re-synthesizes every 45 s when there is something new; "Synthesize now"
  forces it. `#123` chips jump to the source line in the feed.
- **Agent work**: proposed jobs are dashed — Run or Dismiss. Ask directly in the input. Research uses
  Google Search grounding with sources; prototypes are single-file HTML shown in a sandboxed frame.
  Open → give feedback → Revise creates v2 from v1.
- **Connect your AI**: each teammate's own Claude/Gemini can `curl` the brief and POST findings back
  (button in the top bar shows the exact commands).

## Split for three people once it runs

| Person | Owns | First upgrade |
|---|---|---|
| A | Deploy, mic + transcription | Stream live captions with `gemini-3.5-transcribe-live` over the Live API (ephemeral token from an edge function) |
| B | Synthesis prompt + job runner | Long research via the Deep Research agent; publish prototypes to a public URL in Storage |
| C | Board, UX, demo story | Swap the canvas for tldraw; Supabase "MCP server for your app" so Claude connects natively |

## 3-minute demo

1. Open the link on three laptops and a phone. "We kept losing each other's work today, so we built this."
2. Talk through a real decision for 30 s. Lines appear tagged by speaker; the Brain fills in with a
   decision, an open question and next steps.
3. Sketch the architecture on Board, send it — the brief now mentions the components.
4. A proposed research job appears; hit Run. Meanwhile ask for a prototype by typing.
5. Open the prototype, say "make it dark and add a filter", Revise → v2.
6. From a terminal, a teammate's Claude POSTs a finding; it lands in the feed and the next brief.

## Models and measured speed (tested end to end, Oct 10)

| Step | Model | Time | Notes |
|---|---|---|---|
| Transcribe an utterance | `gemini-3.5-transcribe` (fallback `gemini-3.5-flash-lite`) | 0.8–1.5 s | Silence skipped before any call; noise returns nothing; fix-ups for "Superbase" etc. in `VOCAB` |
| Read a sketch / photo | `gemini-3.8-flash`, thinking low | ~3–5 s | Copies text exactly (no "correcting" version numbers) |
| Update the brief | `gemini-3.8-flash`, thinking low | 5–7 s | Edits in place; dismisses proposed jobs that decisions made stale |
| Research job | `gemini-3.8-flash` + Google Search | ~20 s | Always searches; 6–10 sources; flags a brief that came back unsourced |
| Prototype job | `gemini-3.8-flash`, thinking low | ~45 s | Capped at ~400 lines to stay inside the Edge Function time limit |

Env overrides: `GEMINI_MODEL`, `GEMINI_SMART_MODEL`, `TRANSCRIBE_MODEL`, `TRANSCRIBE_FALLBACK_MODEL`,
`SYNTH_THINKING`, `PROTOTYPE_THINKING`.

## Known limits (hackathon build)

- Anyone with the link can read and write a room (open RLS, functions without JWT). Add Supabase
  Auth + room membership before real use.
- Edge Functions have a wall-clock limit (150 s on free); very large prototypes may time out — retry or
  ask for a smaller scope.
- Transcription is per-utterance (1–3 s behind), not word-by-word streaming.
