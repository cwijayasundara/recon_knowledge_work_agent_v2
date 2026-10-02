"""Recipes: small Python modules that turn one upload layout into the canonical table.

A recipe module defines ``RECIPE`` (entity, sdk, summary, bindings) and
``prepare(wb) -> AffiliateCanonical``. ``standard`` writes one for simple
single-table layouts without a model; ``check`` is the gate every recipe,
generated or authored, must pass before it runs on real data.

Usage:
    python -m onboarding_sdk.recipes check <recipe.py> <upload>
    python -m onboarding_sdk.recipes run <recipe.py> <upload>    # canonical table as JSON
"""

from __future__ import annotations

import ast
import hashlib
import json
import sys
import types
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol, cast

from . import __version__
from . import read as read_module
from .canonical import AffiliateCanonical

# The SDK is importable only through these names: its modules also hold
# references to sys, builtins and friends that a recipe must not reach.
SDK_EXPORTS = {
    "onboarding_sdk.read": frozenset({"Workbook", "Sheet", "Table", "RowView", "Value", "text"}),
    "onboarding_sdk.canonical": frozenset({"AffiliateCanonical", "AffiliateRow", "Dropped", "from_table"}),
}
ALLOWED_IMPORTS = frozenset(
    {
        "__future__",
        "re",
        "datetime",
        "polars",
        "math",
        "decimal",
        "string",
        "itertools",
        "functools",
        "collections",
        "typing",
        "dataclasses",
        "unicodedata",
        "enum",
    }
)
FORBIDDEN_NAMES = frozenset(
    {
        "open",
        "eval",
        "exec",
        "compile",
        "__import__",
        "globals",
        "locals",
        "vars",
        "input",
        "breakpoint",
        "getattr",
        "setattr",
        "delattr",
        "exit",
        "quit",
        "SystemExit",
        "BaseException",
    }
)
REQUIRED_BINDINGS = ("affiliate_id", "affiliate_name")


class RecipeModule(Protocol):
    RECIPE: dict[str, Any]

    def prepare(self, wb: read_module.Workbook) -> AffiliateCanonical: ...


@dataclass(frozen=True, slots=True)
class RecipeCheck:
    ok: bool
    errors: list[str]
    recipe_sha256: str
    bindings: dict[str, str | None] = field(default_factory=dict)
    summary: str = ""
    content_hash: str | None = None
    coverage: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def standard(bindings: dict[str, str | None], sheet: str, header_row: int) -> str:
    """Source for a recipe that reads one table from one sheet. No model involved."""
    id_column = bindings.get("affiliate_id")
    name_column = bindings.get("affiliate_name")
    if not name_column:
        raise ValueError("the affiliate_name binding is required")
    recipe = {
        "entity": "affiliate",
        "sdk": __version__,
        "summary": f"Standard table: sheet {sheet!r}, header on row {header_row}.",
        "bindings": {"affiliate_id": id_column, "affiliate_name": name_column},
    }
    return (
        '"""Generated standard recipe."""\n\n'
        "from onboarding_sdk.canonical import AffiliateCanonical, from_table\n"
        "from onboarding_sdk.read import Workbook\n\n"
        f"RECIPE = {recipe!r}\n"
        f"SHEET = {sheet!r}\n"
        f"HEADER_ROW = {header_row!r}\n\n\n"
        "def prepare(wb: Workbook) -> AffiliateCanonical:\n"
        "    table = wb.select(SHEET).table(HEADER_ROW)\n"
        "    return from_table(\n"
        "        table,\n"
        '        id_column=RECIPE["bindings"]["affiliate_id"],\n'
        '        name_column=RECIPE["bindings"]["affiliate_name"],\n'
        "    )\n"
    )


def static_violations(source: str) -> list[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"syntax error: {exc}"]
    errors: list[str] = []
    for node in ast.walk(tree):
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
            for alias in node.names:
                if alias.name.split(".")[0] == "onboarding_sdk":
                    errors.append(f"line {node.lineno}: use 'from onboarding_sdk.<module> import <name>'")
        elif isinstance(node, ast.ImportFrom):
            modules = [node.module or ""] if node.level == 0 else ["<relative>"]
            if (node.module or "").split(".")[0] == "onboarding_sdk":
                exported = SDK_EXPORTS.get(node.module or "", frozenset())
                for alias in node.names:
                    if alias.name not in exported:
                        errors.append(f"line {node.lineno}: {node.module}.{alias.name} is not part of the recipe API")
                modules = []
        for module in modules:
            if module.split(".")[0] not in ALLOWED_IMPORTS:
                errors.append(f"line {getattr(node, 'lineno', '?')}: import of {module!r} is not allowed")
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            errors.append(f"line {node.lineno}: use of {node.id!r} is not allowed")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr.endswith("__"):
            errors.append(f"line {node.lineno}: dunder attribute {node.attr!r} is not allowed")
    return errors


