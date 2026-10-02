"""A deterministic stand-in for the supervisor, for browser tests and offline demos.

It reads the mode and file from the first message and plays the tool sequence
the fixture's expected/*.json implies. It is a scripted model, not an agent.
"""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from tests.support.pipeline import expected
from tests.support.scripted_model import ScriptedChatModel, call, say, tools
from tests.support.scripts import brief_for

EXPLAIN = {
    "AFF_ERR_ITEM_ID_BLANK": "A row has no ID and no name, so there is nothing to build an ITEM_ID from.",
    "AFF_ERR_ITEM_ID_TOO_LONG": "A supplied ID is longer than Intacct's 30-character limit.",
    "AFF_ERR_ITEM_ID_DUPLICATE": "Two different affiliates share one ITEM_ID; Intacct needs one per affiliate.",
    "AFF_ERR_ITEM_ID_TRUNCATION_COLLISION": "Two long names become the same ID once cut to 30 characters.",
    "AFF_ERR_NAME_BLANK": "A row has an ID but no name.",
    "AFF_WARN_ITEM_ID_DERIVED": "No ID was supplied, so one was built from the name. Check it reads well.",
    "AFF_WARN_ITEM_ID_CHARS_STRIPPED": "An apostrophe or ampersand was removed while building the ID.",
    "AFF_WARN_NAME_TRUNCATED": "The name is over 100 characters; Intacct keeps the first 100.",
    "AFF_WARN_ITEM_TYPE_OVERRIDE": "ITEM_TYPE was changed from Inventory; confirm that is intended.",
    "AFF_WARN_ZERO_RECORDS": "The file has headers but no affiliates. Confirm none are needed.",
}


def _conversation(messages: list[BaseMessage]) -> tuple[str, str, str, list[ToolMessage]]:
    first = next(m for m in messages if isinstance(m, HumanMessage))
    text = str(first.content)
    mode = re.search(r"Mode: (\w+)", text)
    file = re.search(r"File: ([^\n]+?)\.\n", text + "\n")
    said = re.search(r"The analyst said: '(.*)'", text)
    return (
        mode.group(1) if mode else "scope",
        file.group(1).strip() if file else "",
        said.group(1) if said else "",
        [m for m in messages if isinstance(m, ToolMessage)],
    )


def _scope(name: str, done: int, text: str) -> AIMessage:
    spec = expected(name)
    b = spec["bindings"]
    answered = "The analyst has answered" in text
    if spec.get("questions") and not answered and name == "two_sheets.xlsx":
        plan = [
            tools(call("profile_upload")),
            tools(
                call(
                    "submit_brief",
                    brief=brief_for(
                        name,
                        questions=[
                            {
                                "id": "q1",
                                "text": "Two sheets look like affiliate lists. Which one is current?",
                                "options": ["Affiliates", "Affiliates (old)"],
                                "evidence": "8 rows vs 5 rows, same header",
                                "target": "sheet",
                            }
                        ],
                    ),
                )
            ),
            say("One question for the analyst."),
        ]
    else:
        plan = [
            tools(call("profile_upload"), call("recall_recipe")),
            tools(call("resolve_columns", sheet=spec["sheet"], header_row=spec["header_row"])),
            tools(
                call(
                    "write_standard_recipe",
                    sheet=spec["sheet"],
                    header_row=spec["header_row"],
                    affiliate_id=b["affiliate_id"],
                    affiliate_name=b["affiliate_name"],
                )
            ),
            tools(call("submit_brief", brief=brief_for(name))),
            say("Brief submitted."),
        ]
    return plan[min(done, len(plan) - 1)]


def _report(done: int, tool_messages: list[ToolMessage]) -> AIMessage:
    if done == 0:
        return tools(call("get_findings"))
    if done == 1:
        findings = json.loads(str(tool_messages[0].content)).get("findings", [])
        codes = sorted({f["code"] for f in findings})
        errors = sum(f["severity"] == "error" for f in findings)
        warns = sum(f["severity"] == "warning" for f in findings)
        return tools(
            call(
                "submit_report",
                report={
                    "summary": f"{errors} error(s) to fix and {warns} warning(s) to acknowledge.",
                    "explanations": {c: EXPLAIN.get(c, c) for c in codes},
                },
            )
        )
    return say("Report submitted.")


def _instruct(done: int, said: str) -> AIMessage:
    if done > 0:
        return say("Proposal submitted.")
    exclude = re.search(r"exclude row (\d+)", said, re.I)
    if exclude:
        proposal: dict[str, Any] = {
            "restated": f"Exclude row {exclude.group(1)} from the import.",
            "changes": [{"kind": "exclude_row", "row": int(exclude.group(1)), "reason": said}],
        }
    elif "non-inventory" in said.lower():
        proposal = {
            "restated": "Set ITEM_TYPE to Non-Inventory for every row.",
            "changes": [{"kind": "set_item_type", "value": "Non-Inventory"}],
        }
    else:
        proposal = {"restated": f"'{said}' does not map to any Affiliate change.", "applicable": False}
    return tools(call("submit_proposal", proposal=proposal))


def next_step(messages: list[BaseMessage]) -> AIMessage:
    mode, name, said, tool_messages = _conversation(messages)
    done = len([m for m in messages if isinstance(m, AIMessage)])
    first = next(m for m in messages if isinstance(m, HumanMessage))
    if mode == "report":
        return _report(done, tool_messages)
    if mode == "instruct":
        return _instruct(done, said)
    return _scope(name, done, str(first.content))


class FixtureAgentModel(ScriptedChatModel):
    """Every call is answered by ``next_step``; the script never runs out."""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
        self.script = [next_step]
        self.position = 0
        result = super()._generate(messages, stop, run_manager, **kwargs)
        self.total_calls += 1
        return result

    total_calls: int = 0
