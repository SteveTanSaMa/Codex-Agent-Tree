#!/usr/bin/env python3
"""Launch three isolated native CLI stress environments; measure, never assume, target rate."""
import argparse, datetime, hashlib, json, os, shutil, subprocess, sys
from pathlib import Path
PROFILES = ('normal', 'recovery', 'conflict')
FILES = ('runner.mjs', 'watchdog.py', 'quiescence.mjs', 'fs-metrics.mjs')
def main():
    p=argparse.ArgumentParser()
    p.add_argument('--skill',required=True);p.add_argument('--executable',required=True)
    p.add_argument('--smoke',action='store_true')
    a=p.parse_args(); assert sys.platform=='darwin'
    source=Path(__file__).resolve().parent; root=source.parents[1]; artifacts=root/'.artifacts/soak'
    artifacts.mkdir(parents=True,exist_ok=True)
    hashes={n:hashlib.sha256((source/n).read_bytes()).hexdigest() for n in FILES}
    skill=Path(a.skill).resolve();exe=Path(a.executable).resolve();node=shutil.which('node')
    assert (skill/'scripts/cat.mjs').is_file() and exe.is_file() and node
    payload={str(f.relative_to(skill)):hashlib.sha256(f.read_bytes()).hexdigest() for f in [*sorted((skill/'src').rglob('*.ts')), skill/'scripts/cat.mjs',skill/'package.json']}
    if not a.smoke:
        old=json.loads((artifacts/'dense-smoke-latest.json').read_text())
        assert old['harnessHashes']==hashes and old['runtimePayload']==payload, 'matching harness and Runtime smoke required'
        for lane in old['runs']:
            r=Path(lane['runDir']);v=json.loads((r/'result.json').read_text());w=json.loads((r/'watchdog-result.json').read_text())
            assert v['phase']=='completed' and not v.get('failure') and w['runnerExitCode']==0 and not w['forcedDeadline'],lane
            if lane['profile']=='recovery': assert any(c['kind']=='calibration.recovery.pass' for c in v['checkpoints'])
            if lane['profile']=='conflict': assert v['expectedConflictRejections']>0
    assert shutil.disk_usage('/tmp').free>12*1024**3, '12 GiB free required'
    stamp=datetime.datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')
    suite=artifacts/(('dense-smoke-' if a.smoke else 'dense-hour-')+stamp);suite.mkdir(mode=0o700)
    duration=300 if a.smoke else 3600
    manifest=dict(suiteDir=str(suite),durationSeconds=duration,targetRoundsPerMinutePerTeam=200,minimumCompletedRounds=1001,smoke=a.smoke,harnessHashes=hashes,runtimePayload=payload,sourceCommit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),skill=str(skill),executable=str(exe),runs=[])
    # Every process has its own fresh state/home/workspace and OS-assigned loopback port.
    for profile in PROFILES:
        r=suite/profile;r.mkdir();f=r/'harness';f.mkdir()
        for n in FILES:shutil.copyfile(source/n,f/n)
        base='/tmp/cat-soak-'+os.urandom(4).hex()
        cmd=[sys.executable,str(f/'watchdog.py'),'--run-dir',str(r),'--base',base,'--skill',str(skill),'--executable',str(exe),'--node',node,'--duration-seconds',str(duration),'--dense','--profile',profile]
        with (r/'watchdog.log').open('w') as log:
            child=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        manifest['runs'].append(dict(profile=profile,runDir=str(r),base=base,watchdogPid=child.pid))
    (suite/'launch.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (artifacts/('dense-smoke-latest.json' if a.smoke else 'dense-active.json')).write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
if __name__=='__main__':main()
