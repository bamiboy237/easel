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

The development server listens only on your Mac. AI requests must come from the same local Easel page. Tablet connections are planned for Phase 14.

## Inspect board commands

Open the browser console and run `agentApp.commands.getHistory()`.

Each entry contains a command ID, an origin (`user`, `agent`, or `voice`), a type, a status (`applied` or `rejected`), the document changes, and a timestamp. Direct edits appear after the editor transaction. Agent instructions are validated before they run. Preview updates do not add commands.

Each applied command gets the next board revision in `rev`. Run `agentApp.commands.getRev()` to read the current revision. Each agent request records the revision it read the board at, and every command from that request carries it as `baseRev`. If a user or voice command changed one of the command's records after `baseRev`, the agent command is stale: nothing from it applies, the log records it as `rejected` with the changed records in `staleRecordIds`, and the agent's next pass is told which shapes changed. Agent creates on new IDs are never stale.

The command log stays in memory and starts empty after a reload. SQLite persistence, protected regions, and safe revert remain in Phase 2.

## Agent guidance

The built-in [canvas-work skill](worker/prompt/skills/canvas-work.md) teaches the model how to judge the scope of a request, plan a layout, and choose marks for illustrations, math and physics diagrams, and mockups. The backend includes the same skill in every model request, including follow-up requests, across providers.

A focused question gets one focused visual. For work with several connected parts, such as a lesson or a project plan, the model can use the `map` action. The app places a row of titled frames, then sends one fill request per frame, so you can work in a finished frame while later frames generate. Content the agent draws inside a frame becomes part of that frame.

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
