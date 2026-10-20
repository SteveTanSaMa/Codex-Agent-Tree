#!/usr/bin/env python3
"""Create a deterministic, self-contained skill archive without local state."""
import hashlib
import json
from pathlib import Path
import zipfile
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
OUTPUT = ROOT / "dist" / f"codex-agent-tree-{VERSION}.zip"
FILES = [
    "SKILL.md", "agents/openai.yaml", "scripts/cat.mjs",
    "references/operations.md", "references/coding.md", "package.json", "package-lock.json",
    "docs/engineering-improvements.md", "docs/interactive-control.md", "docs/token-reminders.md", "docs/upgrade-validation.md",
    "LICENSE", "NOTICE",
]
FILES += [str(p.relative_to(ROOT)) for p in (ROOT / "src").rglob("*.ts") if p.is_file()]
FILES += [f"src/runtime/codex/vendor/{name}" for name in ("LICENSE", "NOTICE", "README.md")]
OUTPUT.parent.mkdir(exist_ok=True)
with NamedTemporaryFile(dir=OUTPUT.parent, prefix=".skill-", suffix=".zip", delete=False) as temp:
    temporary = Path(temp.name)
try:
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(FILES):
            if (ROOT / name).is_symlink():
                raise ValueError(f"Distribution inputs cannot be symlinks: {name}")
            info = zipfile.ZipInfo(f"codex-agent-tree/{name}", (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())
    temporary.replace(OUTPUT)
finally:
    temporary.unlink(missing_ok=True)
digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix(".zip.sha256").write_text(f"{digest}  {OUTPUT.name}\n")
print(f"{OUTPUT}\nsha256: {digest}")
