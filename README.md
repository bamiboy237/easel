# Easel

Easel is a shared multimodal canvas where people and agents explore, create, and revise ideas together. Text, voice, ink, and comments all change the same board state.

The project bet is that people prefer this way of working with agents over chat.

## Status

Easel is in Phase 0, the rough loop. The app is the tldraw agent starter at tldraw 5.6.0, with Muse Wonder as the default model.

Phase 0 builds a rough version from the tldraw agent starter. Its gate is to run both test sessions and decide whether working this way beats chat. The test sessions are exploring a physics concept and developing a project mockup.

## Run the app

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Set `MODEL_API_KEY` to your key from the [Meta Model API dashboard](https://dev.meta.ai/).
3. Install the dependencies and start the app:

	```bash
	npm install
	npm run dev
	```

4. Open `http://127.0.0.1:5173/`.

To use your ChatGPT Plus or Pro plan instead of an API key, run `npm run chatgpt` in a second terminal. Approve the sign-in in your browser, then pick `gpt-6.1-sol` in the chat panel. Review or limit usage in [ChatGPT Settings](https://chatgpt.com/settings/usage). The helper stores tokens in `~/.config/easel/`.

If the worker cannot reach `api.meta.ai` directly, for example in a container without DNS, set `MODEL_API_BASE_URL` in `.dev.vars` to a relay that forwards to it. Leave it unset to call the Meta Model API directly.

The development server listens only on your Mac. AI requests must come from the same local Easel page. Tablet connections are planned for Phase 14.

## Inspect board commands

Open the browser console and run `agentApp.commands.getHistory()`.

Each entry contains a command ID, an origin (`user`, `agent`, or `voice`), a type, a status (`applied` or `rejected`), the document changes, and a timestamp. Direct edits appear after the editor transaction. Agent instructions are validated before they run. Preview updates do not add commands.

Each applied command gets the next board revision in `rev`. Run `agentApp.commands.getRev()` to read the current revision. Each agent request records the revision it read the board at, and every command from that request carries it as `baseRev`. If a user or voice command changed one of the command's records after `baseRev`, the agent command is stale: nothing from it applies, the log records it as `rejected` with the changed records in `staleRecordIds`, and the agent's next pass is told which shapes changed. Agent creates on new IDs are never stale.

The user's own work is protected from the agent. Each new shape records its creator in `meta.createdBy` (`user`, `agent`, or `voice`), so ownership is saved with the board. A shape is protected when the user created it, or when it sits inside a frame the user drew: a frame the user draws is their region. An agent command that changes, moves, or deletes a protected shape, or that places a shape over one, is rejected: nothing from it applies, the log records it with `reason: 'protected'` and the user's shapes in `protectedRecordIds`, and the agent's next pass is told to put its work elsewhere. The agent can still change the user's work when the request asks for it: when the user selects those shapes, adds them as context, or names them by ID or, for a frame, by its title. When the agent bumps into protected work, the board outlines it faintly for a moment. Rejection notices start at most three follow-up passes per request.

Stale rejections have `reason: 'stale'`.

Cancel and revert are separate. Cancel stops future agent work: the current stream, queued frame fills, and scheduled passes. It leaves finished work on the board and only removes the preview of an action that was still streaming, which was never a command. Revert undoes finished agent work and keeps newer human work. The chat's Undo button reverts that row's pass, and Restore brings it back. From the console, `agent.revert({ passId })` or `agent.revert({ requestId })` reverts one pass or a whole request. Each agent command carries its `passId` and `requestId`.

A revert is one command with origin `user` and type `revert`, built from the command log. For each record the agent's commands touched, it restores the earlier version, except for properties that a later command changed. A shape the agent created stays when the user has since edited it or bound their own shape to it, and the user's shapes inside a deleted agent frame stay where they are on the page. The log lists the undone commands in `revertedCommandIds` and the records it left alone in `keptRecordIds`, and the chat row says how many shapes were kept. Restore is a revert of the revert, recorded with type `restore`. Reverts and restores do not count as human edits, so passes can be reverted in any order.

The board and its command log are saved to a local SQLite database, in the worker's `BoardDurableObject`. Each command is written as it is recorded, and a full snapshot is saved every 25 commands or after 2 minutes, but never while an agent is mid-pass. On load, the board is rebuilt from the latest snapshot plus the commands after it, and the log comes back too, so Undo works on agent passes from before a reload. A reload in the middle of an agent pass keeps every finished command and drops only the action that was still streaming. The first time the store is empty, the board already saved in the browser becomes its first snapshot. In local development the database is under `.wrangler/state`. The reference board is not saved.

## Agent guidance

The built-in [canvas-work skill](worker/prompt/skills/canvas-work.md) teaches the model how to judge the scope of a request, plan a layout, and choose marks for illustrations, math and physics diagrams, and mockups. The backend includes the same skill in every model request, including follow-up requests, across providers.

The model picks the form of each answer. When a request names a topic but not a form, such as "Design a habit tracker app", it asks one short question with a few choices and waits. The choices appear as buttons in the chat, and a click or a typed reply continues the work. Each user request also tells the model where new work fits: clear space beside the selected shapes or context, or clear space in the user's view, measured from the shapes on the board. The agent never moves the user's camera. A focused question gets one focused visual. For work with several connected parts, such as a lesson or a project plan, the model can use the `map` action. The app places a row of titled frames, then sends one fill request per frame, so you can work in a finished frame while later frames generate. Content the agent draws inside a frame becomes part of that frame.

The skill explains its limits instead of enforcing them in code: small passes that fit the response budget, review from fresh screenshots, and repair passes only for visible defects.

Muse and the OpenAI-backed providers receive the existing action schema through the model API as well as the prompt. Provider progress messages appear in chat, separate from board instructions. Failed requests stop the current run and keep completed board work.

## Documents

- [Design document](docs/design.md): product direction, architecture, and the 14 build phases.
- [CLAUDE.md](CLAUDE.md): rules for agents that work in this repo.

## Project tracking

- Source of truth for code: GitHub.
- Code review: Entire mirrors the GitHub repo and runs one Trail per build phase.
- Planning: the Easel project in Linear has one milestone per build phase.
- Sessions: Delta syncs each Claude Code session, and Entire stores checkpoints with commits.
