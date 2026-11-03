# Easel

Read `docs/design.md` before you change product behavior. It is the source of truth for product and architecture decisions.

## Command model

Every board change is a validated command. Keep all changes on this one code path.

- Record the origin of each command: user, agent, or voice.
- Attach the base board revision to each agent command. Reject the command as stale if its target changed.
- Reject agent commands into protected user regions, unless the user asked for that change.
- Apply direct manipulation locally and immediately, then record the command.
- Keep cancel and revert separate. Reverting agent work must keep newer human work.

## Build order

- Work on one build phase at a time. Pass its gate before you start the next phase.
- Phase 0 skips styling work.
- Test each change on the two fixed sessions: a physics concept and a project mockup.

## Workflow

- Keep GitHub as the source of truth. Entire is a mirror.
- Open one Entire Trail per build phase.
- Track work in the Easel project in Linear, in team `THE`.
- Add the Entire review agent for the command model in Phase 2.

## Writing

Follow the `technical-writing` skill for docs, commit messages, and PR descriptions. Use no emojis and no em dashes in technical documents.
