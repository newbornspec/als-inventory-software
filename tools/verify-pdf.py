"""Verify a PDF produced by md-to-pdf.py against its Markdown source.

    python tools/verify-pdf.py paper/PAPER.md paper/pdf/PAPER.pdf

Exists because a converter that silently drops a table or runs a diagram off
the page is the defect class this project keeps finding: the build succeeds,
the output looks finished, and something is missing. It found one real defect
on first use - inline code at a fixed point size inside a heading was being
pushed onto its own baseline, splitting the line.


Checks what a successful reportlab build does NOT prove:
  1. every heading reached the PDF, and the body order is monotonic;
  2. no text overflows the page margins (Preformatted does not wrap and can
     run off the page silently);
  3. table and code-block content survived.

Table cells are checked per page at word level, not as phrases: a cell that
wraps onto a second line is interleaved with the other columns' continuations
by any text extractor, so a phrase match produces false alarms.
"""
import io
import re
import sys

import pdfplumber

MD, PDF = sys.argv[1], sys.argv[2]

PAGE_W = 595.276
MARGIN = 18 * 72 / 25.4
RIGHT_EDGE = PAGE_W - MARGIN
SLACK = 1.5

md = io.open(MD, encoding='utf-8').read().replace('\r\n', '\n')


def strip_md(t):
    t = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', t)
    t = re.sub(r'[*`]', '', t)
    return re.sub(r'\s+', ' ', t).strip()


headings, code_lines, table_cells = [], [], []
in_fence = False
for line in md.split('\n'):
    s = line.strip()
    if s.startswith('```'):
        in_fence = not in_fence
        continue
    if in_fence:
        if s:
            code_lines.append(s)
        continue
    m = re.match(r'^(#{1,3})\s+(.*)$', s)
    if m:
        headings.append((len(m.group(1)), strip_md(m.group(2))))
        continue
    if s.startswith('|') and '---' not in s:
        for c in s.strip('|').split('|'):
            c = strip_md(c)
            if len(c) > 6:
                table_cells.append(c)

pages_text, pages_words, overflow = [], [], []
with pdfplumber.open(PDF) as pdf:
    npages = len(pdf.pages)
    for pno, page in enumerate(pdf.pages, 1):
        pages_text.append(re.sub(r'\s+', ' ', page.extract_text() or ''))
        words = page.extract_words(use_text_flow=False)
        pages_words.append(set(w['text'].strip('.,;:()[]') for w in words))
        for w in words:
            if w['x1'] > RIGHT_EDGE + SLACK:
                overflow.append((pno, round(w['x1'] - RIGHT_EDGE, 1),
                                 w['text'][:44]))

flat = ' '.join(pages_text)

# --- 1. headings --------------------------------------------------------
missing_h = [h for lv, h in headings if h and h not in flat]

# Body order: page of each heading's LAST occurrence (the TOC holds the first).
order_breaks = []
last_page = 0
for lv, h in headings:
    # Level 1 is the document title, which the running footer repeats on every
    # page. It is furniture, not a position.
    if lv == 1 or not h or h in missing_h:
        continue
    pages_with = [i + 1 for i, t in enumerate(pages_text) if h in t]
    if not pages_with:
        continue
    pg = pages_with[-1]
    if pg < last_page:
        order_breaks.append((h, pg, last_page))
    last_page = max(last_page, pg)

# --- 2. code -----------------------------------------------------------
missing_code = [c for c in code_lines if re.sub(r'\s+', ' ', c) not in flat]

# --- 3. tables, word level per page ------------------------------------
missing_cells = []
for c in table_cells:
    if c in flat:
        continue
    words = [w.strip('.,;:()[]') for w in c.split() if len(w) > 2]
    if not words:
        continue
    if any(all(w in pw for w in words) for pw in pages_words):
        continue                      # all its words are on one page: wrapped
    missing_cells.append(c)

print('pages                 %d' % npages)
print('headings              %d in source, %d missing %s'
      % (len([h for lv, h in headings if h]), len(missing_h),
         ('  <-- ' + str(missing_h[:4])) if missing_h else ''))
print('body heading order    %s'
      % ('monotonic' if not order_breaks else 'BROKEN ' + str(order_breaks[:3])))
print('code lines            %d checked, %d missing %s'
      % (len(code_lines), len(missing_code),
         ('  <-- ' + str(missing_code[:3])) if missing_code else ''))
print('table cells           %d checked, %d missing %s'
      % (len(table_cells), len(missing_cells),
         ('  <-- ' + str(missing_cells[:4])) if missing_cells else ''))
print('margin overflow       %d %s'
      % (len(overflow), '' if not overflow else '(worst first)'))
for o in sorted(overflow, key=lambda x: -x[1])[:10]:
    print('    p%-3d +%-6.1fpt  %s' % o)

bad = bool(missing_h or missing_code or missing_cells or overflow
           or order_breaks)
print()
print('VERDICT: %s' % ('PROBLEMS FOUND' if bad else 'clean'))
sys.exit(1 if bad else 0)
