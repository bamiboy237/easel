"""
Easel's helpers for Manim scenes: the board's paper look, its inks and type,
and a few builders that keep text readable and on screen.

A scene starts with:

    from manim import *
    from easel import *

    class Lesson(EaselScene):
        def construct(self):
            self.title("Projectile motion", "A ball thrown at 20 m/s, 50 degrees up")
            ...

This module is imported after `from manim import *`, so its colour names
replace Manim's bright ones, which are made for a dark background.
"""

import os as _os

import numpy as np
from manim import (
    DL,
    DOWN,
    LEFT,
    ORIGIN,
    RIGHT,
    UL,
    UP,
    UR,
    Arrow,
    Axes,
    Create,
    DashedLine,
    Dot,
    FadeIn,
    FadeOut,
    GrowArrow,
    Line,
    ManimColor,
    MathTex,
    Mobject,
    RoundedRectangle,
    Scene,
    SurroundingRectangle,
    Tex,
    Text,
    VGroup,
    VMobject,
    Write,
    config,
    smooth,
)

# ---------------------------------------------------------------------------
# Inks. Each colour has one meaning in a scene; say it in the scene's text.

PAPER = "#FFFDF8"  # the background
INK = "#302F2A"  # text, outlines, the main object
MUTED = "#8A8578"  # secondary text, captions, guides, axes ticks
RULE = "#D8D2C4"  # faint lines: grids, tracks, dividers
RED = "#AE3B2C"  # the thing to watch: a force, an error, the key quantity
BLUE = "#2F5D8C"  # the second quantity, or motion
GREEN = "#344C41"  # a result, a correct answer, energy kept
OCHRE = "#A8741A"  # a rare highlight, for one moment only

# Soft tints for filled areas, cards, and highlights behind text.
RED_SOFT = "#F3DEDA"
BLUE_SOFT = "#DCE6F0"
GREEN_SOFT = "#DDE6DF"
OCHRE_SOFT = "#F3E7CF"
INK_SOFT = "#ECE7DC"

# Manim's colour names, mapped to the paper inks, so code written for a dark
# background still reads on paper.
WHITE = INK
BLACK = INK
GRAY = GREY = MUTED
LIGHT_GRAY = LIGHT_GREY = RULE
DARK_GRAY = DARK_GREY = INK
BLUE_A = BLUE_B = BLUE_C = BLUE_D = BLUE_E = BLUE
RED_A = RED_B = RED_C = RED_D = RED_E = RED
GREEN_A = GREEN_B = GREEN_C = GREEN_D = GREEN_E = GREEN
TEAL = TEAL_A = TEAL_B = TEAL_C = TEAL_D = TEAL_E = GREEN
YELLOW = YELLOW_A = YELLOW_B = YELLOW_C = YELLOW_D = YELLOW_E = OCHRE
GOLD = GOLD_A = GOLD_B = GOLD_C = GOLD_D = GOLD_E = OCHRE
ORANGE = PURE_RED = MAROON = MAROON_A = MAROON_B = MAROON_C = MAROON_D = MAROON_E = RED
PINK = LIGHT_PINK = PURPLE = PURPLE_A = PURPLE_B = PURPLE_C = PURPLE_D = PURPLE_E = RED
PURE_BLUE = DARK_BLUE = LIGHT_BLUE = BLUE
PURE_GREEN = LIGHT_BROWN = DARK_BROWN = GREEN

# ---------------------------------------------------------------------------
# Type. Sizes are Manim font sizes; nothing smaller than SMALL reads on the board.

SERIF = _os.environ.get("EASEL_SERIF") or "DejaVu Serif"
SANS = "Inter"

TITLE = 40
HEADING = 34
BODY = 30
LABEL = 26
SMALL = 22

# ---------------------------------------------------------------------------
# The frame: a title band on top, a caption band at the bottom, the stage between.

