#!/usr/bin/env python3
"""Render a Markdown file as a typeset PDF.

Written as a tool rather than a one-off because the paper and the design records
are living documents: anything that has to be hand-converted goes stale, and the
fix for that is making it cheap to regenerate.

    python tools/md-to-pdf.py paper/PAPER.md
    python tools/md-to-pdf.py paper/PAPER.md -o somewhere/else.pdf
    python tools/md-to-pdf.py docs/design/*.md          # one PDF each

Supports the subset of Markdown this repository actually writes: ATX headings,
paragraphs with bold / italic / inline code / links, pipe tables, fenced code
blocks, blockquotes, bullet and numbered lists, task lists, and horizontal
rules. A two-pass build gives headings a clickable table of contents.

Uses reportlab, which the repo already depends on for its operator guides. No
LaTeX, no pandoc, no headless browser.
"""
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak,
                                PageTemplate, Paragraph, Preformatted, Spacer,
                                Table, TableStyle)
from reportlab.platypus.flowables import HRFlowable
from reportlab.platypus.tableofcontents import TableOfContents

# Palette lifted from tools/make-image-guide-pdf.py so the project's PDFs match.
NAVY = colors.HexColor("#0b1220")
BLUE = colors.HexColor("#1f3350")
ACCENT = colors.HexColor("#2563eb")
CODE_BG = colors.HexColor("#f4f6fa")
QUOTE_BG = colors.HexColor("#f7f9fc")
MUTED = colors.HexColor("#5b6b82")
RULE = colors.HexColor("#d7dee8")
HEAD_BG = colors.HexColor("#eef2f8")

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

BODY_FONT = "Helvetica"
BOLD_FONT = "Helvetica-Bold"
ITALIC_FONT = "Helvetica-Oblique"
MONO_FONT = "Courier"


# --------------------------------------------------------------------------
# Styles
# --------------------------------------------------------------------------

def build_styles():
    ss = getSampleStyleSheet()
    s = {}

    s["Title"] = ParagraphStyle(
        "Title", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=23,
        leading=28, textColor=NAVY, spaceAfter=4)
    s["Subtitle"] = ParagraphStyle(
        "Subtitle", parent=ss["Normal"], fontName=BODY_FONT, fontSize=12.5,
        leading=17, textColor=BLUE, spaceAfter=10)
    s["Byline"] = ParagraphStyle(
        "Byline", parent=ss["Normal"], fontName=ITALIC_FONT, fontSize=9,
        leading=13, textColor=MUTED, spaceAfter=3)

    # H1 is the document title; in an assembled paper H2 is a section.
    s["H1"] = ParagraphStyle(
        "H1", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=18,
        leading=23, textColor=NAVY, spaceBefore=16, spaceAfter=8)
    s["H2"] = ParagraphStyle(
        "H2", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=15,
        leading=19, textColor=NAVY, spaceBefore=18, spaceAfter=7)
    s["H3"] = ParagraphStyle(
        "H3", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=11.5,
        leading=15, textColor=BLUE, spaceBefore=13, spaceAfter=5)
    s["H4"] = ParagraphStyle(
        "H4", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=10,
        leading=14, textColor=BLUE, spaceBefore=10, spaceAfter=4)

    s["Body"] = ParagraphStyle(
        "Body", parent=ss["Normal"], fontName=BODY_FONT, fontSize=9.7,
        leading=14.2, textColor=NAVY, spaceAfter=7, alignment=4)  # justified
    s["Bullet"] = ParagraphStyle(
        "Bullet", parent=s["Body"], alignment=0, spaceAfter=3.5)
    s["Code"] = ParagraphStyle(
        "Code", parent=ss["Normal"], fontName=MONO_FONT, fontSize=8,
        leading=10, textColor=NAVY)
    s["Quote"] = ParagraphStyle(
        "Quote", parent=s["Body"], fontName=BODY_FONT, fontSize=9.9,
        leading=14.5, textColor=BLUE, alignment=0, spaceAfter=0)
    s["CellBody"] = ParagraphStyle(
        "CellBody", parent=ss["Normal"], fontName=BODY_FONT, fontSize=8.4,
        leading=11.4, textColor=NAVY)
    s["CellHead"] = ParagraphStyle(
        "CellHead", parent=s["CellBody"], fontName=BOLD_FONT, textColor=NAVY)

    s["TOC0"] = ParagraphStyle(
        "TOC0", parent=ss["Normal"], fontName=BOLD_FONT, fontSize=10,
        leading=16, textColor=NAVY, spaceBefore=5)
    s["TOC1"] = ParagraphStyle(
        "TOC1", parent=ss["Normal"], fontName=BODY_FONT, fontSize=9,
        leading=13, textColor=BLUE, leftIndent=12)
    return s


