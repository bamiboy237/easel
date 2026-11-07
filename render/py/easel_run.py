"""
Render one Manim scene for the render service, in its own process.

    python -I easel_run.py JOB_DIR

JOB_DIR holds scene.py and job.json. The runner refuses source that reaches
for the system or the network before any of it runs, then renders with an
audit hook that blocks sockets and any program other than LaTeX. It reports
on stdout, one line per event, each starting with "EASEL ":

    {"type": "check", "scene": name, "estimate": n}   the source passed the check
    {"type": "step", "index": i, "time": t, "frame": path, "layout": [...]}
    {"type": "done", "video": path, "duration": s, "steps": [...], "layout": [...]}
    {"type": "refused", "message": ...}               the source failed the check
    {"type": "error", "message": ..., "line": n}      the scene raised
"""

import ast
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MAX_SOURCE_CHARS = 40000

# Modules a scene may import. Everything else is refused.
ALLOWED_MODULES = {
    "manim",
    "easel",
    "numpy",
    "math",
    "random",
    "itertools",
    "functools",
    "typing",
    "dataclasses",
    "colorsys",
    "fractions",
    "decimal",
    "statistics",
    "string",
    "enum",
    "collections",
}

# Names a scene may not use: ways into files, processes, the network, or the interpreter.
BLOCKED_NAMES = {
    "open",
    "exec",
    "eval",
    "compile",
    "__import__",
    "globals",
    "locals",
    "vars",
    "getattr",
    "setattr",
    "delattr",
    "input",
    "breakpoint",
    "memoryview",
    "help",
    "exit",
    "quit",
    "os",
    "sys",
    "subprocess",
    "socket",
    "shutil",
    "pathlib",
    "Path",
    "importlib",
    "builtins",
    "__builtins__",
    "ctypes",
    "urllib",
    "requests",
    "http",
    "httpx",
    "tempfile",
    "io",
    "pickle",
    "marshal",
    "inspect",
    "types",
    "gc",
    "threading",
    "multiprocessing",
    "asyncio",
    "signal",
}

# Attributes that read or write files, or reach native code.
BLOCKED_ATTRIBUTES = {
    "load",
    "loads",
    "save",
    "savez",
    "savez_compressed",
    "savetxt",
    "loadtxt",
    "genfromtxt",
    "fromfile",
    "tofile",
    "memmap",
    "ctypeslib",
    "DataSource",
    "system",
    "popen",
    "spawn",
    "unlink",
    "rmdir",
    "rmtree",
    "write_text",
    "write_bytes",
    "read_text",
    "read_bytes",
}

# Programs Manim itself runs, for formulas.
ALLOWED_PROGRAMS = {"latex", "pdflatex", "xelatex", "lualatex", "dvisvgm", "kpsewhich", "ffmpeg", "ffprobe"}


def emit(event):
    sys.stdout.write("EASEL " + json.dumps(event) + "\n")
    sys.stdout.flush()


def refuse(message, line=None):
    emit({"type": "refused", "message": message, "line": line})
    sys.exit(3)


def check_source(source):
    """Refuse source that reaches outside the animation. Returns the scene class names."""
    if len(source) > MAX_SOURCE_CHARS:
        refuse(f"The source is {len(source)} characters; the limit is {MAX_SOURCE_CHARS}.")
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        emit({"type": "error", "message": f"SyntaxError: {error.msg}", "line": error.lineno})
        sys.exit(1)
    scenes = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", None)
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_MODULES:
                    refuse(f"Line {line} imports {alias.name}. Animations have no network or system access; import only manim, easel, numpy, and math.", line)
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if node.level or root not in ALLOWED_MODULES:
                refuse(f"Line {line} imports from {node.module}. Animations have no network or system access; import only manim, easel, numpy, and math.", line)
        elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            refuse(f"Line {line} uses {node.id}, which an animation may not use.", line)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") and node.attr not in ("__init__",):
                refuse(f"Line {line} uses {node.attr}, which an animation may not use.", line)
            if node.attr in BLOCKED_ATTRIBUTES:
                refuse(f"Line {line} uses .{node.attr}, which reads or writes files; an animation may not use it.", line)
            if isinstance(node.value, ast.Name) and node.value.id == "config" and isinstance(node.ctx, ast.Store):
                refuse(f"Line {line} changes config.{node.attr}; the board sets the render settings.", line)
        elif isinstance(node, ast.ClassDef):
            bases = [b.id if isinstance(b, ast.Name) else getattr(b, "attr", "") for b in node.bases]
            if any(b.endswith("Scene") for b in bases):
                scenes.append(node.name)
    if not scenes:
        refuse("The source defines no Scene class.")
    return scenes