def load(path: str | Path) -> RecipeModule:
    path = Path(path)
    source = path.read_text(encoding="utf-8")
    module = types.ModuleType(f"recipe_{hashlib.sha256(source.encode()).hexdigest()[:12]}")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return cast(RecipeModule, module)


def _check_recipe_dict(recipe: object) -> list[str]:
    if not isinstance(recipe, dict):
        return ["RECIPE must be a dict"]
    errors = [f"RECIPE is missing {key!r}" for key in ("entity", "sdk", "summary", "bindings") if key not in recipe]
    if recipe.get("entity") != "affiliate":
        errors.append("RECIPE entity must be 'affiliate'")
    bindings = recipe.get("bindings")
    if not isinstance(bindings, dict):
        return [*errors, "RECIPE bindings must be a dict"]
    for key in REQUIRED_BINDINGS:
        if key not in bindings:
            errors.append(f"RECIPE bindings must name {key!r} (use None when absent)")
    if not isinstance(bindings.get("affiliate_name"), str):
        errors.append("RECIPE bindings affiliate_name must be a column name")
    return errors


def check(recipe_path: str | Path, upload_path: str | Path) -> RecipeCheck:
    recipe_path = Path(recipe_path)
    source = recipe_path.read_text(encoding="utf-8")
    sha = hashlib.sha256(source.encode()).hexdigest()
    errors = static_violations(source)
    if errors:
        return RecipeCheck(False, errors, sha)

    try:
        module = load(recipe_path)
        recipe = getattr(module, "RECIPE", None)
        errors.extend(_check_recipe_dict(recipe))
        if not callable(getattr(module, "prepare", None)):
            errors.append("recipe must define prepare(wb)")
        if errors:
            return RecipeCheck(False, errors, sha)
        first = module.prepare(read_module.open(upload_path))
        second = module.prepare(read_module.open(upload_path))
    except (Exception, SystemExit) as exc:  # the recipe is untrusted; report, do not crash or exit
        return RecipeCheck(False, [*errors, f"recipe raised {type(exc).__name__}: {exc}"], sha)

    assert isinstance(recipe, dict)
    bindings = dict(recipe["bindings"])
    if not isinstance(first, AffiliateCanonical):
        return RecipeCheck(False, ["prepare must return AffiliateCanonical"], sha, bindings)
    if first.content_hash() != second.content_hash():
        errors.append("prepare is not deterministic: two runs produced different tables")
    for index, row in enumerate(first.rows, start=1):
        if not row.source_sheet or row.source_row < 1:
            errors.append(f"canonical row {index} has no lineage (source_sheet/source_row)")
    coverage = {
        "rows_read": len(first.rows) + len(first.dropped),
        "rows_emitted": len(first.rows),
        "rows_dropped": len(first.dropped),
        "dropped": [asdict(d) for d in first.dropped],
    }
    return RecipeCheck(
        ok=not errors,
        errors=errors,
        recipe_sha256=sha,
        bindings=bindings,
        summary=str(recipe.get("summary", "")),
        content_hash=first.content_hash(),
        coverage=coverage,
    )


def run(recipe_path: str | Path, upload_path: str | Path) -> AffiliateCanonical:
    """Check, then prepare. Raises when the recipe does not pass ``check``."""
    result = check(recipe_path, upload_path)
    if not result.ok:
        raise ValueError("recipe failed check: " + "; ".join(result.errors))
    try:
        return load(recipe_path).prepare(read_module.open(upload_path))
    except (Exception, SystemExit) as exc:
        raise ValueError(f"recipe raised {type(exc).__name__}: {exc}") from exc


USAGE = "usage: python -m onboarding_sdk.recipes {check|run} <recipe.py> <upload>"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3 or args[0] not in {"check", "run"}:
        print(USAGE, file=sys.stderr)
        return 2
    if args[0] == "check":
        result = check(args[1], args[2])
        print(json.dumps(result.to_dict(), indent=2))
        return 0 if result.ok else 1
    try:
        canonical = run(args[1], args[2])
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps({"ok": True, "canonical": canonical.to_dict()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
