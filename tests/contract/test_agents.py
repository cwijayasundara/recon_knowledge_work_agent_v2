"""Agent contracts with the scripted model: each supervisor mode, and the recipe engineer."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.messages import ToolMessage
from onboarding_sdk import recipes

from onboarding_agent.assembly import invoke_supervisor
from onboarding_agent.tools.pipeline import build
from tests.support.scripted_model import call, say, tools
from tests.support.services import Models, context_for, offline_services

CLEAN_BRIEF = {
    "source": {"file": "clean.csv", "sheet": "clean", "header_row": 1},
    "bindings": [
        {
            "field": "affiliate_id",
            "column": "Affiliate ID",
            "route": "history",
            "confidence": 1.0,
            "evidence": "AFF_ ids",
        },
        {
            "field": "affiliate_name",
            "column": "Affiliate Name",
            "confidence": 1.0,
            "evidence": "legal names",
        },
    ],
    "id_strategy": "source_id",
    "recipe": {"kind": "standard"},
    "confidence": 0.95,
    "summary": "Eight affiliates with IDs.",
}


def _tool_messages(result: dict) -> list[ToolMessage]:  # type: ignore[type-arg]
    return [m for m in result["messages"] if isinstance(m, ToolMessage)]


def test_scope_clean_brief(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = [
        tools(call("profile_upload"), call("recall_recipe")),
        tools(call("resolve_columns", sheet="clean", header_row=1)),
        tools(
            call(
                "write_standard_recipe",
                sheet="clean",
                header_row=1,
                affiliate_id="Affiliate ID",
                affiliate_name="Affiliate Name",
            )
        ),
        tools(call("submit_brief", brief=CLEAN_BRIEF)),
        say("Brief submitted."),
    ]
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "clean.csv")
    result = invoke_supervisor(services, ctx, "scope")

    assert all(json.loads(m.content)["ok"] for m in _tool_messages(result)), [m.content for m in _tool_messages(result)]
    assert ctx.brief is not None
    assert ctx.brief.questions == []
    routes = {b.field: b.route for b in ctx.brief.bindings}
    # Code overwrote the model's claimed "history" route with the resolver's.
    assert routes == {"affiliate_id": "ontology_exact", "affiliate_name": "ontology_exact"}
    assert ctx.brief.source.rows_emitted == 8
    assert ctx.candidate_recipe is not None and ctx.candidate_recipe["origin"] == "standard"
    assert ctx.model_calls == 5
    offered = set(models.supervisor.offered[0])
    assert "execute" not in offered
    assert {"profile_upload", "submit_brief", "task"} <= offered


def test_submit_brief_refuses_mismatched_bindings(tmp_path: Path) -> None:
    models = Models()
    bad = json.loads(json.dumps(CLEAN_BRIEF))
    bad["bindings"][1]["column"] = "Fund Complex"
    models.supervisor.script = [
        tools(
            call(
                "write_standard_recipe",
                sheet="clean",
                header_row=1,
                affiliate_id="Affiliate ID",
                affiliate_name="Affiliate Name",
            )
        ),
        tools(call("submit_brief", brief=bad)),
        say("done"),
    ]
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "clean.csv")
    result = invoke_supervisor(services, ctx, "scope")
    last = json.loads(_tool_messages(result)[-1].content)
    assert last["ok"] is False and "differ" in last["error"]
    assert ctx.brief is None


def test_propose_bindings_refuses_invented_column(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = [
        tools(call("propose_bindings", sheet="clean", header_row=1, affiliate_name="Legal Name")),
        say("done"),
    ]
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "clean.csv")
    result = invoke_supervisor(services, ctx, "scope")
    assert json.loads(_tool_messages(result)[0].content)["ok"] is False
    assert ctx.bindings is None


def test_supervisor_cannot_start_general_purpose_subagent(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = [
        tools(call("task", description="do it", subagent_type="general-purpose")),
        say("done"),
    ]
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "clean.csv")
    result = invoke_supervisor(services, ctx, "scope")
    denial = _tool_messages(result)[0]
    assert denial.status == "error" and "not allowed" in str(denial.content)


def test_recipe_engineer_writes_passing_recipe(tmp_path: Path) -> None:
    source = recipes.standard({"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}, "Affiliates", 4)
    models = Models()
    models.supervisor.script = [
        tools(
            call(
                "propose_bindings",
                sheet="Affiliates",
                header_row=4,
                affiliate_id="Affiliate ID",
                affiliate_name="Affiliate Name",
            )
        ),
        tools(
            call(
                "task",
                description="Title rows then a header on row 4 of 'Affiliates'.",
                subagent_type="recipe-engineer",
            )
        ),
        tools(call("register_authored_recipe")),
        say("Recipe registered."),
    ]
    models.recipe_engineer.script = [
        tools(call("execute", command="cat /ref/bindings.json")),
        tools(call("write_file", file_path="/work/recipe.py", content=source)),
        tools(
            call(
                "execute",
                command="python -m onboarding_sdk.recipes check /work/recipe.py /in/titled.xlsx",
            )
        ),
        tools(
            call(
                "RecipeResult",
                path="/work/recipe.py",
                summary="Header on row 4.",
                coverage={"rows_emitted": 8},
                open_questions=[],
            )
        ),
    ]
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "titled.xlsx")
    result = invoke_supervisor(services, ctx, "scope")
    messages = _tool_messages(result)
    engineer_reply = next(m for m in messages if m.name == "task")
    assert "/work/recipe.py" in str(engineer_reply.content)
    registered = json.loads(messages[-1].content)
    assert registered["ok"], registered
    assert ctx.candidate_recipe is not None and ctx.candidate_recipe["origin"] == "authored"
    assert "task" not in models.recipe_engineer.offered[0]
    assert "execute" in models.recipe_engineer.offered[0]
    # The authored recipe runs in the sandbox, and yields the 8 affiliates.
    outcome = build(ctx, ctx.candidate_recipe)
    assert len(outcome.records) == 8
    ctx.close()


def test_report_mode(tmp_path: Path) -> None:
    models = Models()
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "edge.csv")
    from onboarding_agent.tools.recipes import make_recipe_tools

    make_recipe_tools(ctx)[0].invoke(
        {
            "sheet": "edge",
            "header_row": 1,
            "affiliate_id": "Affiliate ID",
            "affiliate_name": "Affiliate Name",
        }
    )
    assert ctx.candidate_recipe is not None
    build(ctx, ctx.candidate_recipe)
    models.supervisor.script = [
        tools(call("get_findings")),
        tools(
            call(
                "submit_report",
                report={
                    "summary": "Three ID problems and two derived IDs.",
                    "explanations": {"AFF_ERR_ITEM_ID_DUPLICATE": "Rows 3 and 4 share AFF_9010."},
                    "proposed_changes": [
                        {"kind": "override_item_id", "row": 4, "value": "AFF_9011"},
                        {"kind": "acknowledge_finding", "code": "AFF_ERR_ITEM_ID_BLANK", "row": 1},
                    ],
                    "findings_by_code": {"made": 1},
                },
            )
        ),
        say("Report submitted."),
    ]
    invoke_supervisor(services, ctx, "report", summary={"errors": 4})
    assert ctx.report is not None
    # Counts come from code, and the refused acknowledgement of an ERR was dropped.
    assert ctx.report.findings_by_code == ctx.result.counts_by_code()  # type: ignore[union-attr]
    assert [c.kind for c in ctx.report.proposed_changes] == ["override_item_id"]


def test_instruct_mode_no_applicable_change(tmp_path: Path) -> None:
    models = Models()
    services = offline_services(tmp_path, models)
    ctx = context_for(services, "clean.csv")
    from onboarding_agent.tools.recipes import make_recipe_tools

    make_recipe_tools(ctx)[0].invoke(
        {
            "sheet": "clean",
            "header_row": 1,
            "affiliate_id": "Affiliate ID",
            "affiliate_name": "Affiliate Name",
        }
    )
    build(ctx, ctx.candidate_recipe)  # type: ignore[arg-type]
    models.supervisor.script = [
        tools(
            call(
                "submit_proposal",
                proposal={
                    "restated": "Amounts are signed: an Affiliate file has no amounts, so no change applies.",
                    "applicable": False,
                    "changes": [{"kind": "exclude_row", "row": 1, "reason": "x"}],
                },
            )
        ),
        say("No applicable change."),
    ]
    invoke_supervisor(services, ctx, "instruct", text="amounts are signed")
    assert ctx.proposal is not None
    assert ctx.proposal.applicable is False
    assert ctx.proposal.changes == []
