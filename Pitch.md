# Huddle

**Live:** https://d2k5rbdeilbp1b.cloudfront.net/?room=demo · **Repo:** https://github.com/kishorebhatia/huddle-ai-collab

Huddle listens to a team talk and ships what they ask for. A spoken goal becomes a tested app with a public link. Huddle improves its own code through the same loop.

## Problem

Small teams lose hours between "we should build X" and a working link, and nobody checks whether the AI's output works.

## Measured on the live site today

- A teammate's AI posted one request. Huddle built a patient-intake voice agent on ElevenLabs, repaired an ElevenLabs config error that Anchor's test caught, booked a synthetic patient into a mock EHR, and pushed the code to GitHub.
- A goal needing an API key went live as a full-stack app in 80 seconds. The key appeared zero times in the page, database and logs.
- Huddle shipped a feature to itself. It edited its prompt, type-checked the repo, opened PR #2, passed CI's evals, merged and deployed. No person touched the code.
- CI's eval gate blocked a weakened prompt. The fix raised brief faithfulness from 0.88 to 0.92.
- 12 simulated teams went from a conversation to a result on the live site: 4 research, 6 apps, 2 ElevenLabs voice apps. 12 of 12 finished; all 8 builds passed Anchor's browser test on the first try.
- A bake-off of 10 Bedrock models on Huddle's own tasks (238 runs, logged to Arize) found the reviewer was rejecting good work. After the fix, review accuracy rose to 1.00 for Nova Pro and Sonnet 5.5. CI now gates the plan and review prompts as well as the brief.
- Teammates' own AIs can take tasks from a room over MCP. Code from those AIs never runs where the room's keys live.

## Sponsor tech

| Sponsor | What Huddle does with it | So what |
|---|---|---|
| AWS | EC2 and CloudFront host the app. Bedrock runs every model (Claude, Nova). | App, data and models live in one account. |
| Daytona | Runs each build with its keys in a sandbox-only `.env`, type-checks code, scans for secrets. | Agent code runs for real. Keys never reach the browser. |
| Anchor | Reads research sources and uses each deployed app like a new user, on a live view. | Each app gets a browser test before the room sees its link. |
| Arize | Traces each pipeline, scores seven evals, gates prompt changes in CI. | A prompt change that lowers the brief's eval scores can't merge. |
| ElevenLabs | Voice agents Huddle builds run on ElevenLabs Agents. | Teams demo real voice products the same day. |

## X-factors

- Huddle turns its own low Arize scores into pull requests and merges them when the evals pass.
- Any AI joins a room over Huddle's MCP server. Claude, Cursor or ChatGPT read the brief, start work and follow it live.
- Every public room becomes an open-source repository, with prototypes hosted on GitHub Pages.