def install_guard(job_dir, cache_dirs):
    """Block sockets, other programs, and writes outside the job's folders, for the rest of the run."""
    writable = [os.path.realpath(d) for d in [job_dir, *cache_dirs, "/dev/null"]]

    def allowed_write(path):
        try:
            real = os.path.realpath(os.fsdecode(path))
        except Exception:
            return False
        return any(real == d or real.startswith(d + os.sep) for d in writable)

    def program_allowed(path):
        name = os.path.basename(os.fsdecode(path)) if path else ""
        return name in ALLOWED_PROGRAMS

    def hook(event, args):
        if event.startswith("socket.") or event in ("urllib.Request", "http.client.connect", "ftplib.connect", "smtplib.connect"):
            raise PermissionError("An animation may not use the network.")
        if event == "subprocess.Popen":
            executable, argv = args[0], args[1]
            first = argv[0] if isinstance(argv, (list, tuple)) and argv else argv
            if not program_allowed(executable or first) and not program_allowed(first):
                raise PermissionError(f"An animation may not run {first}.")
        elif event in ("os.system", "os.exec", "os.spawn", "os.fork", "os.forkpty", "pty.spawn", "os.startfile", "ctypes.dlopen"):
            raise PermissionError(f"An animation may not use {event}.")
        elif event == "os.posix_spawn":
            if not program_allowed(args[0]):
                raise PermissionError("An animation may not run other programs.")
        elif event == "open":
            path, mode, flags = args
            if isinstance(path, int):
                return
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
            if writing and not allowed_write(path):
                raise PermissionError(f"An animation may not write {path}.")
        elif event in ("os.remove", "os.rmdir", "os.rename", "shutil.rmtree"):
            if not allowed_write(args[0]):
                raise PermissionError("An animation may not change files outside its folder.")

    sys.addaudithook(hook)


def set_limits(seconds):
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (seconds + 5, seconds + 10))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
    except Exception:
        pass


def estimate_steps(source):
    return max(1, source.count(".play(") + source.count(".caption(") + source.count(".title(") * 2 + source.count(".wait(") + source.count(".end("))


# ---------------------------------------------------------------------------
# Layout check: text that overlaps other text, sits on a line, is off screen,
# or is too small to read on the board.


def _visible(m):
    try:
        return max(float(m.get_stroke_opacity() or 0), float(m.get_fill_opacity() or 0)) > 0.05
    except Exception:
        return True


def _box(m):
    dl, ur = m.get_corner([-1, -1, 0]), m.get_corner([1, 1, 0])
    return (dl[0], dl[1], ur[0], ur[1])


def _name(m):
    for attr in ("original_text", "tex_string", "text"):
        v = getattr(m, attr, None)
        if isinstance(v, str) and v.strip():
            return v.strip()[:40]
    return type(m).__name__


_T = None


