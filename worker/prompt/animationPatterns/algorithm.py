from manim import *
from easel import *


class Lesson(EaselScene):
    def construct(self):
        values = [4, 7, 2, 9, 5]
        self.title("Finding the largest value", f"Scan the list {', '.join(map(str, values))} once, keeping the best so far")
        # LAYOUT: bars across the main area, baseline at y = -2.0, up to 3.6 tall;
        # the decision label above the pair being compared; the best-so-far readout on the side.
        row = bar_row(values, center=MAIN_CENTER + 0.2 * DOWN, slot=1.4, max_height=3.6)
        self.play(LaggedStart(*[FadeIn(item, shift=0.2 * UP) for item in row], lag_ratio=0.12), run_time=1.4)
        self.caption("Keep the largest value seen so far")

        best = 0
        self.play(mark(row[0], color=GREEN))
        note = side_column(text("Best so far", size=LABEL, color=MUTED, slant="ITALIC"), formula(rf"\text{{best}} = {values[0]}", color=GREEN))
        self.play(FadeIn(note))
        for i in range(1, len(values)):
            look = highlight(row[i], color=OCHRE)
            bigger = values[i] > values[best]
            words = f"{values[i]} > {values[best]}: new best" if bigger else f"{values[i]} < {values[best]}: keep"
            decision = text(words, size=LABEL, color=GREEN if bigger else MUTED).next_to(VGroup(row[best], row[i]), UP, buff=0.3)
            self.play(FadeIn(look), FadeIn(decision), run_time=0.6)
            self.wait(0.4)
            if bigger:
                new_note = formula(rf"\text{{best}} = {values[i]}", color=GREEN).move_to(note[1], aligned_edge=LEFT)
                self.play(mark(row[best], color=BLUE), mark(row[i], color=GREEN), Transform(note[1], new_note), FadeOut(look), FadeOut(decision), run_time=0.7)
                best = i
            else:
                self.play(FadeOut(look), FadeOut(decision), run_time=0.5)
        self.play(Circumscribe(row[best], color=GREEN, buff=0.1))
        self.caption(f"One pass finds the largest: {values[best]}")
        self.end()
