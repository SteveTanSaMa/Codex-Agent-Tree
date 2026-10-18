#!/usr/bin/env python3
"""Summarize measured soak evidence; elapsed time alone never implies a pass."""
import argparse
import json
from pathlib import Path
import statistics
import sqlite3
from urllib.parse import quote

parser=argparse.ArgumentParser()
parser.add_argument('run_dir')
args=parser.parse_args()
run=Path(args.run_dir).resolve()
result=json.loads((run/'result.json').read_text())
cleanup=json.loads((run/'watchdog-result.json').read_text()) if (run/'watchdog-result.json').exists() else None
metrics=[json.loads(l) for l in (run/'metrics.jsonl').read_text().splitlines()] if (run/'metrics.jsonl').exists() else []
flags=[]
if result.get('phase')!='completed':flags.append('runner-failed')
if cleanup is None or cleanup.get('runnerExitCode')!=0 or cleanup.get('forcedDeadline'):flags.append('cleanup-or-watchdog-review')
smoke=result.get('smoke',False)
warm=20000 if smoke else 1800000
end=result.get('durationMs',0)
groups={}
for sample in metrics:
    for p in sample.get('processes',[]):
        groups.setdefault(p['lane']+'/'+p['kind']+'/'+str(p['pid']),[]).append((sample['elapsedMs'],p))
resources={}
for key,values in groups.items():
    first=[p for t,p in values if warm<=t<=warm*2]
    last=[p for t,p in values if t>=end-warm]
    rss=[p['rss'] for t,p in values];fds=[p['fdCount'] for t,p in values]
    item={'samples':len(values),'peakRssBytes':max(rss),'peakFds':max(fds)}
    if first and last:
        a=statistics.median(p['rss'] for p in first);b=statistics.median(p['rss'] for p in last)
        f=statistics.median(p['fdCount'] for p in first);g=statistics.median(p['fdCount'] for p in last)
        item.update(firstWindowRss=a,lastWindowRss=b,firstWindowFds=f,lastWindowFds=g)
        if b>a*1.5+64*1024**2:flags.append('rss-growth:'+key)
        if g>f+32:flags.append('fd-growth:'+key)
    resources[key]=item
if metrics:
    gaps=[b['elapsedMs']-a['elapsedMs'] for a,b in zip(metrics,metrics[1:])]
    max_gap=max(gaps,default=0)
    if max_gap>(20000 if smoke else 90000):flags.append('sampling-gap')
    if metrics[0]['elapsedMs']>60000:flags.append('late-first-sample')
    if metrics[-1]['elapsedMs']<end-60000:flags.append('early-last-sample')
else:max_gap=None;flags.append('no-metrics')
expected={'calibration.quiet.pass':1,'calibration.progress.pass':1,'calibration.guidance.pass':1,'calibration.pause.pass':1,'calibration.recovery.pass':3,'native.history.pass':1}
counts={k:sum(e['kind']==k for e in result.get('checkpoints',[])) for k in expected}
for k,n in expected.items():
    if counts[k]!=n:flags.append('checkpoint-count:'+k)
if result.get('elapsedMs',0)<result.get('durationMs',0):flags.append('insufficient-duration')
reminders=[]
for lane,paths in result.get('paths',{}).items():
    try:
        database=sqlite3.connect('file:'+quote(str(Path(paths['state'])/'business.sqlite'))+'?mode=ro',uri=True)
        try:
            if database.execute('PRAGMA integrity_check').fetchone()[0]!='ok':flags.append('integrity:'+lane)
            if database.execute('PRAGMA foreign_key_check').fetchall():flags.append('foreign-keys:'+lane)
            if lane=='calibration':
                reminders=[json.loads(r[0]) for r in database.execute("SELECT body FROM events WHERE kind='usage.reminder' ORDER BY sequence")]
        finally:database.close()
    except (sqlite3.Error,KeyError) as error:flags.append('database-review:'+lane+':'+str(error))
seen=set()
for reminder in reminders:
    if reminder['stopsExecution']:flags.append('reminder-stopped-execution')
    thresholds=range(reminder['firstThreshold'],reminder['lastThreshold']+1,20)
    if len(thresholds)!=reminder['crossedCount']:flags.append('reminder-crossing-count')
    for threshold in thresholds:
        identity=(reminder['targetId'],reminder['metric'],threshold)
        if identity in seen:flags.append('duplicate-reminder')
        seen.add(identity)
if not reminders:flags.append('missing-calibration-reminder')
lat=sorted(result.get('viewLatencyMs',[]))
summary={'runDir':str(run),'smoke':smoke,'outcome':'review-required' if flags else 'passed','flags':flags,
         'elapsedMs':result.get('elapsedMs'),'rounds':result.get('rounds'),'requests':result.get('requests'),
         'maxSamplingGapMs':max_gap,'checkpoints':counts,'resources':resources,
         'viewLatencyMs':{'samples':len(lat),'median':statistics.median(lat) if lat else None,'p95':lat[min(len(lat)-1,int(len(lat)*0.95))] if lat else None},
         'calibrationReminderEvents':len(reminders),'calibrationReminderThresholds':len(seen),
         'failure':result.get('failure')}
(run/'analysis.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
