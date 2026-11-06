# Visual quality climb

This log records where the visual quality work stopped, so a later round can pick it up.

## Goal

Boards should look like the work of a skilled, artistic teacher at a whiteboard. The target is a live score of 4.50 or more from GPT 6.1 Sol at high effort, with no board under 4.0.

## How rounds are measured

- The app runs on `gpt-6.1-terra-plan` at medium effort. Sol at high is used only to review.
- Each round runs the same 22 live boards. Sol scores each board from 1 to 5 on 8 criteria: composition, legibility, no collisions, hierarchy, color, arrows, correctness, and build order.
- Each round must also pass these regression checks:
  - the templates;
  - the Phase 11 gate on both sessions;
  - the redraw style test;
  - the diagram replays;
  - the eval subset.

## Where it stands

| Round | PR | Sol overall |
|---|---|---|
| 4 | #56 | 4.02 |
| 6 | #57 | 4.15 |
| 7 | #58 | 4.17 |

Scores per criterion after round 7:

| Criterion | Score |
|---|---|
| Composition | 3.61 |
| Legibility | 4.50 |
| No collisions | 4.76 |
| Hierarchy | 3.87 |
| Color | 4.09 |
| Arrows | 4.17 |
| Correctness | 4.36 |
| Build order | 4.00 |

Five boards are under 4.0:

| Board | Score | Why |
|---|---|---|
| Chemical bonds | 3.65 | The model drew text instead of a scene. The output varies from run to run. |
| Physics free-body diagram | 3.69 | The user's frame has too little free room, so the diagram lands outside it. |
| Bill flow | 3.69 | It needs named stages, exact veto timing, and a shorter connector between columns. |
| Water cycle | 3.81 | Wording, and the Sun is missing. |
| Timeline with an added event | 3.89 | More notes made the column tall, so the text is small at fit. |

## Next ideas, ranked

1. **Full frames: needs a decision from the user.** Let the agent grow a frame the user drew, or ask before it does. This changes the command model.
2. **Loops in procedures.** Lay out an arrow back to an earlier step as a side return loop.
3. **Bill flow.** A continuation level with the step it leaves, and section headings from node groups.
4. **Long timelines.** Split them into two columns.
5. **Concept map correctness.** A check pass that reads each link as "A verb B" and repairs reversed links.
6. **Run-to-run variance.** Steer chemical bonds and the free-body diagram toward templates.
