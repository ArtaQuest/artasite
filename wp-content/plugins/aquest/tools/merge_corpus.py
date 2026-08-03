#!/usr/bin/env python3
"""Merge clean-*.json batches into fearometer-corpus.json, dedup by normalized text, report."""
import json, glob, os, re, sys, collections

DIR = os.path.join(os.path.dirname(__file__), 'corpus')
OUT = os.path.join(os.path.dirname(__file__), 'fearometer-corpus.json')

def norm(t): return re.sub(r'\s+', ' ', (t or '').strip().lower())

rows, seen, dupes, bad = [], set(), 0, 0
files = sorted(glob.glob(os.path.join(DIR, 'clean-*.json')))
if not files:
    files = sorted(glob.glob(os.path.join(DIR, 'gen-*.json')))  # fallback if verify stage produced nothing
for f in files:
    try:
        data = json.load(open(f, encoding='utf-8'))
    except Exception as e:
        print(f'!! parse fail {os.path.basename(f)}: {e}', file=sys.stderr); continue
    for r in (data or []):
        if not isinstance(r, dict) or not (r.get('text') or '').strip():
            bad += 1; continue
        k = norm(r['text'])
        if k in seen:
            dupes += 1; continue
        seen.add(k)
        rows.append({
            'category': r.get('category', '?'),
            'lang': r.get('lang', '?'),
            'text': r['text'],
            'flag': bool(r.get('flag', False)),
            'note': r.get('note', ''),
            'band': r.get('band', None),
        })

json.dump(rows, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
pos = sum(1 for r in rows if r['flag']); neg = len(rows) - pos
langs = collections.Counter(r['lang'] for r in rows)
cats = collections.Counter(r['category'] for r in rows)
print(f'files={len(files)}  kept={len(rows)}  pos={pos}  neg={neg}  dupes_dropped={dupes}  bad_dropped={bad}')
print(f'langs({len(langs)}): ' + ', '.join(f'{k}:{v}' for k, v in sorted(langs.items(), key=lambda x:-x[1])))
print('categories:')
for k, v in sorted(cats.items()):
    p = sum(1 for r in rows if r['category'] == k and r['flag'])
    print(f'  {k:24s} n={v:3d}  pos={p:3d} neg={v-p:3d}')
print(f'wrote {OUT}')
