"""Read-only consistency check for the suite's stable release metadata."""
from __future__ import annotations

import ast
from datetime import date
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
STABLE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")


def text(root: Path, name: str) -> str:
    return (root / name).read_text(encoding="utf-8-sig")


def one(values, label):
    if len(values) != 1:
        raise ValueError(f"{label}: expected one value, found {len(values)}")
    return values[0]


def inspect_versions(root: Path = ROOT) -> tuple[str, dict[str, str]]:
    tree = ast.parse(text(root, "local_app/config.py"))
    canonical = one([ast.literal_eval(node.value) for node in tree.body
                     if isinstance(node, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "VERSION" for t in node.targets)],
                    "local_app/config.py:VERSION")
    if not isinstance(canonical, str) or not STABLE.fullmatch(canonical):
        raise ValueError("VERSION must be a stable MAJOR.MINOR.PATCH without leading zeros")
    package = json.loads(text(root, "package.json"))
    lock = json.loads(text(root, "package-lock.json"))
    versions = {
        "pyproject.toml:project.version": tomllib.loads(text(root, "pyproject.toml"))["project"]["version"],
        "package.json:version": package["version"],
        "package-lock.json:version": lock["version"],
        'package-lock.json:packages[""].version': lock["packages"][""]["version"],
    }
    nodes = list(ast.walk(ast.parse(text(root, "local_app/packaging/version-info.txt"))))
    fixed = one([node for node in nodes if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == "FixedFileInfo"], "FixedFileInfo")
    for name in ["filevers", "prodvers"]:
        value = ast.literal_eval(one([k.value for k in fixed.keywords if k.arg == name], name))
        if not isinstance(value, tuple) or len(value) != 4 or any(type(n) is not int for n in value):
            raise ValueError(f"{name}: expected a four-integer tuple")
        versions[f"Windows:{name}"] = ".".join(map(str, value))
    for name in ["FileVersion", "ProductVersion"]:
        versions[f"Windows:{name}"] = one([ast.literal_eval(node.args[1]) for node in nodes
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "StringStruct" and len(node.args) == 2
            and ast.literal_eval(node.args[0]) == name], name)
    versions["README.md:current"] = one(re.findall(r"^현재 버전: \*\*([^*]+)\*\*", text(root, "README.md"), re.M), "README current version")
    headings = re.findall(r"^## \[([^\]]+)\](?: - ([^\r\n]+))?$", text(root, "CHANGELOG.md"), re.M)
    releases = [(version, day) for version, day in headings if version != "Unreleased"]
    if not releases:
        raise ValueError("CHANGELOG.md: no release entry")
    seen = set()
    for version, day in releases:
        if not STABLE.fullmatch(version) or version in seen:
            raise ValueError(f"CHANGELOG.md: invalid or duplicate release {version!r}")
        seen.add(version)
        date.fromisoformat(day)
    versions["CHANGELOG.md:latest"] = releases[0][0]
    return canonical, versions


def check(root: Path = ROOT) -> tuple[str, list[str]]:
    canonical, versions = inspect_versions(root)
    errors = []
    for name, actual in versions.items():
        expected = canonical + ".0" if name in {"Windows:filevers", "Windows:prodvers"} else canonical
        if actual != expected:
            errors.append(f"{name}: {actual!r}; expected {expected!r}")
    return canonical, errors


def main() -> int:
    try:
        version, errors = check()
    except (OSError, ValueError, TypeError, KeyError, SyntaxError) as error:
        print(f"FAIL: release metadata: {error}", file=sys.stderr)
        return 1
    if errors:
        print("FAIL: release versions disagree:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(f"OK: BDO Suite {version}; Python, Node, Windows, README and changelog agree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
