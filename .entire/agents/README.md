# Entire agents

Project Agents that review this repository on its Trails. Entire stores Agents in the project, not in the repository, so each file here is the request body used to create or update one Agent.

## Command model review

`command-model-review.json` flags code that changes the board outside a validated command, skips a command's origin, or lets agent work into the user's protected work.

To create it, set the project path and fill in the three placeholders: the repository ID, the environment ID, and a model from the project's model list. The [Agents guide](https://docs.entire.com/guides/trails/agents) shows how to look each one up.

```bash
P=gh/bamiboy237
```

```bash
entire api --to cell -X POST "/api/v1/$P/agents" -H "Idempotency-Key: $(uuidgen)" --input .entire/agents/command-model-review.json
```

To check it, push one test change for each rule on a branch with a Trail, and confirm that the Agent reports a finding for each:

1. Rule 1: in `client/agent/managers/AgentFrameFillManager.ts`, call `editor.reparentShapes` directly instead of inside `commands.execute`.
2. Rule 2: in `client/agent/managers/AgentActionManager.ts`, pass `'user'` instead of `'agent'` as the origin of `commands.execute`.
3. Rule 3: in `client/agent/getRequestedShapeIds.ts`, drop the `item.source !== 'user'` check, so the agent's own context items unlock protected shapes.
