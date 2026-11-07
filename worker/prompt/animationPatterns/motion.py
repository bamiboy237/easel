from manim import *
from easel import *


class Lesson(EaselScene):
    def construct(self):
        self.title("Circular motion", "A ball on a 2 m string, swung at a steady 3 m/s")

        # LAYOUT: the circle (radius 2 units) centred in the main area; vector labels beyond their tips;
        # the formula, values, and legend in the side column.

        # The givens, and every number shown, computed here.
        r, v = 2.0, 3.0
        a = v**2 / r  # centripetal acceleration, m/s^2
        scale = 1.0  # scene units per metre
        center = MAIN_CENTER + 0.1 * DOWN

        # 1. The setting: the path, the centre, the string, the ball.
        path = Circle(radius=r * scale, color=RULE, stroke_width=3).move_to(center)
        hub = dot(center, color=INK, radius=0.07)
        angle = ValueTracker(0)
        pos = lambda: center + r * scale * np.array([np.cos(angle.get_value()), np.sin(angle.get_value()), 0])
        string = always_redraw(lambda: Line(center, pos(), color=MUTED, stroke_width=2.5))
        ball = always_redraw(lambda: dot(pos(), color=INK, radius=0.13))
        self.play(Create(path), FadeIn(hub))
        self.play(Create(string), FadeIn(ball))
        radius_mark = measure(center, center + r * scale * RIGHT, "r = 2\\,\\mathrm{m}", side=DOWN)
        self.play(FadeIn(radius_mark))
        self.caption("The ball moves at a steady speed around the circle")

        # 2. Velocity: tangent to the circle, the same length all the way round.
        def tangent():
            t = angle.get_value()
            return 0.55 * v * np.array([-np.sin(t), np.cos(t), 0])

        vel = always_redraw(lambda: arrow(pos(), pos() + tangent(), color=BLUE, buff=0))
        vel_label = always_redraw(lambda: formula(r"\vec v", size=LABEL, color=BLUE).next_to(pos() + tangent(), np.array([-np.sin(angle.get_value()), np.cos(angle.get_value()), 0]), buff=0.12))
        self.play(GrowArrow(vel), FadeIn(vel_label))

        # 3. Acceleration: always toward the centre.
        acc = always_redraw(lambda: arrow(pos(), pos() + 0.3 * a * (center - pos()) / (r * scale), color=RED, buff=0))
        self.play(FadeOut(radius_mark), GrowArrow(acc))
        self.caption("Its velocity keeps turning, so it is accelerating")

        # The side column: the formula and the values, coloured like their arrows.
        column = side_column(
            formula(r"v = 3\,\mathrm{m/s}", color=BLUE),
            formula(rf"a = \frac{{v^2}}{{r}} = {a:.1f}\,\mathrm{{m/s^2}}", color=RED),
            legend((BLUE, "velocity"), (RED, "acceleration")),
        )
        self.play(LaggedStart(*[FadeIn(m, shift=0.1 * RIGHT) for m in column], lag_ratio=0.25), run_time=2)

        # 4. Motion: one slow turn, leaving faint copies to show the pattern.
        for k in range(3):
            self.play(angle.animate.set_value((k + 1) * TAU / 3), run_time=1.6, rate_func=linear)
            self.add(ghost(vel), ghost(acc))
        self.caption("Acceleration always points to the centre:  a = v² / r")
        self.play(Circumscribe(column[1], color=RED, buff=0.12))
        self.end()
