#!/usr/bin/env python3
"""Render an asciicast v2 recording into a polished MP4 and GIF.

    python3 scripts/demo/render-demo.py demo.cast assets/demo/oasis-terminal-demo

Needs: pip install pyte pillow; ffmpeg on PATH. Fonts: JetBrains Mono if
OASIS_DEMO_FONT_DIR points at its ttf folder, otherwise DejaVu Sans Mono, with
Noto Sans Symbols fallbacks for the glyphs the UI uses (⏺ ⎿ ⠋ ✦).
"""
import json, os, subprocess, sys, tempfile, shutil
import pyte
from PIL import Image, ImageDraw, ImageFont, ImageFilter

CAST, OUT = sys.argv[1], sys.argv[2]
SCALE = 2                      # supersample for crisp text, then downscale
FONT_SIZE = 15 * SCALE
FPS = 24
MAX_IDLE = 2.2                 # long pauses are shortened to this

FONT_DIR = os.environ.get('OASIS_DEMO_FONT_DIR', '/home/user/fonts/jb/fonts/ttf')
def load(paths):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, FONT_SIZE)
    return None
REG = load([FONT_DIR + '/JetBrainsMono-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'])
BOLD = load([FONT_DIR + '/JetBrainsMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'])
FALLBACKS = [f for f in [load(['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']),
                         load(['/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf']),
                         load(['/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf'])] if f]

from fontTools.ttLib import TTFont
_cmaps = {}
def has_glyph(font, ch):
    path = font.path
    if path not in _cmaps:
        _cmaps[path] = TTFont(path).getBestCmap()
    return ord(ch) in _cmaps[path]
def font_for(ch, bold):
    primary = BOLD if bold else REG
    if has_glyph(primary, ch):
        return primary
    for f in FALLBACKS:
        if has_glyph(f, ch):
            return f
    return primary

# Theme: GitHub-dark style terminal on an OASIS teal/amber backdrop.
BG = (13, 17, 23)
FG = (230, 237, 243)
PALETTE = {
    'black': (72, 79, 88), 'red': (255, 123, 114), 'green': (63, 185, 80), 'brown': (210, 153, 34), 'yellow': (210, 153, 34),
    'blue': (88, 166, 255), 'magenta': (188, 140, 255), 'cyan': (57, 197, 207), 'white': (177, 186, 196),
    'brightblack': (110, 118, 129), 'brightred': (255, 161, 152), 'brightgreen': (86, 211, 100), 'brightyellow': (227, 179, 65),
    'brightblue': (121, 192, 255), 'brightmagenta': (210, 168, 255), 'brightcyan': (86, 212, 221), 'brightwhite': (240, 246, 252),
}
def color(value, default, bold=False):
    if value in (None, 'default'):
        return default
    if isinstance(value, str) and len(value) == 6 and all(c in '0123456789abcdefABCDEF' for c in value):
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
    name = str(value).lower().replace(' ', '')
    if bold and name in PALETTE and 'bright' + name in PALETTE:
        name = 'bright' + name
    return PALETTE.get(name, default)

with open(CAST) as fh:
    header = json.loads(fh.readline())
    events = [json.loads(line) for line in fh if line.strip()]
COLS, ROWS = header['width'], header['height']

ascent, descent = REG.getmetrics()
CELL_W = round(REG.getlength('M'))
CELL_H = round((ascent + descent) * 1.18)
PAD = 22 * SCALE
BAR = 38 * SCALE
MARGIN = 34 * SCALE
TERM_W = COLS * CELL_W + PAD * 2
TERM_H = ROWS * CELL_H + PAD * 2 + BAR
W = TERM_W + MARGIN * 2
H = TERM_H + MARGIN * 2 + 26 * SCALE
W += W % (2 * SCALE); H += H % (2 * SCALE)

def backdrop():
    img = Image.new('RGB', (W, H))
    top, bottom = (14, 54, 58), (9, 14, 28)
    px = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        px.line([(0, y), (W, y)], fill=tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3)))
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse([W * 0.55, -H * 0.4, W * 1.3, H * 0.5], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(120 * SCALE))
    img.paste(Image.new('RGB', (W, H), (251, 191, 36)), (0, 0), glow)
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([MARGIN, MARGIN + 10 * SCALE, MARGIN + TERM_W, MARGIN + TERM_H + 10 * SCALE], 14 * SCALE, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SCALE))
    img.paste(Image.new('RGB', (W, H), (0, 0, 0)), (0, 0), shadow)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([MARGIN, MARGIN, MARGIN + TERM_W, MARGIN + TERM_H], 14 * SCALE, fill=BG, outline=(48, 54, 61), width=SCALE)
    d.rectangle([MARGIN + SCALE, MARGIN + BAR - SCALE, MARGIN + TERM_W - SCALE, MARGIN + BAR - SCALE], fill=(33, 38, 45))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx, cy = MARGIN + 22 * SCALE + i * 20 * SCALE, MARGIN + BAR // 2
        d.ellipse([cx - 6 * SCALE, cy - 6 * SCALE, cx + 6 * SCALE, cy + 6 * SCALE], fill=c)
    title = os.environ.get('OASIS_DEMO_TITLE', 'oasis  —  ~/taskflow')
    tf = ImageFont.truetype(REG.path, 13 * SCALE)
    d.text((MARGIN + TERM_W / 2 - tf.getlength(title) / 2, MARGIN + BAR / 2 - 8 * SCALE), title, font=tf, fill=(139, 148, 158))
    caption = os.environ.get('OASIS_DEMO_CAPTION', 'Real OASIS runtime, tools and safety policy  ·  model replies scripted for reproducibility  ·  scripts/demo/')
    cf = ImageFont.truetype(REG.path, 12 * SCALE)
    d.text((W / 2 - cf.getlength(caption) / 2, MARGIN + TERM_H + 16 * SCALE), caption, font=cf, fill=(160, 174, 168))
    return img

