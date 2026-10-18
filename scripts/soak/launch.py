#!/usr/bin/env python3
"""Start a bounded, frozen soak harness; full runs require a passing matching smoke."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

parser=argparse.ArgumentParser()
parser.add_argument('--skill',required=True)
parser.add_argument('--executable',required=True)
parser.add_argument('--node',default=shutil.which('node'))
parser.add_argument('--hours',type=float,default=9)
parser.add_argument('--smoke',action='store_true')
args=parser.parse_args()
assert sys.platform=='darwin', 'macOS soak only'
assert 8<=args.hours<=10
skill=Path(args.skill).resolve(); executable=Path(args.executable).resolve()
assert (skill/'scripts/cat.mjs').is_file() and executable.is_file()
repo=Path(__file__).resolve().parents[2]
artifacts=repo/'.artifacts/soak';artifacts.mkdir(parents=True,exist_ok=True)
sources={name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ['runner.mjs','watchdog.py']}
if not args.smoke:
    last=json.loads((artifacts/'smoke-latest.json').read_text())
    assert last['harnessHashes']==sources, 'changed harness requires a fresh smoke'
    result=json.loads((Path(last['runDir'])/'result.json').read_text())
    cleanup=json.loads((Path(last['runDir'])/'watchdog-result.json').read_text())
    assert result['phase']=='completed' and not result['failure'] and cleanup['runnerExitCode']==0 and not cleanup['forcedDeadline'], 'smoke and cleanup must pass'
assert shutil.disk_usage('/tmp').free>8*1024**3, 'at least 8 GiB free space required'
stamp=datetime.datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')
run=artifacts/(('smoke-' if args.smoke else 'nine-hour-')+stamp);run.mkdir(mode=0o700)
frozen=run/'harness';frozen.mkdir()
for name in sources:shutil.copyfile(Path(__file__).with_name(name),frozen/name)
base='/tmp/cat-soak-'+os.urandom(4).hex()
duration=300 if args.smoke else round(args.hours*3600)
cmd=[sys.executable,str(frozen/'watchdog.py'),'--run-dir',str(run),'--base',base,'--skill',str(skill),'--executable',str(executable),'--node',str(Path(args.node).resolve()),'--duration-seconds',str(duration)]
if args.smoke:cmd.append('--smoke')
with (run/'watchdog.log').open('w') as log:
    process=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
manifest={'runDir':str(run),'base':base,'watchdogPid':process.pid,'skill':str(skill),'executable':str(executable),'durationSeconds':duration,'harnessHashes':sources,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()}
(run/'launch.json').write_text(json.dumps(manifest,indent=2)+'\n')
(artifacts/('smoke-latest.json' if args.smoke else 'active.json')).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
