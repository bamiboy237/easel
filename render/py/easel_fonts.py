"""
The board's serif, Source Serif 4, as font files Pango can load.

The web app ships the font as variable woff2 files. Pango reads variable
TrueType files, so the render service unpacks them once, into its cache, and
every render registers them. If that fails, renders fall back to a system
serif, so a missing font never stops a render.
"""

import os

SERIF_FAMILY = "Source Serif 4"

_STYLES = ("normal", "italic")


def ensure_fonts(font_root, out_dir):
    """Unpack the woff2 files if they are missing, and return the paths."""
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for style in _STYLES:
        path = os.path.join(out_dir, f"SourceSerif4-{style}.ttf")
        if not os.path.exists(path):
            from fontTools.ttLib import TTFont

            font = TTFont(os.path.join(font_root, f"source-serif-4-latin-standard-{style}.woff2"))
            font.flavor = None
            tmp = path + ".tmp"
            font.save(tmp)
            os.replace(tmp, path)
        paths.append(path)
    return paths


def register_fonts(font_root, out_dir):
    """Register the board's serif with Pango. Returns the family to use, or None."""
    try:
        import manimpango

        for path in ensure_fonts(font_root, out_dir):
            if not manimpango.register_font(path):
                return None
        return SERIF_FAMILY
    except Exception:
        return None