BASE = backdrop()

def render(screen):
    img = BASE.copy()
    d = ImageDraw.Draw(img)
    ox, oy = MARGIN + PAD, MARGIN + BAR + PAD
    for y in range(ROWS):
        row = screen.buffer[y]
        for x in range(COLS):
            ch = row[x]
            fg = color(ch.fg, FG, ch.bold)
            bg = color(ch.bg, None)
            if ch.reverse:
                fg, bg = (bg or BG), fg
            px, py = ox + x * CELL_W, oy + y * CELL_H
            if bg:
                d.rectangle([px, py, px + CELL_W, py + CELL_H], fill=bg)
            if ch.data and ch.data != ' ':
                f = font_for(ch.data, ch.bold)
                if ch.data == '⎿':
                    w = max(1, SCALE)
                    mx = px + CELL_W // 3
                    d.line([mx, py + CELL_H * 0.12, mx, py + CELL_H * 0.55], fill=fg, width=w)
                    d.line([mx, py + CELL_H * 0.55, px + CELL_W * 0.95, py + CELL_H * 0.55], fill=fg, width=w)
                    continue
                if ch.data == '█':
                    d.rectangle([px, py, px + CELL_W, py + CELL_H], fill=fg)
                    continue
                d.text((px, py + (CELL_H - (ascent + descent)) // 2), ch.data, font=f, fill=fg)
            if ch.underscore:
                d.line([px, py + CELL_H - 2 * SCALE, px + CELL_W, py + CELL_H - 2 * SCALE], fill=fg, width=SCALE)
    if not screen.cursor.hidden:
        cx, cy = ox + screen.cursor.x * CELL_W, oy + screen.cursor.y * CELL_H
        d.rectangle([cx, cy + 2 * SCALE, cx + CELL_W - SCALE, cy + CELL_H - 2 * SCALE], fill=(251, 191, 36))
    return img.resize((W // SCALE, H // SCALE), Image.LANCZOS)

screen = pyte.Screen(COLS, ROWS)
stream = pyte.Stream(screen)
tmp = tempfile.mkdtemp()
frames = []           # (path, duration)
clock = 0.0           # output time
last_t = 0.0
pending = 0.0
index = 0

poster_at = None
def snapshot(duration):
    global index, poster_at
    if poster_at is None and any('Verified' in line for line in screen.display):
        poster_at = index
    path = os.path.join(tmp, f'f{index:05d}.png')
    render(screen).save(path, optimize=False, compress_level=1)
    frames.append((path, duration))
    index += 1

# Group output into frames at FPS; shorten long idle gaps.
step = 1.0 / FPS
next_frame = 0.0
t_out = 0.0
i = 0
prev_event_t = 0.0
while i < len(events):
    t, kind, data = events[i]
    gap = min(t - prev_event_t, MAX_IDLE)
    t_out += gap
    prev_event_t = t
    if kind == 'o':
        stream.feed(data)
    # Coalesce events that land within the same frame.
    while i + 1 < len(events) and events[i + 1][0] - prev_event_t < step:
        i += 1
        prev_event_t = events[i][0]
        if events[i][1] == 'o':
            stream.feed(events[i][2])
    nxt = events[i + 1][0] if i + 1 < len(events) else prev_event_t + 2.5
    hold = max(step, min(nxt - prev_event_t, MAX_IDLE))
    snapshot(hold)
    i += 1
snapshot(2.5)

concat = os.path.join(tmp, 'list.txt')
with open(concat, 'w') as fh:
    for path, duration in frames:
        fh.write(f"file '{path}'\nduration {duration:.4f}\n")
    fh.write(f"file '{frames[-1][0]}'\n")

os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
                '-vf', f'fps={FPS},format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', OUT + '.mp4'], check=True)
palette = os.path.join(tmp, 'palette.png')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', OUT + '.mp4', '-vf', 'fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff', palette], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', OUT + '.mp4', '-i', palette, '-lavfi', 'fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', OUT + '.gif'], check=True)
# Poster: the finished fix, just before the second prompt.
poster_index = poster_at if poster_at is not None else len(frames) - 1
Image.open(frames[poster_index][0]).save(OUT + '-poster.png', optimize=True)
total = sum(d for _, d in frames)
print(f'Rendered {len(frames)} frames, {total:.1f}s -> {OUT}.mp4, {OUT}.gif, {OUT}-poster.png')
shutil.rmtree(tmp)