MARGIN = 0.45
FRAME_W = config.frame_width
FRAME_H = config.frame_height
LEFT_X = -FRAME_W / 2 + MARGIN
RIGHT_X = FRAME_W / 2 - MARGIN
TOP_Y = FRAME_H / 2 - MARGIN
BOTTOM_Y = -FRAME_H / 2 + MARGIN

# The stage is where the visual lives: below the title, above the caption.
STAGE_TOP = 2.35
STAGE_BOTTOM = -2.75
STAGE_LEFT = LEFT_X
STAGE_RIGHT = RIGHT_X
STAGE_CENTER = np.array([0.0, (STAGE_TOP + STAGE_BOTTOM) / 2, 0.0])
STAGE_WIDTH = STAGE_RIGHT - STAGE_LEFT
STAGE_HEIGHT = STAGE_TOP - STAGE_BOTTOM
CAPTION_Y = -3.35


# Manim's own defaults are white or bright, made for a dark background. Every
# object that ends up with one of them gets the matching paper ink instead.
_REMAP = {}


def _hex(color):
    return ManimColor(color).to_hex().upper()[:7]


for _bright, _paper in [
    ("#FFFFFF", INK),
    ("#000000", INK),
    ("#FFFF00", OCHRE),
    ("#58C4DD", BLUE),
    ("#29ABCA", BLUE),
    ("#236B8E", BLUE),
    ("#1C758A", BLUE),
    ("#FC6255", RED),
    ("#CF5044", RED),
    ("#83C167", GREEN),
    ("#699C52", GREEN),
    ("#5CD0B3", GREEN),
    ("#F7D96F", OCHRE),
    ("#F4D345", OCHRE),
    ("#E8C11C", OCHRE),
    ("#FF862F", RED),
    ("#9A72AC", RED),
    ("#888888", MUTED),
    ("#BBBBBB", RULE),
    ("#444444", INK),
]:
    _REMAP[_bright] = ManimColor(_paper).to_rgb()


def _repaint(mobject):
    for m in mobject.get_family():
        for attr in ("stroke_rgbas", "fill_rgbas", "background_stroke_rgbas"):
            rgbas = getattr(m, attr, None)
            if rgbas is None or len(rgbas) == 0:
                continue
            for row in rgbas:
                key = "#%02X%02X%02X" % tuple(int(round(c * 255)) for c in row[:3])
                if key in _REMAP:
                    row[:3] = _REMAP[key]


_vmobject_init = VMobject.__init__


def _paper_init(self, *args, **kwargs):
    _vmobject_init(self, *args, **kwargs)
    _repaint(self)


VMobject.__init__ = _paper_init

for _cls in (Text,):
    _cls.set_default(font=SERIF, color=INK)
MathTex.set_default(color=INK)
Tex.set_default(color=INK)


# ---------------------------------------------------------------------------
# Builders.


def text(content, size=BODY, color=INK, weight="NORMAL", slant="NORMAL", font=None, max_width=None):
    """A line of text in the board's serif. Use \\n for a second line; keep lines short."""
    t = Text(str(content), font_size=size, color=color, weight=weight, slant=slant, font=font or SERIF, line_spacing=0.9)
    if max_width and t.width > max_width:
        t.scale_to_fit_width(max_width)
    return t


def formula(tex, size=BODY, color=INK):
    """A formula, in LaTeX."""
    return MathTex(tex, font_size=size * 1.15, color=color)


def keep_on_screen(mobject, margin=MARGIN):
    """Move (and if needed shrink) a mobject so it sits fully inside the frame."""
    max_w = FRAME_W - 2 * margin
    max_h = FRAME_H - 2 * margin
    if mobject.width > max_w:
        mobject.scale_to_fit_width(max_w)
    if mobject.height > max_h:
        mobject.scale_to_fit_height(max_h)
    left, right = mobject.get_left()[0], mobject.get_right()[0]
    bottom, top = mobject.get_bottom()[1], mobject.get_top()[1]
    dx = max(0, -FRAME_W / 2 + margin - left) - max(0, right - (FRAME_W / 2 - margin))
    dy = max(0, -FRAME_H / 2 + margin - bottom) - max(0, top - (FRAME_H / 2 - margin))
    mobject.shift(np.array([dx, dy, 0]))
    return mobject


