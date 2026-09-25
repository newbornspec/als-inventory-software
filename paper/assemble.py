"""Assemble PAPER.md from paper/sections/*.md and report word counts.

Section files are numbered (01-..., 02-...) and assembled in that order.
Everything from a '## Drafting notes' heading onward is excluded from the
assembled paper and from the counts -- those notes are working material.

Run:  python paper/assemble.py
"""

import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SECTIONS = os.path.join(HERE, 'sections')

TITLE = 'Proving what a second-hand computer is'
SUBTITLE = 'An evidence-first architecture for IT asset disposition'


def body_of(path):
    """The section text, minus the draft-status header block and the notes."""
    s = io.open(path, encoding='utf-8').read()
    # Strip a leading '**Draft n...**\n\n---\n' status block if present.
    parts = s.split('\n---\n', 1)
    if len(parts) == 2 and len(parts[0]) < 400:
        s = parts[1]
    s = s.split('## Drafting notes')[0]
    return s.strip()


def measure(text):
    """(prose words, table count). A table is a run of consecutive '|' lines."""
    prose = 0
    tables = 0
    in_table = False
    for line in text.splitlines():
        if line.strip().startswith('|'):
            if not in_table:
                tables += 1
                in_table = True
        else:
            in_table = False
            prose += len(line.split())
    return prose, tables


def main():
    files = sorted(f for f in os.listdir(SECTIONS) if re.match(r'^\d\d-.*\.md$', f))
    if not files:
        print('No section files in %s yet.' % SECTIONS)
        return

    parts = []
    rows = []
    prose_total = 0
    table_total = 0

    for fn in files:
        body = body_of(os.path.join(SECTIONS, fn))
        words, tables = measure(body)
        prose_total += words
        table_total += tables
        rows.append((fn, words, tables))
        parts.append(body)

    header = (
        '# %s\n\n**%s**\n\n'
        '*Assembled from `paper/sections/` -- edit those files, not this one.*\n'
        '*Drafting notes are excluded. Regenerate with `python paper/assemble.py`.*\n\n'
        '---\n\n' % (TITLE, SUBTITLE)
    )
    out = os.path.join(HERE, 'PAPER.md')
    io.open(out, 'w', encoding='utf-8', newline='').write(
        header + '\n\n'.join(parts) + '\n')

    print('%-34s %6s %7s' % ('SECTION FILE', 'PROSE', 'TABLES'))
    for fn, words, tables in rows:
        print('%-34s %6d %7d' % (fn, words, tables))
    print('-' * 49)
    print('%-34s %6d %7d' % ('TOTAL', prose_total, table_total))
    print()
    numbered = [f for f in files if not f.startswith('00-')]
    print('%d of 19 numbered sections written, plus the abstract.'
          % len(numbered))
    print('Prose: %d words in %d tables/figures.' % (prose_total, table_total))


if __name__ == '__main__':
    main()
