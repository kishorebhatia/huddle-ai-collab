# Bedrock model bake-off (Oct 19)

Every Bedrock model the workshop account could call, run on Huddle's own tasks with Huddle's own prompts.
Raw runs, outputs and judge notes: [bakeoff-results.json](bakeoff-results.json) (238 runs). Script:
[bakeoff.ts](bakeoff.ts). Judge for the brief task: Claude Sonnet 4.6.

| Task | What is scored | Best | Huddle today (Claude Haiku 4.5) |
|---|---|---|---|
| Brief update (8 conversations) | 0.7 × faithfulness + 0.3 × completeness, judged | GPT-5.5 0.99 in 2.0 s | 0.98 in 3.2 s |
| Plan (8 labeled goals) | deliverable, backend and keys match the label | GPT-5.5, Claude Sonnet 5 / 5.5, Opus 5.5: 1.00 | 0.96 in 2.8 s |
| Review (3 good, 3 flawed artifacts) | pass or revise matches the label | Nova Pro, Nova 2 Lite, GPT-5.5, Haiku 4.5: 0.83 | 0.83 in 5.0 s |
| App build (4 specs) | files present, `node --check`, no npm deps, no key in code | every model 1.00 | 1.00 in 16.6 s |

## Full tables

**Brief update**

| Model | Score | Median s | Output tokens |
|---|---|---|---|
| GPT-5.5 | 0.99 | 2.0 | 184 |
| GPT-6 Sol | 0.98 | 2.9 | 257 |
| Claude Haiku 4.5 | 0.98 | 3.2 | 338 |
| Claude Sonnet 5.5 | 0.98 | 3.7 | 509 |
| Claude Sonnet 4.6 | 0.96 | 3.5 | 389 |
| Claude Opus 5.5 | 0.96 | 5.7 | 524 |
| Nova 2 Lite | 0.94 | 1.7 | 290 |
| Claude Sonnet 5 | 0.94 | 4.6 | 429 |
| Nova Pro | 0.92 | 1.9 | 189 |

**Plan**

| Model | Score | Median s |
|---|---|---|
| GPT-5.5 | 1.00 | 2.3 |
| Claude Sonnet 5.5 | 1.00 | 3.7 |
| Claude Sonnet 5 | 1.00 | 5.2 |
| Claude Opus 5.5 | 1.00 | 6.2 |
| Claude Haiku 4.5 | 0.96 | 2.8 |
| Nova Pro | 0.96 | 1.4 |
| Claude Sonnet 4.6 | 0.92 | 3.3 |
| Nova 2 Lite | 0.92 | 1.3 |
| GPT-6 Sol | 0.92 | 2.5 |

**Review**

| Model | Score | Median s |
|---|---|---|
| Nova Pro | 0.83 | 1.4 |
| Nova 2 Lite | 0.83 | 2.1 |
| GPT-5.5 | 0.83 | 3.8 |
| Claude Haiku 4.5 | 0.83 | 5.0 |
| GPT-6 Sol | 0.67 | 2.8 |
| Claude Sonnet 5.5 | 0.67 | 8.5 |
| Claude Sonnet 4.6 | 0.67 | 9.0 |
| Claude Sonnet 5 | 0.67 | 10.0 |
| Claude Opus 5.5 | 0.67 | 11.1 |

**App build**

| Model | Score | Median s | Output tokens |
|---|---|---|---|
| Llama 4 Maverick | 1.00 | 4.0 | 1,062 |
| Nova Pro | 1.00 | 6.1 | 1,299 |
| Claude Haiku 4.5 | 1.00 | 16.6 | 3,465 |
| Nova 2 Lite | 1.00 | 17.4 | 3,124 |
| GPT-6 Sol | 1.00 | 20.7 | 3,313 |
| Claude Sonnet 4.6 | 1.00 | 24.7 | 4,240 |
| Claude Sonnet 5.5 | 1.00 | 28.9 | 5,284 |
| GPT-5.5 | 1.00 | 29.4 | 3,757 |
| Claude Opus 5.5 | 1.00 | 35.6 | 4,445 |
| Claude Sonnet 5 | 1.00 | 45.0 | 5,780 |

## Findings

1. **Huddle's review prompt rejects good work.** Every review mistake by every model was a false rejection. All 9
   models sent the good research back and 6 sent the good prototype back; none passed a flawed artifact. The
   simulated-team runs show what that costs: in 2 of 3 research runs the forced revision scored lower than the
   first version (groundedness 0.60 → 0.40, 0.92 → 0.75) and replaced it.
   **Recommendation.** Relax REVIEW_SYSTEM's bar for "revise", and keep the better-scoring version after a revision.
2. **Bigger is slower here without being better.** Claude Sonnet and Opus models took 2–3 times longer than Haiku 4.5
   on brief, plan and review, and scored the same or lower.
3. **GPT-5.5 on Bedrock led on brief and plan and was fastest there.** Haiku 4.5 sits within 0.04 on both.
   **Recommendation.** Keep Haiku 4.5 as the default. Switching brief and plan to GPT-5.5 is worth a CI experiment.
4. **The build task's static checks don't separate models.** Every model passes. Llama 4 and Nova Pro wrote about a
   third as much code. Telling builds apart needs the runtime test (deploy, then an Anchor smoke test).
5. **Model access on this account.** Claude Haiku 5.5 is blocked by marketplace eligibility, Palmyra X5 is denied,
   Nova Premier is retired, and Claude Fable 5.1 hits a data-retention restriction. Llama 4, Mistral Pixtral and
   DeepSeek R1 can't do forced tool calls. Claude Sonnet 5.5 and Opus 5.5 reject a forced tool choice but answer
   when offered the tool; Huddle's adapter now handles that.

Scores are from small labeled sets (6–8 cases per task). They rank models on Huddle's tasks; they don't prove
general quality.