def fit_stage(mobject, width=None, height=None, center=None):
    """Scale a whole visual to fill the stage (or a part of it), keeping its shape, and center it there."""
    w = width or STAGE_WIDTH
    h = height or STAGE_HEIGHT
    scale = min(w / max(mobject.width, 1e-6), h / max(mobject.height, 1e-6))
    mobject.scale(scale)
    mobject.move_to(STAGE_CENTER if center is None else center)
    return mobject


def label(content, target, direction=UP, size=LABEL, color=INK, buff=0.18, math_mode=False):
    """A short label beside a target, on the given side, kept on screen."""
    t = formula(content, size=size, color=color) if math_mode else text(content, size=size, color=color)
    t.next_to(target, direction, buff=buff)
    return keep_on_screen(t)


def arrow(start, end, color=INK, width=5, buff=0.1, tip=0.22):
    """A clean arrow from start to end (points or mobjects)."""
    return Arrow(
        start,
        end,
        color=color,
        stroke_width=width,
        buff=buff,
        tip_length=tip,
        max_tip_length_to_length_ratio=0.35,
        max_stroke_width_to_length_ratio=12,
    )


def vector(origin, delta, color=RED, name=None, side=None, size=LABEL):
    """An arrow from origin along delta, with an optional label at its tip side. Returns VGroup(arrow[, label])."""
    origin = np.array(origin, dtype=float)
    end = origin + np.array(delta, dtype=float)
    a = arrow(origin, end, color=color, buff=0)
    group = VGroup(a)
    if name:
        d = np.array(delta, dtype=float)
        norm = np.linalg.norm(d[:2]) or 1.0
        if side is None:
            # Put the label beyond the tip, slightly to the side, never on the shaft.
            side = d / norm
        lab = formula(name, size=size, color=color) if ("\\" in name or "_" in name or "^" in name) else text(name, size=size, color=color)
        lab.next_to(end, side, buff=0.12)
        keep_on_screen(lab)
        group.add(lab)
    return group


def card(content, color=BLUE, width=None, height=None, size=LABEL, fill=None):
    """A rounded card with a soft fill and a short text in it, for steps, parts, and stages."""
    t = text(content, size=size, color=INK)
    w = width or t.width + 0.6
    h = height or t.height + 0.45
    if t.width > w - 0.3:
        t.scale_to_fit_width(w - 0.3)
    soft = fill or {RED: RED_SOFT, BLUE: BLUE_SOFT, GREEN: GREEN_SOFT, OCHRE: OCHRE_SOFT}.get(color, INK_SOFT)
    box = RoundedRectangle(corner_radius=0.14, width=w, height=h, stroke_color=color, stroke_width=3, fill_color=soft, fill_opacity=1)
    t.move_to(box.get_center())
    return VGroup(box, t)


def flow(items, direction=RIGHT, color=BLUE, buff=0.7, width=None, size=LABEL):
    """Cards in a row or column, joined by arrows. items are strings or mobjects. Returns VGroup(cards, arrows)."""
    cards = VGroup(*[card(i, color=color, width=width, size=size) if isinstance(i, str) else i for i in items])
    cards.arrange(direction, buff=buff)
    arrows = VGroup(*[arrow(a.get_edge_center(direction), b.get_edge_center(-direction), color=MUTED, width=4, buff=0.08) for a, b in zip(cards, cards[1:])])
    group = VGroup(cards, arrows)
    if group.width > STAGE_WIDTH or group.height > STAGE_HEIGHT:
        fit_stage(group)
    return group


