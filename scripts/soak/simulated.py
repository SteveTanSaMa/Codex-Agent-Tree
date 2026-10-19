#!/usr/bin/env python3
"""Run three isolated local simulation processes in parallel, with a bounded deadline."""
import datetime,json,os,subprocess,sys,time,hashlib
from pathlib import Path
rounds=int(sys.argv[1]) if len(sys.argv)>1 else 1000
assert 1<=rounds<=1000
root=Path(__file__).resolve().parents[2]
suite=root/'.artifacts/soak'/('simulated-'+str(rounds)+'-'+datetime.datetime.now().astimezone().strftime('%Y%m%d-%H%M%S'))
suite.mkdir(parents=True)
children=[]
for profile in ['normal','recovery','conflict']:
 r=suite/profile;r.mkdir();log=(r/'runner.log').open('w')
 p=subprocess.Popen(['node',str(root/'scripts/soak/simulated.mjs'),str(r),profile,str(rounds)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 children.append((profile,r,p,log))
(suite/'launch.json').write_text(json.dumps(dict(suiteDir=str(suite),nativeCliUsed=False,roundsPerTeam=rounds,sourceCommit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),sourceHashes={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'scripts/soak/simulated.mjs',root/'src/coordinator/coordinator.ts',root/'test/fixtures/controlled-runtime.ts']},runs=[dict(profile=n,runDir=str(r),pid=p.pid) for n,r,p,l in children]),indent=2)+'\n')
print(suite,flush=True)
deadline=time.time()+1800
try:
 while any(p.poll() is None for n,r,p,l in children) and time.time()<deadline:time.sleep(1)
finally:
 for n,r,p,l in children:
  if p.poll() is None:
   p.terminate()
   try:p.wait(45)
   except subprocess.TimeoutExpired:p.kill();p.wait()
  l.close()
 result=[dict(profile=n,exitCode=p.returncode,result=json.loads((r/'result.json').read_text()) if (r/'result.json').exists() else None,cleanup=(r/'cleanup.json').exists()) for n,r,p,l in children]
 (suite/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result),flush=True)

sys.exit(0 if all(v['exitCode']==0 and v['cleanup'] and v['result'] and v['result']['completedRounds']==rounds for v in result) else 1)