# --------------------------------------------------------------------------
# Inline markup -> reportlab's mini-HTML
# --------------------------------------------------------------------------

def _esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _emphasis(p):
    """Asterisk emphasis -> <b>/<i>, guaranteed well nested.

    Regex substitution cannot do this. Text like `**bold with *italic* here***`
    yields overlapping tags, which reportlab's parser rejects outright. A stack
    gets the nesting right and, more importantly, can never emit unbalanced
    markup.
    """
    out = []
    stack = []
    i, n = 0, len(p)
    while i < n:
        if p[i] != "*":
            out.append(p[i])
            i += 1
            continue
        j = i
        while j < n and p[j] == "*":
            j += 1
        run = j - i

        if run >= 3:
            if len(stack) >= 2 and set(stack[-2:]) == set("bi"):
                out.append("</%s>" % stack.pop())
                out.append("</%s>" % stack.pop())
            elif not stack:
                stack.append("b")
                out.append("<b>")
                stack.append("i")
                out.append("<i>")
            else:
                top = stack.pop()
                out.append("</%s>" % top)
                other = "i" if top == "b" else "b"
                stack.append(other)
                out.append("<%s>" % other)
            used = 3
        else:
            kind = "b" if run == 2 else "i"
            if kind in stack:
                while stack:
                    top = stack.pop()
                    out.append("</%s>" % top)
                    if top == kind:
                        break
            else:
                stack.append(kind)
                out.append("<%s>" % kind)
            used = run

        if run > used:
            out.append("*" * (run - used))
        i = j
    while stack:
        out.append("</%s>" % stack.pop())
    return "".join(out)


def safe_para(markup, style, plain=None):
    """A Paragraph that degrades to plain text rather than killing the run.

    The tokenizer above should make this unreachable. It exists because this
    tool will be pointed at Markdown nobody has checked, and a converter that
    dies on one odd character is a converter people stop using.
    """
    try:
        return Paragraph(markup, style)
    except Exception:
        fallback = _esc(plain if plain is not None
                        else re.sub(r"<[^>]+>", "", markup))
        return Paragraph(fallback, style)


def inline(text):
    """Convert inline Markdown to reportlab markup, code spans first."""
    out = []
    # Split on code spans so their contents are never treated as markup.
    for i, part in enumerate(re.split(r"`([^`]+)`", text)):
        if i % 2:
            # No size attribute: a fixed point size inside a heading puts the
            # code fragment on its own baseline, which splits the line.
            out.append('<font face="%s">%s</font>' % (MONO_FONT, _esc(part)))
            continue
        p = _esc(part)
        # Links: keep the text, make it clickable where the target is a URL.
        p = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)",
                   r'<link href="\2" color="#2563eb">\1</link>', p)
        p = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", p)
        p = _emphasis(p)
        p = p.replace("--", "&#8211;")
        out.append(p)
    return "".join(out)


# --------------------------------------------------------------------------
# Block parsing
# --------------------------------------------------------------------------

def is_table_sep(line):
    return bool(re.match(r"^\|?[\s:|-]*-[\s:|-]*\|?$", line.strip())) \
        and "|" in line and "-" in line


