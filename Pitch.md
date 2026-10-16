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

## Sponsor tech

| Sponsor | What Huddle does with it | So what |
|---|---|---|
| AWS | EC2 and CloudFront host the app. Bedrock runs every model (Claude, Nova). | App, data and models live in one account. |
| Daytona | Runs each build with its keys in a sandbox-only `.env`, type-checks code, scans for secrets. | Agent code runs for real. Keys never reach the browser. |
| Anchor | Reads research sources and uses each deployed app like a new user, on a live view. | Every link passes a browser test first. |
| Arize | Traces each pipeline, scores seven evals, gates prompt changes in CI. | Changes that lower scores never ship. |
| ElevenLabs | Voice agents Huddle builds run on ElevenLabs Agents. | Teams demo real voice products the same day. |

## X-factors

- Huddle turns its own low Arize scores into pull requests and merges them when the evals pass.
- Any AI joins a room over Huddle's MCP server. Claude, Cursor or ChatGPT read the brief, start work and follow it live.
- Every public room becomes an open-source repository, with prototypes hosted on GitHub Pages.
