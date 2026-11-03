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

4. Open `http://localhost:5173/`.

To use your ChatGPT Plus or Pro plan instead of an API key, run `npm run chatgpt` in a second terminal. Approve the sign-in in your browser, then pick `gpt-6.1-sol` in the chat panel. Review or limit usage in [ChatGPT Settings](https://chatgpt.com/settings/usage). The helper stores tokens in `~/.config/easel/`.

## Documents

- [Design document](docs/design.md): product direction, architecture, and the 14 build phases.
- [CLAUDE.md](CLAUDE.md): rules for agents that work in this repo.

## Project tracking

- Source of truth for code: GitHub.
- Code review: Entire mirrors the GitHub repo and runs one Trail per build phase.
- Planning: the Easel project in Linear has one milestone per build phase.
- Sessions: Delta syncs each Claude Code session, and Entire stores checkpoints with commits.