def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def parse(md):
    """Markdown text -> a list of ('kind', payload) blocks."""
    lines = md.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks = []
    i = 0
    n = len(lines)

    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # Fenced code
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i].rstrip("\n"))
                i += 1
            i += 1
            blocks.append(("code", buf))
            continue

        # Horizontal rule
        if re.match(r"^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$", stripped):
            blocks.append(("hr", None))
            i += 1
            continue

        # Headings
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            blocks.append(("h%d" % len(m.group(1)), m.group(2).strip()))
            i += 1
            continue

        # Table: a pipe row whose next line is a separator
        if "|" in stripped and i + 1 < n and is_table_sep(lines[i + 1]):
            header = split_row(stripped)
            i += 2
            rows = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(split_row(lines[i]))
                i += 1
            blocks.append(("table", (header, rows)))
            continue

        # Blockquote
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i].rstrip()))
                i += 1
            blocks.append(("quote", buf))
            continue

        # Lists (bullet, numbered, task) with one level of nesting
        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", raw.rstrip())
        if m:
            items = []
            ordered = bool(re.match(r"^\d", m.group(2)))
            while i < n:
                mm_ = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$",
                               lines[i].rstrip())
                if not mm_:
                    # A continuation line belongs to the current item.
                    if (items and lines[i].strip()
                            and lines[i].startswith((" ", "\t"))):
                        items[-1][2] += " " + lines[i].strip()
                        i += 1
                        continue
                    break
                depth = 1 if len(mm_.group(1)) >= 2 else 0
                items.append([depth, mm_.group(2), mm_.group(3).strip()])
                i += 1
            blocks.append(("list", (ordered, items)))
            continue

        # Paragraph: gather until a blank line or a block starter
        buf = []
        while i < n and lines[i].strip():
            s2 = lines[i].strip()
            if (re.match(r"^#{1,6}\s", s2) or s2.startswith(">")
                    or s2.startswith("```")
                    or re.match(r"^(\s*)([-*+]|\d+[.)])\s+", lines[i])
                    or ("|" in s2 and i + 1 < n and is_table_sep(lines[i + 1]))
                    or re.match(r"^(-\s*){3,}$|^(\*\s*){3,}$", s2)):
                break
            buf.append(s2)
            i += 1
        if buf:
            blocks.append(("p", " ".join(buf)))

    return blocks


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def col_widths(header, rows, total):
    """Proportional widths from the longest cell per column, with a floor."""
    ncols = max([len(header)] + [len(r) for r in rows]) if rows else len(header)

    def clean(t):
        return re.sub(r"[*`\[\]]|\(.*?\)", "", t)

    weights = []
    for c in range(ncols):
        longest = len(clean(header[c])) if c < len(header) else 1
        for r in rows:
            if c < len(r):
                # A long cell wraps, so damp its influence.
                longest = max(longest, min(len(clean(r[c])), 64))
        weights.append(max(longest, 4))
    scale = total / float(sum(weights))
    widths = [w * scale for w in weights]

    # Enforce a minimum so a narrow column never collapses.
    floor = 15 * mm
    short = [k for k, w in enumerate(widths) if w < floor]
    if short and len(short) < ncols:
        deficit = sum(floor - widths[k] for k in short)
        donors = [k for k in range(ncols) if k not in short]
        pool = sum(widths[k] for k in donors)
        for k in short:
            widths[k] = floor
        for k in donors:
            widths[k] -= deficit * (widths[k] / pool)
    return widths


