#!/usr/bin/env python3
"""Aggregate ROW lines from a calibration run, joined to the corpus, into a full report."""
import json, os, sys, collections

ROWS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/fear_rows.txt'
CORPUS = os.path.join(os.path.dirname(__file__), 'fearometer-corpus.json')
LIMIT = 70

corpus = json.load(open(CORPUS, encoding='utf-8'))
rows = []
for ln in open(ROWS, encoding='utf-8', errors='replace'):
    if not ln.startswith('ROW\t'):
        continue
    p = ln.rstrip('\n').split('\t')
    if len(p) < 8:
        continue
    idx, cat, lang, score, exp, pred, ok = int(p[1]), p[2], p[3], int(p[4]), int(p[5]), int(p[6]), int(p[7])
    reason = p[8] if len(p) > 8 else ''
    rows.append(dict(idx=idx, cat=cat, lang=lang, score=score, exp=exp, pred=pred, ok=ok, reason=reason))

tp=fp=fn=tn=nulls=0
maxNeg=-1; minPos=101
cat_stat = collections.defaultdict(lambda:[0,0])  # cat -> [correct,total]
errs=[]; near=[]
seen=set()
for r in rows:
    if r['idx'] in seen:  # de-dup if a slice was double-run
        continue
    seen.add(r['idx'])
    if r['score'] == -1 or r['pred'] == -1:
        nulls += 1; continue
    exp=bool(r['exp']); pred=bool(r['pred'])
    if pred and exp: tp+=1
    elif pred and not exp: fp+=1
    elif (not pred) and exp: fn+=1
    else: tn+=1
    cat_stat[r['cat']][1]+=1
    cat_stat[r['cat']][0]+= 1 if r['ok'] else 0
    if exp: minPos=min(minPos,r['score'])
    else: maxNeg=max(maxNeg,r['score'])
    if abs(r['score']-LIMIT)<=12: near.append(r)
    if not r['ok']:
        c = corpus[r['idx']] if r['idx']<len(corpus) else {}
        errs.append((r,c))

tot=tp+fp+fn+tn
prec = tp/(tp+fp) if (tp+fp) else 1.0
rec  = tp/(tp+fn) if (tp+fn) else 1.0
f1   = 2*prec*rec/(prec+rec) if (prec+rec) else 0.0
acc  = (tp+tn)/tot if tot else 0.0
print(f'scored={tot}  nulls={nulls}  TP={tp} FP={fp} FN={fn} TN={tn}')
print(f'accuracy={acc*100:.1f}%  precision={prec:.3f}  recall={rec:.3f}  F1={f1:.3f}')
print(f'MARGIN: highest legit(neg) score={maxNeg}  lowest hateful(pos) score={minPos}  gap={minPos-maxNeg} (threshold {LIMIT})')
print('\nPER-CATEGORY (correct/total):')
for k in sorted(cat_stat):
    c,t=cat_stat[k]; flag='' if c==t else '   <-- ERRORS'
    print(f'  {k:26s} {c:3d}/{t:3d}{flag}')

print(f'\nFALSE POSITIVES (legit flagged) — {fp}:')
for r,c in errs:
    if r['exp']==0 and r['pred']==1:
        print('  [%s/%s] score=%d :: %r' % (r['cat'], r['lang'], r['score'], c.get('text','')[:100]))
        print('      gold-note: %s | model: %s' % (c.get('note',''), r['reason']))
print(f'\nFALSE NEGATIVES (hate missed) — {fn}:')
for r,c in errs:
    if r['exp']==1 and r['pred']==0:
        print('  [%s/%s] score=%d :: %r' % (r['cat'], r['lang'], r['score'], c.get('text','')[:100]))
        print('      gold-note: %s | model: %s' % (c.get('note',''), r['reason']))
print(f'\nNEAR BOUNDARY (|score-{LIMIT}|<=12) — {len(near)}:')
for r in sorted(near,key=lambda x:x['score']):
    c=corpus[r['idx']] if r['idx']<len(corpus) else {}
    tag='ok' if r['ok'] else 'XX'
    print('  %s score=%d exp=%s [%s/%s] :: %r' % (tag, r['score'], 'FL' if r['exp'] else 'ok', r['cat'], r['lang'], c.get('text','')[:75]))
