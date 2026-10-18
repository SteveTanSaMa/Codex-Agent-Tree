import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSchemas,
  qualifyCodex,
} from "../../src/runtime/codex/compatibility.ts";
// Compact contract excerpt of the actual experimental 0.162 schema; descriptions
// and unrelated definitions are removed. Native runs verify the actual schemas.
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("../fixtures/capability-schema.json", import.meta.url),
      "utf8",
    ),
  );
test("capability admission accepts additive protocol fields without release or hash allowlists", () => {
  const schema = fixture();
  assert.ok(inspectSchemas(schema).length > 50);
  schema["v2/ThreadStartParams"].properties.futureOptionalField = {
    type: "string",
  };
  assert.doesNotThrow(() => inspectSchemas(schema));
});
for (const [label, change, message] of [
  [
    "missing tools",
    (s: any) => delete s["v2/ThreadStartParams"].properties.dynamicTools,
    /dynamicTools/,
  ],
  [
    "new mandatory input",
    (s: any) => s["v2/TurnStartParams"].required.push("futureMandatory"),
    /unsupplied/,
  ],
  [
    "missing interrupt state",
    (s: any) =>
      s["v2/ThreadReadResponse"].definitions.Turn.properties.status.enum.pop(),
    /interrupted/,
  ],
  [
    "changed identity type",
    (s: any) => {
      s.DynamicToolCallParams.properties.threadId = { type: "integer" };
    },
    /threadId:string/,
  ],
  [
    "incompatible history enum",
    (s: any) => {
      s["v2/ThreadStartParams"].properties.historyMode = {
        type: "string",
        enum: ["future-only"],
      };
    },
    /adapter-payload/,
  ],
  [
    "incompatible input type",
    (s: any) => {
      s["v2/TurnStartParams"].properties.input = { type: "string" };
    },
    /adapter-payload/,
  ],
  [
    "missing steer method",
    (s: any) => {
      s.ClientRequest.oneOf = s.ClientRequest.oneOf.filter(
        (x: any) => !x.properties.method.enum.includes("turn/steer"),
      );
    },
    /turn\/steer/,
  ],
] as const)
  test(`capability admission rejects ${label} with a concrete reason`, () => {
    const schema = fixture();
    change(schema);
    assert.throws(() => inspectSchemas(schema), message);
  });
test(
  "credential-free CLI probe admits unfamiliar version strings when the same contract is available",
  { skip: process.platform === "win32" },
  () => {
    const base = mkdtempSync(join(tmpdir(), "cat-capability-cli-"));
    try {
      const schema = fixture();
      const results = ["codex-cli 0.162.0-alpha.17.2", "codex-cli 999.0.0"].map(
        (version, n) => {
          const cli = join(base, `fixture cli ${n}.mjs`);
          writeFileSync(
            cli,
            `#!${process.execPath}\nimport{mkdirSync,writeFileSync}from'node:fs';import{join,dirname}from'node:path';if(process.argv.includes('--version'))console.log(${JSON.stringify(version)});else{const out=process.argv[process.argv.indexOf('--out')+1];for(const[name,schema]of Object.entries(${JSON.stringify(schema)})){const p=join(out,name+'.json');mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(schema));}}`,
          );
          chmodSync(cli, 0o700);
          return qualifyCodex(cli);
        },
      );
      assert.notEqual(results[0]!.cliVersion, results[1]!.cliVersion);
      assert.equal(results[0]!.contractHash, results[1]!.contractHash);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