def render_table(header, rows, st):
    ncols = max([len(header)] + [len(r) for r in rows]) if rows else len(header)
    header = header + [""] * (ncols - len(header))
    blank_header = not any(h.strip() for h in header)

    data = []
    if not blank_header:
        data.append([safe_para(inline(h), st["CellHead"], plain=h) for h in header])
    for r in rows:
        r = r + [""] * (ncols - len(r))
        data.append([safe_para(inline(c), st["CellBody"], plain=c) for c in r])
    if not data:
        return Spacer(1, 1)

    widths = col_widths(header, rows, CONTENT_W)
    t = Table(data, colWidths=widths, repeatRows=0 if blank_header else 1,
              hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, RULE),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
    ]
    if not blank_header:
        style += [
            ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, BLUE),
        ]
    t.setStyle(TableStyle(style))
    return t


def render_code(lines, st):
    """Monospace block, auto-shrunk so the widest line fits the page."""
    text = "\n".join(lines) if lines else " "
    widest = max((stringWidth(l, MONO_FONT, 8) for l in lines), default=0)
    size = 8.0
    avail = CONTENT_W - 12
    if widest > avail:
        size = max(4.6, 8.0 * avail / widest)
    style = ParagraphStyle("CodeBlk", parent=st["Code"],
                           fontSize=size, leading=size * 1.22)
    inner = Preformatted(text, style)
    t = Table([[inner]], colWidths=[CONTENT_W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def render_quote(lines, st):
    text = " ".join(l.strip() for l in lines if l.strip())
    para = safe_para(inline(text), st["Quote"], plain=text)
    t = Table([[para]], colWidths=[CONTENT_W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), QUOTE_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def render_list(ordered, items, st):
    out = []
    for depth, marker, text in items:
        task = re.match(r"^\[([ xX])\]\s*(.*)$", text)
        if task:
            box = "&#9745;" if task.group(1).lower() == "x" else "&#9744;"
            bullet = box
            text = task.group(2)
        elif ordered and re.match(r"^\d", marker):
            bullet = marker if marker.endswith(".") else marker[:-1] + "."
        else:
            bullet = "&#9702;" if depth else "&#8226;"
        style = ParagraphStyle(
            "LI%d" % depth, parent=st["Bullet"],
            leftIndent=14 + depth * 14, bulletIndent=3 + depth * 14)
        # reportlab takes a custom bullet glyph via the <bullet> tag.
        out.append(safe_para("<bullet>%s</bullet>%s" % (bullet, inline(text)),
                             style, plain=text))
    return out


def to_story(blocks, st, want_toc):
    story = []
    title_done = False
    saw_first_h2 = False

    for kind, payload in blocks:
        if kind == "h1":
            if not title_done:
                story.append(safe_para(inline(payload), st["Title"], plain=payload))
                title_done = True
            else:
                story.append(safe_para(inline(payload), st["H1"], plain=payload))
        elif kind == "h2":
            if want_toc and not saw_first_h2:
                saw_first_h2 = True
                story.append(PageBreak())
            story.append(safe_para(inline(payload), st["H2"], plain=payload))
        elif kind == "h3":
            story.append(safe_para(inline(payload), st["H3"], plain=payload))
        elif kind in ("h4", "h5", "h6"):
            story.append(safe_para(inline(payload), st["H4"], plain=payload))
        elif kind == "p":
            # The assembled paper's subtitle/byline lines sit before any H2.
            if not saw_first_h2 and payload.startswith("**") \
                    and payload.endswith("**") and len(payload) < 120:
                story.append(safe_para(inline(payload), st["Subtitle"], plain=payload))
            elif not saw_first_h2 and payload.startswith("*") \
                    and payload.endswith("*"):
                story.append(safe_para(inline(payload), st["Byline"], plain=payload))
            else:
                story.append(safe_para(inline(payload), st["Body"], plain=payload))
        elif kind == "table":
            header, rows = payload
            story.append(Spacer(1, 3))
            story.append(render_table(header, rows, st))
            story.append(Spacer(1, 9))
        elif kind == "code":
            story.append(Spacer(1, 2))
            story.append(render_code(payload, st))
            story.append(Spacer(1, 9))
        elif kind == "quote":
            story.append(Spacer(1, 2))
            story.append(render_quote(payload, st))
            story.append(Spacer(1, 9))
        elif kind == "list":
            ordered, items = payload
            story.extend(render_list(ordered, items, st))
            story.append(Spacer(1, 6))
        elif kind == "hr":
            story.append(Spacer(1, 4))
            story.append(HRFlowable(width="100%", thickness=0.6, color=RULE,
                                    spaceBefore=2, spaceAfter=8))
    return story


# --------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------

class Doc(BaseDocTemplate):
    """Adds a running footer and notifies the TOC of every heading."""

    def __init__(self, path, doc_title, **kw):
        BaseDocTemplate.__init__(self, path, pagesize=A4,
                                 leftMargin=MARGIN, rightMargin=MARGIN,
                                 topMargin=MARGIN, bottomMargin=20 * mm,
                                 title=doc_title, author="ALS Inventory",
                                 **kw)
        frame = Frame(MARGIN, 20 * mm, CONTENT_W,
                      PAGE_H - MARGIN - 20 * mm, id="body")
        self.doc_title = doc_title
        self.addPageTemplates([
            PageTemplate(id="main", frames=[frame], onPage=self._decorate)])

    def _decorate(self, canv, doc):
        canv.saveState()
        canv.setFont(BODY_FONT, 7.6)
        canv.setFillColor(MUTED)
        label = self.doc_title
        if len(label) > 78:
            label = label[:75] + "..."
        canv.drawString(MARGIN, 13 * mm, label)
        canv.drawRightString(PAGE_W - MARGIN, 13 * mm, "%d" % doc.page)
        canv.setStrokeColor(RULE)
        canv.setLineWidth(0.4)
        canv.line(MARGIN, 16.5 * mm, PAGE_W - MARGIN, 16.5 * mm)
        canv.restoreState()

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        name = flowable.style.name
        level = {"H2": 0, "H3": 1}.get(name)
        if level is None:
            return
        text = flowable.getPlainText()
        key = "h-%d-%d" % (self.page, abs(hash(text)) % 100000)
        self.canv.bookmarkPage(key)
        self.notify("TOCEntry", (level, text, self.page, key))


def convert(src, dst=None, toc=None):
    with open(src, "r", encoding="utf-8") as fh:
        md = fh.read()

    blocks = parse(md)
    h2s = sum(1 for k, _ in blocks if k == "h2")
    want_toc = h2s >= 6 if toc is None else toc

    title = next((p for k, p in blocks if k == "h1"),
                 os.path.splitext(os.path.basename(src))[0])
    title = re.sub(r"[*`]", "", title)

    dst = dst or os.path.splitext(src)[0] + ".pdf"
    st = build_styles()
    story = to_story(blocks, st, want_toc)

    if want_toc:
        t = TableOfContents()
        t.levelStyles = [st["TOC0"], st["TOC1"]]
        toc_block = [Spacer(1, 6),
                     Paragraph("Contents", st["H2"]),
                     Spacer(1, 4), t]
        # Insert after the title block, before the first section.
        cut = next((k for k, f in enumerate(story)
                    if isinstance(f, PageBreak)), 0)
        story = story[:cut] + toc_block + story[cut:]

    doc = Doc(dst, title)
    doc.multiBuild(story)
    return dst, doc.page, want_toc


def main(argv):
    args = [a for a in argv if not a.startswith("-")]
    out = None
    if "-o" in argv:
        out = argv[argv.index("-o") + 1]
        args = [a for a in args if a != out]
    if not args:
        print(__doc__)
        return 1
    if out and len(args) > 1:
        print("-o takes a single input file")
        return 1

    for src in args:
        if not os.path.exists(src):
            print("  MISSING  %s" % src)
            continue
        dst, pages, had_toc = convert(src, out)
        print("  %-34s -> %-34s %3d pages%s"
              % (os.path.basename(src), os.path.relpath(dst), pages,
                 "  (with contents)" if had_toc else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