def _samples(m):
    """Points along a VMobject's curves, not only its anchors, so a straight line is seen along its length."""
    import numpy as np

    global _T
    if _T is None:
        t = np.linspace(0, 1, 13)[:, None]
        _T = ((1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t**2, t**3)
    pts = m.points
    n = len(pts) // 4 * 4
    if n == 0:
        return pts
    p0, p1, p2, p3 = pts[0:n:4], pts[1:n:4], pts[2:n:4], pts[3:n:4]
    a, b, c, d = _T
    out = a[:, None, :] * p0[None] + b[:, None, :] * p1[None] + c[:, None, :] * p2[None] + d[:, None, :] * p3[None]
    return out.reshape(-1, 3)


def layout_problems(scene):
    from manim import MathTex, SingleStringMathTex, Tex, Text, MarkupText, Paragraph, DecimalNumber, VMobject

    text_types = (Text, MarkupText, Paragraph, MathTex, SingleStringMathTex, Tex, DecimalNumber)
    fw, fh = scene.camera.frame_width, scene.camera.frame_height
    texts = []
    strokes = []
    seen = set()

    def walk(m, inside_text=False):
        if id(m) in seen:
            return
        seen.add(id(m))
        is_text = isinstance(m, text_types)
        if is_text and not inside_text:
            if any(_visible(f) for f in m.get_family()) and m.width > 0.01:
                texts.append(m)
        if not is_text and not inside_text and isinstance(m, VMobject) and len(m.points):
            try:
                if m.get_stroke_width() > 0.5 and float(m.get_stroke_opacity() or 0) > 0.3:
                    strokes.append(m)
            except Exception:
                pass
        for s in m.submobjects:
            walk(s, inside_text or is_text)

    for m in scene.mobjects:
        walk(m)

    problems = []
    for t in texts:
        x0, y0, x1, y1 = _box(t)
        if x0 < -fw / 2 - 0.02 or x1 > fw / 2 + 0.02 or y0 < -fh / 2 - 0.02 or y1 > fh / 2 + 0.02:
            problems.append(f'text "{_name(t)}" runs off screen')
        size = getattr(t, "font_size", None)
        if isinstance(size, (int, float)):
            limit = 22 if not isinstance(t, (MathTex, SingleStringMathTex, Tex)) else 24
            if size < limit - 0.5:
                problems.append(f'text "{_name(t)}" is too small to read on the board (font size {round(size)})')
    for i, a in enumerate(texts):
        ax0, ay0, ax1, ay1 = _box(a)
        for b in texts[i + 1 :]:
            if a in b.get_family() or b in a.get_family():
                continue
            bx0, by0, bx1, by1 = _box(b)
            w = min(ax1, bx1) - max(ax0, bx0)
            h = min(ay1, by1) - max(ay0, by0)
            if w > 0.03 and h > 0.03:
                smaller = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0)) or 1
                if w * h / smaller > 0.08:
                    problems.append(f'text "{_name(a)}" overlaps text "{_name(b)}"')
    for t in texts:
        x0, y0, x1, y1 = _box(t)
        # Grow the box a little: a line that touches a label counts, as it does to the eye.
        px, py = -0.03, -0.03
        x0, x1, y0, y1 = x0 + px, x1 - px, y0 + py, y1 - py
        for s in strokes:
            pts = _samples(s)
            inside = (pts[:, 0] > x0) & (pts[:, 0] < x1) & (pts[:, 1] > y0) & (pts[:, 1] < y1)
            if inside.sum() >= 2:
                problems.append(f'a line or shape runs through text "{_name(t)}"')
                break
    out = []
    for p in problems:
        if p not in out:
            out.append(p)
    return out[:12]


def composition_problems(scene):
    """How the finished picture uses the stage: too small a drawing, or a third of it empty."""
    from manim import VMobject

    skip = set()
    for band in (getattr(scene, "_title", None), getattr(scene, "_caption", None)):
        if band is not None:
            skip.update(id(m) for m in band.get_family())
    from manim import MathTex, SingleStringMathTex, Tex, Text, MarkupText, Paragraph, DecimalNumber

    text_types = (Text, MarkupText, Paragraph, MathTex, SingleStringMathTex, Tex, DecimalNumber)
    in_text = set()
    for top in scene.mobjects:
        for m in top.get_family():
            if isinstance(m, text_types):
                in_text.update(id(f) for f in m.get_family())
    boxes = []
    drawing = []
    for top in scene.mobjects:
        for m in top.get_family():
            if id(m) in skip or m.submobjects or not isinstance(m, VMobject) or not len(m.points):
                continue
            if not _visible(m):
                continue
            boxes.append(_box(m))
            if id(m) not in in_text:
                drawing.append(_box(m))
    if drawing:
        dx = min(6.65, max(b[2] for b in drawing)) - max(-6.65, min(b[0] for b in drawing))
        dy = min(2.35, max(b[3] for b in drawing)) - max(-2.75, min(b[1] for b in drawing))
        covered = max(0.0, dx) * max(0.0, dy) / (13.3 * 5.1)
        if covered < 0.3:
            problems_first = [f"the drawing itself (not counting text) covers only {round(covered * 100)} percent of the stage; draw the main visual larger"]
        else:
            problems_first = []
    else:
        problems_first = []
    if not boxes:
        return ["the finished picture is empty"]
    left, right, bottom, top = -6.65, 6.65, -2.75, 2.35
    x0 = max(left, min(b[0] for b in boxes))
    y0 = max(bottom, min(b[1] for b in boxes))
    x1 = min(right, max(b[2] for b in boxes))
    y1 = min(top, max(b[3] for b in boxes))
    problems = list(problems_first)
    share = max(0.0, (x1 - x0)) * max(0.0, (y1 - y0)) / ((right - left) * (top - bottom))
    if share < 0.45:
        problems.append(f"the finished picture fills only {round(share * 100)} percent of the stage; make the main visual larger")
    # The widest empty band across the stage, between parts of the picture or at its edge.
    for axis, low, high, limit, names in ((0, left, right, 3.5, ("x", "left", "right")), (1, bottom, top, 2.2, ("y", "bottom", "top"))):
        spans = sorted((max(low, b[axis]), min(high, b[axis + 2])) for b in boxes if b[axis + 2] > low and b[axis] < high)
        edge, gap, where = low, 0.0, None
        for a, b in spans + [(high, high)]:
            if a - edge > gap:
                gap, where = a - edge, (edge + a) / 2
            edge = max(edge, b)
        if gap >= limit:
            problems.append(f"an empty band {gap:.1f} units wide runs across the stage at {names[0]} = {where:.1f}; enlarge or spread the picture to use it")
    return problems


