import io, os

PAPER = r'C:\Users\PC\Desktop\Als_Inventory_Software\paper'

ORDER = [
    ('abstract.md',      'Abstract'),
    ('introduction.md',  '1. Introduction'),
    ('the-class.md',     '2. The class'),
    ('context.md',       '3. The system'),
    ('method.md',        '4. Method'),
    ('results.md',       '5. Results'),
    ('recurrence.md',    '6. The recurrence finding'),
    ('the-rule.md',      '7. What to do about it'),
    ('threats.md',       '8. Threats to validity'),
    ('related-work.md',  '9. Related work'),
]

TABLE_CHARGE = 250   # IEEE Software charges 250 words per table or figure


def body_of(path):
    s = io.open(path, encoding='utf-8').read()
    if '\n---\n' in s:
        s = s.split('\n---\n', 1)[1]
    s = s.split('\n---\n')[0]
    s = s.split('## Drafting notes')[0]
    return s.strip()


def measure(text):
    """(prose words, table count). A table is a run of consecutive | lines."""
    prose, tables, in_table = 0, 0, False
    for line in text.splitlines():
        if line.strip().startswith('|'):
            if not in_table:
                tables += 1
                in_table = True
        else:
            in_table = False
            prose += len(line.split())
    return prose, tables


parts, rows = [], []
prose_total = table_total = 0
for fn, title in ORDER:
    p = os.path.join(PAPER, fn)
    if not os.path.exists(p):
        continue
    b = body_of(p)
    w, t = measure(b)
    if fn != 'abstract.md':
        prose_total += w
        table_total += t
    rows.append((title, w, t))
    parts.append('## ' + title + '\n\n' + b)

io.open(os.path.join(PAPER, 'PAPER.md'), 'w', encoding='utf-8', newline='').write(
    '# False absence: a defect class in systems that report on external state\n\n'
    '*Assembled from the section files in this folder \u2014 edit those, not this.*\n'
    '*Drafting notes are excluded. Regenerate with `python paper/assemble.py`.*\n\n'
    + '\n\n'.join(parts) + '\n')

print('%-28s %6s %7s' % ('SECTION', 'PROSE', 'TABLES'))
for t, w, n in rows:
    print('%-28s %6d %7d' % (t, w, n))
print('-' * 43)
charged = prose_total + table_total * TABLE_CHARGE
print('%-28s %6d %7d' % ('BODY', prose_total, table_total))
print()
print('IEEE Software charges %d words per table:' % TABLE_CHARGE)
print('  prose                %6d' % prose_total)
print('  %d tables x %d       %6d' % (table_total, TABLE_CHARGE, table_total * TABLE_CHARGE))
print('  CHARGED TOTAL        %6d   (limit 4200 -> over by %d)' % (charged, charged - 4200))
print()
print('Venues with room for this as written:')
print('  arXiv / Zenodo       no limit')
print('  ICSE SEIP            ~8-10 pp, roughly 6000-8000 words')
print('  ACM Queue            long-form')
