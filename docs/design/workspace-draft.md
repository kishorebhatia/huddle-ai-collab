# Shared workspace UI draft

Each room is an independent workspace where people and agents collaborate. Its table, conversation, Brain, jobs and outputs use the existing room identifier. Agents retain the existing autonomy settings and approval gates.

This draft adds a mixed-media shared table, room navigation, persistent group conversation, and file inputs while retaining existing listening, whiteboard, synthesis, agent pipelines, output feedback and Connect your AI controls.

## Validation and remaining work

Five automated checks pass with `node --test tests/studio.test.mjs`. Browser smoke checks used a placeholder configuration; live backend synchronization, storage and agent execution still require staging validation. Uploaded audio/video can be shared and played; automatic understanding of these uploads and camera capture are not implemented.

Conversation and capture occupy the left column, shared work occupies the center, and agent execution occupies the right. Workspace navigation slides in from the left. Existing mic controls live beside chat input; autonomy and Stop all live beside jobs. Conversation contributions can prefill an agent request without executing it. The separate local prototype now isolates job approvals and autonomy by workspace. Independent visual review scored 7.3/10; the design quality gate remains unfinished. This is a draft, not a deployment-ready release.
