"""Read-only audit of synthetic follow-up evidence; never starts a Runtime."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("evidence", type=Path)
args = parser.parse_args()
root = args.evidence.resolve()
report = {"origin": "independent read-only SQLite, native history and rollout audit", "scenarios": {}, "errors": []}

def require(value, text):
    if not value:
        report["errors"].append(text)

for identity_file in (root / "real").glob("*/identity.json"):
    identity = json.loads(identity_file.read_text())
    name = identity_file.parent.name
    db = sqlite3.connect("file:" + str(Path(identity["state"]) / "business.sqlite") + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    agents = [dict(x) for x in db.execute("select * from agents")]
    attempts = [dict(x) for x in db.execute("select * from turn_attempts")]
    native = json.loads((identity_file.parent / "native-history.json").read_text())
    ledger = [dict(x) for x in db.execute("select * from attempt_accounting")]
    native_ids = []
    spans = []
    functions = {}
    selected_reads = []
    for h in native:
        agent = next(a for a in agents if a["id"] == h["agentId"])
        thread = h["history"]["thread"]
        require(thread["id"] == next(x["thread_id"] for x in attempts if x["agent_id"] == agent["id"]), name + ": thread identity")
        agent_spans = []
        for turn in thread["turns"]:
            native_ids.append(turn["id"])
            require(turn["status"] in ("completed", "failed", "interrupted"), name + ": live native Turn left")
            if turn["startedAt"] is not None and turn["completedAt"] is not None:
                agent_spans.append((turn["startedAt"], turn["completedAt"]))
                spans.extend([(turn["startedAt"], 1), (turn["completedAt"], -1)])
        agent_spans.sort()
        require(all(a[1] <= b[0] for a, b in zip(agent_spans, agent_spans[1:])), name + ": overlapping Native Turns for one Agent")
        records = [json.loads(line) for line in Path(thread["path"]).read_text().splitlines()]
        calls = [r["payload"] for r in records if r["type"] == "response_item" and r["payload"].get("type") == "function_call"]
        outputs = {r["payload"]["call_id"]: r["payload"]["output"] for r in records if r["type"] == "response_item" and r["payload"].get("type") == "function_call_output"}
        functions[agent["id"]] = dict(collections.Counter(c["name"] for c in calls))
        if name == "multi-repository" and agent["depth"] == 1:
            allowed = "add.mjs" if agent["name"] == "CoreCoder" else "format.mjs"
            writes = [json.loads(c["arguments"]) for c in calls if c["name"] == "write_file"]
            require(bool(writes) and all(w["path"] == allowed for w in writes), name + ": child changed files outside its module")
        if agent["depth"] > 0:
            require(not any(c["name"] in ("terminal", "exec_command", "shell") for c in calls), name + ": descendant terminal call")
        if agent["depth"] == 2:
            require(not any(c["name"] in ("write_file", "run_test") for c in calls), name + ": L3 mutating/test call")
            for c in calls:
                if c["name"] != "read_file":
                    continue
                call = json.loads(c["arguments"])
                result = json.loads(outputs[c["call_id"]])
                require("content" in result, "L3 read did not produce actual content")
                require(hashlib.sha256(result["content"].encode()).hexdigest() == result["hash"], "L3 read hash mismatch")
                selected_reads.append({"repositoryId": call.get("repositoryId", "app"), "path": call["path"], "contentSha256": result["hash"]})
    expected = {x["turn_id"] for x in attempts}
    require(None not in expected and set(native_ids) == expected, name + ": native/business Turn IDs mismatch")
    require(len(native_ids) == len(expected) == len(attempts), name + ": duplicate native dispatch")
    require(len(attempts) <= identity["maximumTurns"], name + ": Turn ceiling exceeded")
    active = peak = 0
    for _, delta in sorted(spans):
        active += delta
        peak = max(peak, active)
    require(peak <= 3, name + ": concurrency ceiling")
    messages = [dict(x) for x in db.execute("select id,sender_id,recipient_id,status from messages")]
    operator_status = dict(db.execute("select status,count(*) from operator_messages group by status").fetchall())
    require(not any(x["status"] in ("queued", "delivering", "acknowledged") for x in messages), name + ": pending Agent messages")
    require(not any(x in operator_status for x in ("queued", "delivering", "acknowledged")), name + ": pending human messages")
    require(db.execute("pragma integrity_check").fetchone()[0] == "ok", name + ": SQLite integrity")
    require(not db.execute("pragma foreign_key_check").fetchall(), name + ": foreign keys")
    pids = [x[0] for x in db.execute("select distinct native_pid from runtime_connections where native_pid is not null")]
    for pid in pids:
        require(subprocess.run(["ps", "-p", str(pid), "-o", "pid="], capture_output=True).returncode != 0, name + ": recorded native PID still alive (inspect identity if reused)")
    if name == "multi-repository":
        reviewer = next(a for a in agents if a["depth"] == 2)
        app = next(a for a in agents if a["id"] == reviewer["parent_id"])
        lead = next(a for a in agents if a["depth"] == 0)
        core = next(a for a in agents if a["depth"] == 1 and a["id"] != app["id"])
        require({(m["sender_id"], m["recipient_id"]) for m in messages} == {(core["id"], lead["id"]), (reviewer["id"], app["id"]), (app["id"], lead["id"])}, "multi-repository: wrong report routes")
        require(all(m["status"] == "processed" for m in messages), "multi-repository: unprocessed reports")
        require({(r["repositoryId"], r["path"]) for r in selected_reads} == {("app", "format.mjs"), ("core", "add.mjs")}, "review did not read both intended source files")
    report["scenarios"][name] = {"agents": len(agents), "turns": len(attempts), "states": dict(collections.Counter(a["state"] for a in attempts)), "observedPeakNativeConcurrency": peak, "nativeIdsExactlyMatch": True, "observedTokensIncludingPartial": sum(x["observed"] for x in attempts), "nonFinalUsage": [{"attemptId": x["attempt_id"], "observedPartial": x["charged"], "source": x["source"]} for x in ledger if not x["finalized"]], "toolCalls": functions, "reviewedSourceHashes": selected_reads, "messages": dict(collections.Counter(x["status"] for x in messages)), "operatorMessages": operator_status, "sqliteIntegrity": "ok", "ownedNativePidsAbsent": True}
    db.close()
for path, digest in json.loads((root / "existing-config-baseline.json").read_text()).items():
    require(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, "existing config modified: " + path)
report["existingConfigsUnchanged"] = not any("existing config" in e for e in report["errors"])
report["totalRealTurns"] = sum(s["turns"] for s in report["scenarios"].values())
require(report["totalRealTurns"] <= 13, "global real Turn ceiling")
report["passed"] = not report["errors"]
(root / "independent-audit.json").write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != "scenarios"}, indent=2))
raise SystemExit(0 if report["passed"] else 1)