def highlight(target, color=OCHRE, buff=0.12):
    """A soft rounded box behind a target, to point at it."""
    soft = {RED: RED_SOFT, BLUE: BLUE_SOFT, GREEN: GREEN_SOFT, OCHRE: OCHRE_SOFT}.get(color, INK_SOFT)
    box = SurroundingRectangle(target, color=color, buff=buff, corner_radius=0.1, stroke_width=2.5)
    box.set_fill(soft, opacity=1)
    box.set_z_index(target.z_index - 1)
    return box


def plot_axes(x_range, y_range, width=7.5, height=3.6, x_label=None, y_label=None, numbers=True, size=SMALL):
    """Axes in ink, with readable tick numbers and axis names. x_range and y_range are [min, max, step]."""
    ax = Axes(
        x_range=x_range,
        y_range=y_range,
        x_length=width,
        y_length=height,
        tips=False,
        axis_config={
            "color": MUTED,
            "stroke_width": 2.5,
            "include_ticks": True,
            "tick_size": 0.06,
            "include_numbers": numbers,
            "font_size": size,
            "decimal_number_config": {"color": MUTED, "num_decimal_places": 0},
        },
    )
    group = VGroup(ax)
    if x_label:
        xl = text(x_label, size=size, color=MUTED, slant="ITALIC")
        xl.next_to(ax.x_axis.get_right(), DOWN, buff=0.35).align_to(ax.x_axis.get_right(), RIGHT)
        group.add(xl)
        ax.x_label_mobject = xl
    if y_label:
        yl = text(y_label, size=size, color=MUTED, slant="ITALIC")
        yl.next_to(ax.y_axis.get_top(), UP, buff=0.2)
        yl.align_to(ax.y_axis.get_left(), LEFT).shift(0.2 * LEFT)
        group.add(yl)
        ax.y_label_mobject = yl
    return ax, group


def guide(start, end, color=MUTED):
    """A thin dashed guide line, for projections and reference levels."""
    return DashedLine(start, end, color=color, stroke_width=2, dash_length=0.08)


def stack(*mobjects, direction=DOWN, buff=0.3, aligned_edge=LEFT):
    """Mobjects in a column (or row), aligned on one edge."""
    return VGroup(*mobjects).arrange(direction, buff=buff, aligned_edge=aligned_edge)


# ---------------------------------------------------------------------------
# The scene.


class EaselScene(Scene):
    """A scene on the board's paper, with a title band and a caption band."""

    def setup(self):
        super().setup()
        self.camera.background_color = PAPER
        self._caption = None
        self._title = None

    def title(self, heading, subtitle=None, run_time=1.0):
        """Write the title at the top left, with an optional one-line subtitle in grey under it."""
        head = text(heading, size=TITLE, weight="SEMIBOLD", max_width=FRAME_W - 2 * MARGIN)
        group = VGroup(head)
        if subtitle:
            sub = text(subtitle, size=LABEL, color=MUTED, slant="ITALIC", max_width=FRAME_W - 2 * MARGIN)
            sub.next_to(head, DOWN, buff=0.14, aligned_edge=LEFT)
            group.add(sub)
        group.to_corner(UL, buff=MARGIN)
        self.play(FadeIn(head, shift=0.15 * DOWN), run_time=run_time)
        if subtitle:
            self.play(FadeIn(group[1]), run_time=0.6)
        self._title = group
        return group

    def caption(self, content, run_time=0.6, color=INK):
        """Say one short sentence at the bottom, replacing the last one. Pass None to clear it."""
        animations = []
        if self._caption is not None:
            animations.append(FadeOut(self._caption, shift=0.1 * UP))
        new = None
        if content:
            new = text(content, size=LABEL, color=color, max_width=FRAME_W - 2 * MARGIN - 0.4)
            new.move_to([0, CAPTION_Y, 0])
            animations.append(FadeIn(new, shift=0.1 * UP))
        if animations:
            self.play(*animations, run_time=run_time)
        self._caption = new
        return new

    def end(self, pause=2.0):
        """Hold the finished picture, so it stays readable at the end of the video."""
        self.wait(pause)
