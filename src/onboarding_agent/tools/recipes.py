"""write_standard_recipe and register_authored_recipe."""

from __future__ import annotations

import json
import shlex

from langchain_core.tools import BaseTool, tool
from onboarding_sdk import recipes

from ..run_context import RunContext
from ..sandbox.base import IN_DIR, WORK_DIR
from ._common import fail, ok
from .pipeline import sandbox_python, sha256_of
from .resolve import LayoutError, set_layout


def make_recipe_tools(ctx: RunContext) -> list[BaseTool]:
    recipe_dir = ctx.run_dir / "recipes"

    @tool
    def write_standard_recipe(sheet: str, header_row: int, affiliate_name: str, affiliate_id: str | None = None) -> str:
        """Generate and check a standard recipe for a simple single-table layout (no code writing needed).

        Use it when the sheet is one table under one header row. Returns the check result and coverage.
        """
        try:
            set_layout(
                ctx,
                sheet,
                header_row,
                {"affiliate_id": affiliate_id, "affiliate_name": affiliate_name},
            )
        except LayoutError as exc:
            return fail(str(exc))
        assert ctx.bindings is not None
        source = recipes.standard(ctx.bindings, sheet, header_row)
        recipe_dir.mkdir(parents=True, exist_ok=True)
        path = recipe_dir / "standard.py"
        path.write_text(source, encoding="utf-8")
        result = recipes.check(path, ctx.upload_path)
        if not result.ok:
            ctx.candidate_recipe = None
            return fail("standard recipe failed its check", errors=result.errors)
        ctx.candidate_recipe = {
            "origin": "standard",
            "path": str(path),
            "sha256": result.recipe_sha256,
            "summary": result.summary,
            "coverage": result.coverage,
            "bindings": result.bindings,
            "layout": dict(ctx.layout or {}),
        }
        return ok(recipe="standard", coverage=result.coverage, summary=result.summary)

    @tool
    def register_authored_recipe() -> str:
        """Adopt /work/recipe.py written by the recipe engineer: download it and run the recipe check in the sandbox."""
        box = ctx.sandbox()
        downloaded = box.download_files([f"{WORK_DIR}/recipe.py"])[0]
        if downloaded.content is None:
            return fail(f"no recipe at {WORK_DIR}/recipe.py ({downloaded.error})")
        # The static check runs here, on the host: code executed in the sandbox
        # could print a forged report.
        violations = recipes.static_violations(downloaded.content.decode("utf-8", errors="replace"))
        if violations:
            ctx.candidate_recipe = None
            return fail("authored recipe failed its check", errors=violations)
        upload = shlex.quote(f"{IN_DIR}/{ctx.upload_path.name}")
        checked = box.execute(
            sandbox_python(f"onboarding_sdk.recipes check {WORK_DIR}/recipe.py {upload}"), timeout=300
        )
        try:
            report = json.loads(checked.output)
        except json.JSONDecodeError:
            return fail("the recipe check did not produce a report", output=checked.output[-800:])
        if not report.get("ok"):
            ctx.candidate_recipe = None
            return fail("authored recipe failed its check", errors=report.get("errors", []))
        recipe_dir.mkdir(parents=True, exist_ok=True)
        path = recipe_dir / "authored.py"
        path.write_bytes(downloaded.content)
        bindings = report.get("bindings", {})
        if ctx.bindings is not None and bindings != ctx.bindings:
            return fail(
                "the recipe's bindings differ from the proposed bindings",
                recipe=bindings,
                proposed=ctx.bindings,
            )
        if report.get("recipe_sha256") != sha256_of(path):
            return fail("the sandbox checked a different file than the one downloaded")
        ctx.candidate_recipe = {
            "origin": "authored",
            "path": str(path),
            "sha256": report["recipe_sha256"],
            "bindings": bindings,
            "layout": dict(ctx.layout or {}),
            "summary": report.get("summary", ""),
            "coverage": report.get("coverage", {}),
        }
        return ok(recipe="authored", coverage=report.get("coverage"), summary=report.get("summary"))

    return [write_standard_recipe, register_authored_recipe]