def share_formulas(job_dir, shared_dir):
    """Compile formulas in the job's own folder, and share the results between jobs.

    Manim deletes every file but the SVGs from its formula folder after each
    compile, so jobs sharing one folder delete each other's LaTeX files mid-run.
    Each job compiles in its own folder instead, takes a finished SVG from the
    shared folder when one exists, and adds the ones it makes.
    """
    import shutil
    from pathlib import Path

    from manim import config
    import manim.mobject.text.tex_mobject as tex_mobject
    import manim.utils.tex_file_writing as tex_writing

    shared = Path(shared_dir)
    private = Path(job_dir) / "tex"
    private.mkdir(parents=True, exist_ok=True)
    config.tex_dir = str(private)
    compile_svg = tex_writing.tex_to_svg_file

    def tex_to_svg_file(expression, environment=None, tex_template=None):
        template = tex_template if tex_template is not None else config["tex_template"]
        local = tex_writing.generate_tex_file(expression, environment, template).with_suffix(".svg")
        known = shared / local.name
        if known.exists() and not local.exists():
            shutil.copyfile(known, local)
        try:
            result = compile_svg(expression, environment, template)
        except ValueError:
            # Manim's message points at a log file; the writer needs the LaTeX error itself.
            reason = ""
            try:
                lines = local.with_suffix(".log").read_text(errors="replace").splitlines()
                errors = [l for l in lines if l.startswith("!")]
                reason = " ".join(errors[:2])
            except Exception:
                pass
            import re

            shown = re.sub(r"\\special\{dvisvgm:raw [^}]*\}", "", expression)
            raise ValueError(f"LaTeX could not typeset {shown!r}: {reason or 'unknown error'}. Use plain LaTeX math; words go in \\text{{}}.") from None
        if not known.exists():
            staging = shared / f"{local.name}.{os.getpid()}.tmp"
            shutil.copyfile(result, staging)
            os.replace(staging, known)
        return result

    tex_writing.tex_to_svg_file = tex_to_svg_file
    tex_mobject.tex_to_svg_file = tex_to_svg_file


