#!/usr/bin/env python3
"""Scan SQL writes per owned table across the repo; emit writer report JSON.

Usage: python3 tests/architecture/scan-writers.py
Output: tests/architecture/writer-report.json
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "tests/architecture/write-ownership.manifest.json").read_text())
TABLES = sorted({t for tables in MANIFEST["owners"].values() for t in tables})

WRITE_RE = re.compile(
    r"\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_]\w*)",
    re.IGNORECASE,
)
DDL_RE = re.compile(r"\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b", re.IGNORECASE)

SCAN_DIRS = ["src", "app", "tests"]
SKIP_DIRS = {"node_modules", ".next", "__pycache__"}


def scan_file(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="ignore")
    writes = sorted({m.group(1) for m in WRITE_RE.finditer(text)} & set(TABLES))
    return {"writes": writes, "ddl": bool(DDL_RE.search(text))}


def main() -> None:
    by_table: dict[str, list[str]] = {t: [] for t in TABLES}
    ddl_files: list[str] = []
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix not in {".ts", ".tsx", ".py", ".mjs"}:
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            rel = path.relative_to(ROOT).as_posix()
            result = scan_file(path)
            for table in result["writes"]:
                by_table[table].append(rel)
            if result["ddl"]:
                ddl_files.append(rel)

    unknown_tables = [t for t in TABLES if not by_table[t]]
    report = {
        "date": MANIFEST["date"],
        "tables": len(TABLES),
        "by_table": {t: sorted(files) for t, files in by_table.items()},
        "ddl_files": ddl_files,
        "tables_without_writers": unknown_tables,
    }
    out = ROOT / "tests/architecture/writer-report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    multi = {t: f for t, f in by_table.items() if len(f) > 1}
    print(f"tables: {len(TABLES)}; tables with >1 writer file: {len(multi)}; no writers: {len(unknown_tables)}")
    print(f"ddl files: {ddl_files}")


if __name__ == "__main__":
    main()
