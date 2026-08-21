"""Check that every shipped Time component declares the same version.

The release is assembled from four independently versioned components.  This
check intentionally uses only Python's standard library so it can run before
dependencies are installed and from both CI and the publication script.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
import tomllib
from pathlib import Path
from typing import Any


class VersionParityError(ValueError):
    """A declaration is missing, malformed, or disagrees with another one."""


DECLARATION_PATHS = {
    "tauri.conf.json": Path("dashboard") / "src-tauri" / "tauri.conf.json",
    "Cargo.toml": Path("dashboard") / "src-tauri" / "Cargo.toml",
    "package.json": Path("dashboard") / "package.json",
    "tracker/config.py": Path("tracker") / "config.py",
}


def _read(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise VersionParityError(f"{label} is missing: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise VersionParityError(f"{label} could not be read: {path}: {exc}") from exc


def _version(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise VersionParityError(
            f"{label} declares an invalid version; expected a non-empty string"
        )
    return value


def _json_version(path: Path, label: str) -> str:
    try:
        document = json.loads(_read(path, label))
    except json.JSONDecodeError as exc:
        raise VersionParityError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(document, dict) or "version" not in document:
        raise VersionParityError(f"{label} has no top-level version declaration")
    return _version(document["version"], f"{label} version")


def _cargo_version(path: Path) -> str:
    label = "dashboard/src-tauri/Cargo.toml"
    try:
        document = tomllib.loads(_read(path, label))
    except tomllib.TOMLDecodeError as exc:
        raise VersionParityError(f"{label} is not valid TOML: {exc}") from exc
    package = document.get("package") if isinstance(document, dict) else None
    if not isinstance(package, dict) or "version" not in package:
        raise VersionParityError(f"{label} has no [package] version declaration")
    return _version(package["version"], f"{label} [package].version")


def _tracker_version(path: Path) -> str:
    label = "tracker/config.py"
    try:
        tree = ast.parse(_read(path, label), filename=str(path))
    except SyntaxError as exc:
        raise VersionParityError(f"{label} is not valid Python: {exc}") from exc

    declarations: list[ast.expr] = []
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            if any(
                isinstance(target, ast.Name) and target.id == "TRACKER_VERSION"
                for target in statement.targets
            ):
                declarations.append(statement.value)
        elif (
            isinstance(statement, ast.AnnAssign)
            and isinstance(statement.target, ast.Name)
            and statement.target.id == "TRACKER_VERSION"
        ):
            declarations.append(statement.value)

    if len(declarations) != 1:
        raise VersionParityError(
            f"{label} must contain exactly one top-level TRACKER_VERSION declaration"
        )
    value = declarations[0]
    if not isinstance(value, ast.Constant):
        raise VersionParityError(
            f"{label} TRACKER_VERSION must be a literal string"
        )
    return _version(value.value, f"{label} TRACKER_VERSION")


def read_versions(root: Path) -> dict[str, str]:
    """Read all four declarations below *root*, or raise a clear error."""

    return {
        "tauri.conf.json": _json_version(
            root / DECLARATION_PATHS["tauri.conf.json"],
            "dashboard/src-tauri/tauri.conf.json",
        ),
        "Cargo.toml": _cargo_version(root / DECLARATION_PATHS["Cargo.toml"]),
        "package.json": _json_version(
            root / DECLARATION_PATHS["package.json"], "dashboard/package.json"
        ),
        "tracker/config.py": _tracker_version(
            root / DECLARATION_PATHS["tracker/config.py"]
        ),
    }


def check_versions(root: Path) -> str:
    versions = read_versions(root)
    unique = set(versions.values())
    if len(unique) != 1:
        details = ", ".join(f"{name}={value}" for name, value in versions.items())
        raise VersionParityError(f"version declarations disagree: {details}")
    return next(iter(unique))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check parity across Time's shipped version declarations."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (defaults to the checkout containing this script)",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        version = check_versions(root)
    except VersionParityError as exc:
        print(f"Version parity failed: {exc}", file=sys.stderr)
        return 1
    print(f"Version parity OK: all four declarations are {version}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
