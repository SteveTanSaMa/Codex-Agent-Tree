#!/usr/bin/env python3
"""Detached, bounded owner of one soak runner; cleans only its recorded test homes."""
import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--run-dir', required=True)
parser.add_argument('--base', required=True)
parser.add_argument('--skill', required=True)
parser.add_argument('--executable', required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--duration-seconds', type=int, required=True)
parser.add_argument('--smoke', action='store_true')
args = parser.parse_args()
run = Path(args.run_dir).resolve()
assert run.is_dir() and not (run / 'watchdog.json').exists()
base = Path(args.base)
assert str(base).startswith('/tmp/cat-soak-') and not base.exists()
runner = Path(__file__).with_name('runner.mjs').resolve()
command = [args.node, str(runner), '--run-dir', str(run), '--base', str(base), '--skill', args.skill,
           '--executable', args.executable, '--duration-seconds', str(args.duration_seconds)]
if args.smoke:
    command.append('--smoke')
with (run / 'runner.log').open('w') as log:
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
awake = subprocess.Popen(['/usr/bin/caffeinate', '-i', '-w', str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
start = time.time()
deadline = start + args.duration_seconds + (90 if args.smoke else 900)
(run / 'watchdog.json').write_text(json.dumps({'pid': os.getpid(), 'runnerPid': child.pid,
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'hardDeadline': datetime.datetime.fromtimestamp(deadline,datetime.timezone.utc).isoformat(),
    'durationSeconds':args.duration_seconds, 'smoke':args.smoke}, indent=2)+'\n')
forced = False
try:
    while child.poll() is None and time.time() < deadline:
        time.sleep(2)
    if child.poll() is None:
        forced = True
        os.killpg(child.pid,signal.SIGTERM)
        try:
            child.wait(50)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGKILL)
            child.wait(5)
finally:
    # The manifest must belong to this child and the fresh test directory.
    manifest = run / 'ownership.json'
    if manifest.exists():
        owner = json.loads(manifest.read_text())
        assert owner['runnerPid'] == child.pid and owner['base'] == str(base)
        status_path=run/'status.json'
        status=json.loads(status_path.read_text()) if status_path.exists() else {}
        for lane in owner['paths'].values():
            state, home = Path(lane['state']), Path(lane['home'])
            assert state.parent == base and home.parent == base
            if (state / 'control.sock').exists():
                for action in [['control', '--target', status.get('identities',{}).get('lead' if state.name=='s' else 'calibrator',''), '--action','pause','--immediate'], ['stop']]:
                    try:
                        subprocess.run([args.node,str(Path(args.skill)/'scripts/cat.mjs'),*action,'--state',str(state)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=40)
                    except (subprocess.TimeoutExpired, FileNotFoundError):
                        pass
            if home.exists():
                env={'PATH':os.environ.get('PATH',''),'HOME':os.environ['HOME'],'CODEX_HOME':str(home)}
                try:
                    subprocess.run([args.executable,'app-server','daemon','stop'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=25)
                except subprocess.TimeoutExpired:
                    pass
    awake.terminate()
    result = {'runnerExitCode':child.poll(),'forcedDeadline':forced,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (run/'watchdog-result.json').write_text(json.dumps(result,indent=2)+'\n')
    if not (run/'result.json').exists():
        (run/'result.json').write_text(json.dumps({'phase':'failed','failure':'Runner exited without final report','watchdog':result},indent=2)+'\n')
