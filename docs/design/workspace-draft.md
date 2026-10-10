# Shared workspace UI draft

Each room is an independent workspace where people and agents collaborate. Its table, conversation, Brain, jobs and outputs use the existing room identifier. Agents retain the existing autonomy settings and approval gates.

This draft adds a mixed-media shared table, room navigation, persistent group conversation, and file inputs while retaining existing listening, whiteboard, synthesis, agent pipelines, output feedback and Connect your AI controls.

## Validation and remaining work

Five automated checks pass with `node --test tests/studio.test.mjs`. Browser smoke checks used a placeholder configuration; live backend synchronization, storage and agent execution still require staging validation. Uploaded audio/video can be shared and played; automatic understanding of these uploads and camera capture are not implemented.

The next design revision should make Agent work prominently visible within every workspace. The separate local visual prototype still needs fully independent sample Brain and job state for each room. Independent visual review scored 7.3/10; the design quality gate remains unfinished. This is a draft, not a deployment-ready release.
