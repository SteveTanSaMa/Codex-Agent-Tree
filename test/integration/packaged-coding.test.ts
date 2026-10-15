import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);
test("fresh Skill ZIP contains its sandbox supervisor and runs coding tools outside checkout", async () => {
  const dir = mkdtempSync("/tmp/cat-packaged-code-");
  try {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    await execute("python3", ["scripts/package-skill.py"]);
    await execute("python3", [
      "-m",
      "zipfile",
      "-e",
      join(process.cwd(), "dist", `codex-agent-tree-${version}.zip`),
      dir,
    ]);
    const module = pathToFileURL(
      join(dir, "codex-agent-tree/src/workspace/broker.ts"),
    ).href;
    const program = `import { WorkspaceBroker, workspacePolicy } from ${JSON.stringify(module)};
import fs from 'node:fs'; import cp from 'node:child_process'; import path from 'node:path';
const base=${JSON.stringify(dir)},repo=path.join(base,'repo'),state=path.join(base,'state');fs.mkdirSync(repo);fs.mkdirSync(state);
const git=(a)=>cp.execFileSync('git',['-C',repo,...a],{stdio:'pipe'});
git(['init']);git(['config','user.name','Package fixture']);git(['config','user.email','fixture@example.invalid']);
fs.writeFileSync(path.join(repo,'value.mjs'),'export const value=0;\\n');fs.writeFileSync(path.join(repo,'verify.mjs'),"import {value} from './value.mjs';if(value!==1)process.exit(1);console.log('PACKAGE_PASS')");git(['add','.']);git(['commit','-m','fixture']);
const policy=workspacePolicy(repo,{unit:{executable:process.execPath,args:['verify.mjs']}}), lead={id:'lead',depth:0},coder={id:'coder',depth:1,parent_id:'lead'};
const broker=new WorkspaceBroker(state,policy,id=>lead);
const old=await broker.call(coder,'read_file',{path:'value.mjs'});
await broker.call(coder,'write_file',{path:'value.mjs',expectedHash:old.hash,content:'export const value=1;\\n'});
const test=await broker.call(coder,'run_test',{name:'unit'});if(test.exitCode!==0)throw new Error(JSON.stringify(test));
const child=broker.cwd(coder);const result=await broker.call(lead,'terminal',{command:'git -C '+JSON.stringify(child)+' diff --no-ext-diff --no-textconv -- value.mjs | git apply && '+JSON.stringify(process.execPath)+' verify.mjs'});if(result.exitCode!==0)throw new Error(JSON.stringify(result));console.log(result.output);
`;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "-e", program],
      { cwd: dir, timeout: 15000 },
    );
    assert.match(result.stdout, /PACKAGE_PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
