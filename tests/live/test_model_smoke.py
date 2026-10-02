from __future__ import annotations

import pytest
from deepagents import create_deep_agent

from onboarding_agent.models import chat_model

pytestmark = pytest.mark.live


def test_deep_agent_calls_a_tool() -> None:
    calls: list[tuple[int, int]] = []

    def add(a: int, b: int) -> int:
        """Add two integers and return the sum."""
        calls.append((a, b))
        return a + b

    from onboarding_agent.config import Settings

    agent = create_deep_agent(
        chat_model("supervisor", Settings(supervisor_model="gpt-5.6-luna")),
        tools=[add],
        system_prompt="Use the add tool for arithmetic. Answer with the number only.",
    )
    result = agent.invoke({"messages": [{"role": "user", "content": "What is 1234 + 4321?"}]})
    assert calls, "the model never called the add tool"
    assert "5555" in str(result["messages"][-1].content)
