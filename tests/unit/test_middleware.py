from __future__ import annotations

from langchain.agents import create_agent
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from onboarding_agent.middleware.guard import InvocationGuardMiddleware, ToolSurfacePolicy
from onboarding_agent.middleware.offload import OffloadMiddleware
from onboarding_agent.middleware.redaction import RedactionMiddleware
from tests.support.scripted_model import ScriptedChatModel, call, say, tools


@tool
def visible(x: int) -> int:
    """Visible tool."""
    return x + 1


@tool
def hidden(x: int) -> str:
    """Hidden tool."""
    return "ran hidden"


@tool
def big() -> str:
    """Returns a large result."""
    return "row," * 5000


@tool
def leaky() -> str:
    """Returns something with a secret in it."""
    return "token sk-live-ABCDEF1234567890abcdef here"


def _run(model: ScriptedChatModel, middleware: list, tool_list: list) -> dict:  # type: ignore[type-arg]
    agent = create_agent(model, tools=tool_list, middleware=middleware)
    return agent.invoke({"messages": [{"role": "user", "content": "go"}]})


def test_hidden_tool_not_offered_and_call_denied() -> None:
    policy = ToolSurfacePolicy(hidden=frozenset({"hidden"}))
    model = ScriptedChatModel(script=[tools(call("hidden", x=1)), say("done")])
    result = _run(model, [InvocationGuardMiddleware(policy)], [visible, hidden])
    assert "hidden" not in model.offered[0]
    assert "visible" in model.offered[0]
    denial = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert denial.status == "error"
    assert "not allowed" in str(denial.content)
    assert "ran hidden" not in str(denial.content)


def test_allow_list_policy() -> None:
    policy = ToolSurfacePolicy(allowed=frozenset({"visible"}))
    model = ScriptedChatModel(script=[tools(call("visible", x=1)), say("done")])
    result = _run(model, [InvocationGuardMiddleware(policy)], [visible, hidden])
    assert model.offered[0] == ["visible"]
    assert any(isinstance(m, ToolMessage) and m.content == "2" for m in result["messages"])


def test_offload_replaces_large_results(tmp_path) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedChatModel(script=[tools(call("big")), say("done")])
    result = _run(model, [OffloadMiddleware(tmp_path, max_chars=500)], [big])
    stub = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert len(str(stub.content)) < 500
    assert "artifact" in str(stub.content)
    stored = list(tmp_path.iterdir())
    assert len(stored) == 1 and stored[0].read_text().startswith("row,")


def test_redaction_scrubs_tool_output_and_model_input() -> None:
    model = ScriptedChatModel(script=[tools(call("leaky")), say("done")])
    mw = RedactionMiddleware(secrets=["hunter2"])
    agent = create_agent(model, tools=[leaky], middleware=[mw])
    agent.invoke({"messages": [{"role": "user", "content": "my password is hunter2"}]})
    first_input = " ".join(str(m.content) for m in model.seen[0])
    assert "hunter2" not in first_input
    second_input = " ".join(str(m.content) for m in model.seen[1])
    assert "sk-live-ABCDEF1234567890abcdef" not in second_input
    assert "[REDACTED]" in second_input


def test_task_limited_to_named_subagents() -> None:
    policy = ToolSurfacePolicy(subagents=frozenset({"recipe-engineer"}))
    assert policy.permits_call("task", {"subagent_type": "recipe-engineer"})
    assert not policy.permits_call("task", {"subagent_type": "general-purpose"})
    assert policy.permits_call("visible", {})