def main():
    job_dir = os.path.abspath(sys.argv[1])
    with open(os.path.join(job_dir, "job.json")) as f:
        job = json.load(f)
    with open(os.path.join(job_dir, "scene.py")) as f:
        source = f.read()
    set_limits(int(job.get("timeoutSeconds", 120)))
    scenes = check_source(source)
    scene_name = job.get("scene") or scenes[-1]
    if scene_name not in scenes:
        refuse(f"The source has no scene called {scene_name}.")
    emit({"type": "check", "scene": scene_name, "estimate": estimate_steps(source)})

    fonts = job.get("fontsDir")
    serif = None
    if fonts and job.get("fontRoot"):
        from easel_fonts import register_fonts

        serif = register_fonts(job["fontRoot"], fonts)
    if serif:
        os.environ["EASEL_SERIF"] = serif

    # Manim and the helpers load before the guard: they load native libraries,
    # which the guard refuses to the scene's own code.
    from manim import Scene, config
    import easel  # noqa: F401

    cache_dirs = [d for d in (job.get("texDir"), fonts) if d]
    install_guard(job_dir, cache_dirs)

    width, height = job.get("width", 854), job.get("height", 480)
    config.pixel_width = width
    config.pixel_height = height
    config.frame_height = 8.0
    config.frame_width = 8.0 * width / height
    config.frame_rate = job.get("fps", 15)
    config.media_dir = os.path.join(job_dir, "media")
    if job.get("texDir"):
        share_formulas(job_dir, job["texDir"])
    config.disable_caching = True
    config.progress_bar = "none"
    config.verbosity = "ERROR"
    config.output_file = "video"
    config.background_color = "#FFFDF8"
    # A sketch runs the animations at a few frames a second and writes no video:
    # each step's end state, as a frame. Skipping the animations outright would
    # be faster, but traced paths and other updaters would then draw wrong.
    sketch = bool(job.get("sketch"))
    if sketch:
        config.write_to_movie = False
    # One part of a longer render, which the service renders in parallel and
    # joins: the animations from first to last (inclusive; -1 for the end).
    # The animations before it run without drawing, to reach its start.
    first = int(job.get("fromAnimation") or 0)
    last = int(job.get("uptoAnimation", -1))
    if first > 0:
        config.from_animation_number = first
    if last >= 0:
        config.upto_animation_number = last

    frames_dir = os.path.join(job_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    steps = []
    all_layout = []
    save_frames = job.get("frames", True)
    drawn = [0]

    beat = {"caption": None, "n": 0}

    def record(scene, kind):
        index = len(steps)
        t = float(getattr(scene.renderer, "time", 0.0))
        frame = None
        # A beat of the story lasts from one caption to the next; its last step shows what the caption says.
        caption = getattr(scene, "_caption", None)
        if caption is not beat["caption"]:
            beat["caption"] = caption
            beat["n"] += 1
        if index < first or (last >= 0 and index > last):
            steps.append({"index": index, "kind": kind, "time": round(t, 3), "frame": None, "beat": beat["n"]})
            return
        drawn[0] += 1
        if save_frames and kind == "play":
            try:
                from PIL import Image

                frame = os.path.join(frames_dir, f"{index:03d}.png")
                if sketch:
                    scene.renderer.update_frame(scene)
                Image.fromarray(scene.renderer.get_frame()).convert("RGB").save(frame, compress_level=1)
            except Exception:
                frame = None
        try:
            problems = layout_problems(scene)
        except Exception:
            problems = []
        for p in problems:
            if p not in all_layout:
                all_layout.append(p)
        steps.append({"index": index, "kind": kind, "time": round(t, 3), "frame": frame and os.path.relpath(frame, job_dir), "beat": beat["n"]})
        emit({"type": "step", "index": index, "kind": kind, "time": round(t, 3), "frame": frame and os.path.relpath(frame, job_dir), "layout": problems})

    original_play = Scene.play

    def play(self, *args, **kwargs):
        result = original_play(self, *args, **kwargs)
        record(self, "play")
        return result

    # Scene.wait plays a Wait animation, so recording plays records waits too.
    Scene.play = play

    import importlib.util

    started = time.time()
    try:
        spec = importlib.util.spec_from_file_location("scene", os.path.join(job_dir, "scene.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scene = getattr(module, scene_name)()
        scene.render()
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        if first > 0 and drawn[0] == 0 and len(steps) <= first:
            # A part that starts after the scene's last animation has nothing to draw.
            emit({"type": "done", "video": None, "empty": True, "duration": round(float(getattr(scene.renderer, "time", 0.0)), 3), "steps": steps, "layout": [], "seconds": round(time.time() - started, 2)})
            return
        tb = traceback.extract_tb(error.__traceback__)
        mine = os.path.join(job_dir, "scene.py")
        ours = [f for f in tb if os.path.abspath(f.filename) == mine]
        line = ours[-1].lineno if ours else None
        where = [f"line {f.lineno}: {f.line}" for f in ours][-3:]
        message = f"{type(error).__name__}: {error}"
        emit({"type": "error", "message": message[:1500], "line": line, "where": where})
        sys.exit(1)

    if last < 0:
        try:
            for problem in composition_problems(scene):
                if problem not in all_layout:
                    all_layout.append(problem)
        except Exception:
            pass
    movie = None if sketch or drawn[0] == 0 else os.path.relpath(str(scene.renderer.file_writer.movie_file_path), job_dir)
    emit(
        {
            "type": "done",
            "video": movie,
            "empty": drawn[0] == 0,
            "duration": round(float(scene.renderer.time), 3),
            "steps": steps,
            "layout": all_layout,
            "seconds": round(time.time() - started, 2),
        }
    )


if __name__ == "__main__":
    main()
