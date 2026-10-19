#!/usr/bin/env python3
"""Read-only evidence summary. Native execution correctness and load targets are separate."""
import json, sqlite3, sys
from pathlib import Path

def analyze(suite):
    suite=Path(suite);m=json.loads((suite/'launch.json').read_text());summaries=[]
    for run in m['runs']:
        r=Path(run['runDir']);flags=[]
        if not (r/'result.json').exists() or not (r/'watchdog-result.json').exists():
            summaries.append(dict(profile=run['profile'],outcome='running-or-cleaning'));continue
        v=json.loads((r/'result.json').read_text());w=json.loads((r/'watchdog-result.json').read_text())
        if v['phase']!='completed' or v.get('failure'):flags.append('runner-failed')
        if w['runnerExitCode']!=0 or w['forcedDeadline']:flags.append('cleanup-review')
        if v['elapsedMs']<m['durationSeconds']*1000:flags.append('insufficient-duration')
        checkpoints=[c['kind'] for c in v.get('checkpoints',[])]
        if 'native.history.pass' not in checkpoints:flags.append('history-unverified')
        if run['profile']=='recovery' and 'calibration.recovery.pass' not in checkpoints:flags.append('recovery-unverified')
        if run['profile']=='conflict' and not v.get('expectedConflictRejections'):flags.append('conflict-unverified')
        database={}
        for lane,p in v['paths'].items():
            c=sqlite3.connect('file:'+str(Path(p['state'])/'business.sqlite')+'?mode=ro',uri=True)
            try:
                integrity=c.execute('PRAGMA integrity_check').fetchone()[0]
                fk=c.execute('PRAGMA foreign_key_check').fetchall()
                if integrity!='ok' or fk:flags.append(lane+'-integrity')
                unknown=c.execute("SELECT COUNT(*) FROM turn_attempts WHERE state IN ('prepared','starting','running','unknown')").fetchone()[0]
                if unknown:flags.append(lane+'-unsettled-execution')
                database[lane]=dict(integrity=integrity,tasks=dict(c.execute('SELECT status,COUNT(*) FROM tasks GROUP BY status')),messages=dict(c.execute('SELECT status,COUNT(*) FROM messages GROUP BY status')),operatorMessages=dict(c.execute('SELECT status,COUNT(*) FROM operator_messages GROUP BY status')),attempts=dict(c.execute('SELECT state,COUNT(*) FROM turn_attempts GROUP BY state')))
            finally:c.close()
        completed=v.get('completedRounds',0);rate=completed/(v['elapsedMs']/60000)
        targetFlags=[]
        if not m['smoke']:
            if completed<1001:targetFlags.append('below-1001-rounds')
            if rate<200:targetFlags.append('below-200-rounds-per-minute')
        summaries.append(dict(profile=run['profile'],outcome='review-required' if flags else 'targets-not-met' if targetFlags else 'passed',flags=flags,targetFlags=targetFlags,completedRounds=completed,actualRoundsPerMinute=rate,requests=v['requests'],providerPort=v.get('providerPort'),elapsedMs=v['elapsedMs'],checkpoints=checkpoints,database=database))
    out=dict(smoke=m['smoke'],teams=summaries)
    (suite/'analysis.json').write_text(json.dumps(out,indent=2)+'\n');return out
if __name__=='__main__':print(json.dumps(analyze(sys.argv[1]),indent=2))
