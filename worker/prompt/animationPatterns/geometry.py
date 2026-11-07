from manim import *
from easel import *


class Lesson(EaselScene):
    def construct(self):
        self.title("Area of a parallelogram", "Cut off one triangle and slide it across: base times height")
        # LAYOUT: the shape fills the main area (base 5.4 units, height 3.2 units, scale u),
        # labels outside its edges; the area argument in the side column.
        u = 1.0
        b, h, s = 5.4 * u, 3.2 * u, 1.6 * u  # base, height, slant
        o = MAIN_CENTER + np.array([-(b + s) / 2, -h / 2, 0])
        P = lambda x, y: o + np.array([x, y, 0])
        tri = Polygon(P(0, 0), P(s, 0), P(s, h), color=BLUE, fill_color=BLUE_SOFT, fill_opacity=1, stroke_width=3)
        rest = Polygon(P(s, 0), P(b, 0), P(b + s, h), P(s, h), color=BLUE, fill_color=BLUE_SOFT, fill_opacity=1, stroke_width=3)
        self.play(Create(VGroup(tri, rest)), run_time=1.4)
        base = measure(P(0, 0), P(b, 0), "b", side=DOWN)
        height = measure(P(s, 0) + 0.0 * RIGHT, P(s, h), "h", side=RIGHT)
        self.play(FadeIn(base), FadeIn(height))
        self.caption("A parallelogram with base b and height h")
        self.wait(0.5)

        # The cut: mark the triangle, then move it rigidly to the other side.
        self.play(tri.animate.set_fill(OCHRE_SOFT).set_stroke(OCHRE), run_time=0.6)
        self.caption("Cut along the height, and slide the triangle across")
        self.play(FadeOut(height), tri.animate.shift(b * RIGHT), run_time=1.6)
        self.add(ghost(tri.copy().shift(b * LEFT)))
        right_angle = RightAngle(Line(P(b, 0), P(b + s, 0)), Line(P(b + s, 0), P(b + s, h)), length=0.28, quadrant=(-1, 1), color=INK)
        new_height = measure(P(b + s, 0), P(b + s, h), "h", side=RIGHT)
        new_base = measure(P(s, 0), P(b + s, 0), "b", side=DOWN)
        self.play(FadeIn(right_angle), FadeIn(new_height), Transform(base, new_base))
        self.caption("Same pieces, now a rectangle")

        column = side_column(
            text("Same pieces, same area", size=LABEL, color=MUTED, slant="ITALIC"),
            formula(r"A = b \times h", color=BLUE),
        )
        self.play(FadeIn(column, shift=0.1 * RIGHT))
        self.play(Circumscribe(column[1], color=BLUE, buff=0.12))
        self.caption("Its area is base times height")
        self.end()
