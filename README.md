# Easel

Easel is a shared multimodal canvas where people and agents explore, create, and revise ideas together. Text, voice, ink, and comments all change the same board state.

The project bet is that people prefer this way of working with agents over chat.

## Status

Easel is in Phase 0, the rough loop. The repo holds documents only. No app code exists yet.

Phase 0 builds a rough version from the tldraw agent starter. Its gate is to run both test sessions and decide whether working this way beats chat. The test sessions are exploring a physics concept and developing a project mockup.

## Documents

- [Design document](docs/design.md): product direction, architecture, and the 14 build phases.
- [CLAUDE.md](CLAUDE.md): rules for agents that work in this repo.

## Project tracking

- Source of truth for code: GitHub.
- Code review: Entire mirrors the GitHub repo and runs one Trail per build phase.
- Planning: the Easel project in Linear has one milestone per build phase.
- Sessions: Delta syncs each Claude Code session, and Entire stores checkpoints with commits.
