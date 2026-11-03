# Entire agents

Project Agents that review this repository on its Trails. Entire stores Agents in the project, not in the repository, so each file here is the request body used to create or update one Agent.

## Command model review

`command-model-review.json` flags code that changes the board outside a validated command, skips a command's origin, or lets agent work into the user's protected work.

The Agent exists in project `gh/bamiboy237` with ID `01M6HJXSAD0SEWPVW4XPJCJK63`. It runs on `easel` in the Repository sandbox environment. To change it, edit the JSON, read the current etag, and replace the Agent's configuration. The [Agents guide](https://docs.entire.com/guides/trails/agents) explains each step.

```bash
P=gh/bamiboy237 A=01M6HJXSAD0SEWPVW4XPJCJK63
```

```bash
ETAG=$(entire api --to cell "/api/v1/$P/agents/$A" | jq -r '.etag')
```

```bash
entire api --to cell -X PUT "/api/v1/$P/agents/$A" -H "If-Match: $ETAG" --input .entire/agents/command-model-review.json
```

To check it, push one test change for each rule on a branch with a Trail, and confirm that the Agent reports a finding for each:

1. Rule 1: in `client/agent/managers/AgentFrameFillManager.ts`, call `editor.reparentShapes` directly instead of inside `commands.execute`.
2. Rule 2: in `client/agent/managers/AgentActionManager.ts`, pass `'user'` instead of `'agent'` as the origin of `commands.execute`.
3. Rule 3: in `client/agent/getRequestedShapeIds.ts`, drop the `item.source !== 'user'` check, so the agent's own context items unlock protected shapes.
