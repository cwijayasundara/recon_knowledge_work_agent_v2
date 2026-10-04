"""Copilot HTTP contract: sessions, the step loop, actor isolation, body limits and the audit log."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

import anyio.to_thread
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, BaseMessage
from pydantic import ValidationError

from onboarding_agent.copilot.routes import _RunAccess
from onboarding_agent.copilot.schemas import ALL_TOOLS, CheckChanges, StepOut
from onboarding_agent.surfaces.api import create_app
from tests.conftest import FIXTURE_DIR
from tests.support.scripted_model import call, say, tools
from tests.support.scripts import report_simple, scope_standard
from tests.support.services import Models, offline_services

H = {"X-Actor": "analyst@sponsor-a"}
OTHER = {"X-Actor": "someone-else"}
SENT = "SENTINEL-7f3a"
NOT_FOUND = {"detail": "session not found"}


def _client(tmp_path: Path, *, enabled: bool = True, **overrides: Any) -> tuple[TestClient, Models]:
    models = Models()
    services = offline_services(tmp_path, models)
    services.settings.copilot_enabled = enabled
    for key, value in overrides.items():
        setattr(services.settings, key, value)
    return TestClient(create_app(services=services, inline_jobs=True)), models


@pytest.fixture
def setup(tmp_path: Path) -> tuple[TestClient, Models]:
    return _client(tmp_path)


def _upload(client: TestClient, name: str, sponsor: str = "sponsor-a") -> str:
    with (FIXTURE_DIR / name).open("rb") as handle:
        r = client.post(
            "/runs", data={"sponsor_id": sponsor, "entity": "affiliate"}, files={"file": (name, handle)}, headers=H
        )
    assert r.status_code == 202, r.text
    return str(r.json()["run_id"])


def _start(client: TestClient, run_id: str | None = None, headers: dict[str, str] = H) -> dict[str, Any]:
    r = client.post("/copilot/sessions", json={"run_id": run_id} if run_id else {}, headers=headers)
    assert r.status_code == 200, r.text
    return dict(r.json())


def _step(client: TestClient, sid: str, body: dict[str, Any], headers: dict[str, str] = H) -> Any:
    return client.post(f"/copilot/sessions/{sid}/step", json=body, headers=headers)


def test_disabled_answers_403_and_routes_still_exist(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, enabled=False)
    r = client.post("/copilot/sessions", json={}, headers=H)
    assert r.status_code == 403 and r.json() == {"detail": "copilot is disabled"}
    paths = client.get("/openapi.json").json()["paths"]
    assert {"/copilot/sessions", "/copilot/sessions/{session_id}/step", "/copilot/sessions/{session_id}"} <= set(paths)


def test_openapi_has_no_gate_or_approve_copilot_path(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    copilot = [p for p in client.get("/openapi.json").json()["paths"] if p.startswith("/copilot")]
    assert copilot and not [p for p in copilot if "gate" in p or "approve" in p]


def test_create_returns_limits_and_exact_tools(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    body = _start(client)
    assert body["session_id"] and body["run_bound"] is False
    assert body["limits"] == {
        "max_cells_per_call": 2000,
        "max_cells_per_session": 20000,
        "max_steps_per_turn": 8,
        "max_write_cells": 2000,
        "cell_char_limit": 500,
    }
    assert body["tools"] == sorted(ALL_TOOLS)


def test_client_tool_round_trip(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.copilot.script = [tools(call("list_sheets")), say("Two sheets.")]
    sid = _start(client)["session_id"]
    out = _step(client, sid, {"user_message": "What sheets are there?"})
    assert out.status_code == 200, out.text
    first = out.json()
    assert first["status"] == "tool_calls" and [c["name"] for c in first["tool_calls"]] == ["list_sheets"]
    cid = first["tool_calls"][0]["id"]
    final = _step(client, sid, {"tool_results": [{"call_id": cid, "ok": True, "content": {"sheets": ["A", "B"]}}]})
    assert final.status_code == 200, final.text
    assert final.json()["status"] == "final" and final.json()["text"] == "Two sheets."


def test_other_actor_unknown_and_deleted_sessions_are_404(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.copilot.script = [say("hi")]
    sid = _start(client)["session_id"]
    unknown = _step(client, "no-such-session", {"user_message": "hi"})
    foreign = _step(client, sid, {"user_message": "hi"}, headers=OTHER)
    assert unknown.status_code == foreign.status_code == 404
    assert unknown.json() == foreign.json() == NOT_FOUND
    gone = client.delete(f"/copilot/sessions/{sid}", headers=OTHER)
    assert gone.status_code == 404 and gone.json() == NOT_FOUND
    assert client.delete("/copilot/sessions/no-such-session", headers=H).json() == NOT_FOUND
    # The owner can still use it after the foreign attempts.
    assert _step(client, sid, {"user_message": "hi"}).json()["text"] == "hi"
    assert client.delete(f"/copilot/sessions/{sid}", headers=H).status_code == 204
    after = _step(client, sid, {"user_message": "hi"})
    assert after.status_code == 404 and after.json() == NOT_FOUND
    assert client.delete(f"/copilot/sessions/{sid}", headers=H).status_code == 404


def test_unknown_run_is_404_and_malformed_run_id_is_422(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    assert client.post("/copilot/sessions", json={"run_id": "run-000000000000"}, headers=H).status_code == 404
    assert client.post("/copilot/sessions", json={"run_id": "../etc"}, headers=H).status_code == 422


def test_too_many_sessions_is_429(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, copilot_max_sessions_per_actor=2)
    _start(client)
    _start(client)
    assert client.post("/copilot/sessions", json={}, headers=H).status_code == 429
    assert client.post("/copilot/sessions", json={}, headers=OTHER).status_code == 200


def test_unknown_and_repeated_call_ids_are_409(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.copilot.script = [tools(call("list_sheets")), say("done")]
    sid = _start(client)["session_id"]
    cid = _step(client, sid, {"user_message": "go"}).json()["tool_calls"][0]["id"]
    bogus = _step(client, sid, {"tool_results": [{"call_id": "call_nope", "ok": True, "content": {"sheets": []}}]})
    assert bogus.status_code == 409
    result = {"tool_results": [{"call_id": cid, "ok": True, "content": {"sheets": ["A"]}}]}
    assert _step(client, sid, result).json()["status"] == "final"
    assert _step(client, sid, result).status_code == 409
    # Two results for the same id in one body are refused by the wire schema.
    dup = {"tool_results": [{"call_id": cid, "ok": True}, {"call_id": cid, "ok": True}]}
    assert _step(client, sid, dup).status_code == 422


def test_bad_bodies_are_422_never_500(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    sid = _start(client)["session_id"]
    assert _step(client, sid, {}).status_code == 422
    assert _step(client, sid, {"user_message": "a", "tool_results": [{"call_id": "x", "ok": True}]}).status_code == 422
    raw = {"Content-Type": "application/json", **H}
    url = f"/copilot/sessions/{sid}/step"
    assert client.post(url, content=b"{not json", headers=raw).status_code == 422
    deep = b'{"tool_results":[{"call_id":"c1","ok":true,"content":' + b"[" * 100_000 + b"]" * 100_000 + b"}]}"
    r = client.post(url, content=deep, headers=raw)
    assert r.status_code == 422, r.text
    moderate = b'{"tool_results":[{"call_id":"c1","ok":true,"content":' + b"[" * 900 + b"]" * 900 + b"}]}"
    assert client.post(url, content=moderate, headers=raw).status_code == 422
    surrogate = client.post(url, content=b'{"user_message": "hi \\ud800 there"}', headers=raw)
    assert surrogate.status_code == 422, surrogate.text
    assert client.post(url, content=b"\xff\xfe", headers=raw).status_code == 422
    bad_start = client.post("/copilot/sessions", content=b'{"run_id": "\\udc00"}', headers=raw)
    assert bad_start.status_code == 422


def test_oversize_body_is_413(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    sid = _start(client)["session_id"]
    big = {"user_message": "x" * (3 * 1024 * 1024)}
    r = _step(client, sid, big)
    assert r.status_code == 413 and r.json() == {"detail": "request too large"}

    def chunks() -> Any:  # no Content-Length: the cap is enforced while reading
        for _ in range(48):
            yield b"x" * 65536

    streamed = client.post(
        f"/copilot/sessions/{sid}/step", content=chunks(), headers={"Content-Type": "application/json", **H}
    )
    assert streamed.status_code == 413


def _bound_run(client: TestClient, models: Models) -> str:
    models.supervisor.script = [*scope_standard("edge.csv"), *report_simple()]
    run_id = _upload(client, "edge.csv")
    assert client.post(f"/runs/{run_id}/gate", json={"action": "approve"}, headers=H).status_code == 202
    return run_id


def _last_tool_payloads(messages: list[BaseMessage]) -> list[str]:
    return [str(m.content) for m in messages if m.type == "tool"]


def test_run_bound_session_reads_state_findings_and_dry_runs(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    run_id = _bound_run(client, models)
    bad = [{"kind": "override_item_id", "row": 4, "value": "bad id"}]
    models.copilot.script = [
        tools(call("run_state"), call("run_findings"), call("check_changes", changes=bad)),
        say("Checked."),
    ]
    start = _start(client, run_id)
    assert start["run_bound"] is True
    out = _step(client, start["session_id"], {"user_message": "How is the run?"})
    assert out.status_code == 200 and out.json() == {
        "status": "final",
        "tool_calls": [],
        "text": "Checked.",
        "proposed_changes": [],
        "proposed_writes": [],
        "notes": [],
    }
    replies = _last_tool_payloads(models.copilot.seen[-1])
    assert len(replies) == 3
    state, findings, check = replies
    assert '"phase"' in state and '"counts"' in state
    assert '"total"' in findings and '"findings"' in findings
    assert "item_id.charset" in check and '"rows_changed"' in check


def test_propose_changes_with_acknowledge_is_a_tool_error(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    run_id = _bound_run(client, models)
    ack = [{"kind": "acknowledge_finding", "code": "AFF_W", "rows": [1]}]
    models.copilot.script = [tools(call("propose_changes", restated="Acknowledge it.", changes=ack)), say("Cannot.")]
    sid = _start(client, run_id)["session_id"]
    final = _step(client, sid, {"user_message": "acknowledge the warning"}).json()
    assert final["status"] == "final" and final["proposed_changes"] == []
    reply = _last_tool_payloads(models.copilot.seen[-1])[0]
    assert "invalid arguments" in reply
    # The wire models refuse it too: a final answer or a dry run can never carry an acknowledgement.
    with pytest.raises(ValidationError):
        StepOut.model_validate({"status": "final", "proposed_changes": ack})
    with pytest.raises(ValidationError):
        CheckChanges.model_validate({"changes": ack})


def test_unbound_propose_changes_is_refused(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    change = [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}]
    models.copilot.script = [tools(call("propose_changes", restated="Fix row 4.", changes=change)), say("No run.")]
    sid = _start(client)["session_id"]
    final = _step(client, sid, {"user_message": "fix row 4"}).json()
    assert final["proposed_changes"] == []
    assert "no active run" in _last_tool_payloads(models.copilot.seen[-1])[0]


def test_run_bound_valid_proposal_reaches_the_final(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    run_id = _bound_run(client, models)
    change = [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}]
    models.copilot.script = [tools(call("propose_changes", restated="Fix row 4.", changes=change)), say("Proposed.")]
    sid = _start(client, run_id)["session_id"]
    final = _step(client, sid, {"user_message": "fix row 4"}).json()
    assert final["proposed_changes"] == change


def test_copilot_never_touches_gates(setup, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    run_id = _bound_run(client, models)
    bench = client.app.state.workbench  # type: ignore[attr-defined]

    def forbidden(*_: Any, **__: Any) -> None:
        raise AssertionError("the copilot touched a gate")

    monkeypatch.setattr(bench, "respond", forbidden)
    change = [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}]
    models.copilot.script = [
        tools(call("run_state"), call("check_changes", changes=change)),
        tools(call("propose_changes", restated="Fix row 4.", changes=change)),
        say("Done."),
    ]
    start = _start(client, run_id)
    assert _step(client, start["session_id"], {"user_message": "fix it"}).json()["status"] == "final"
    assert client.delete(f"/copilot/sessions/{start['session_id']}", headers=H).status_code == 204


def test_audit_never_logs_planted_sentinels(setup, caplog: pytest.LogCaptureFixture) -> None:  # type: ignore[no-untyped-def]
    caplog.set_level(logging.DEBUG)
    client, models = setup
    models.copilot.script = [tools(call("list_sheets"), call("read_range", sheet="Data", range="A1:B2")), say("ok")]
    sid = _start(client)["session_id"]
    first = _step(client, sid, {"user_message": f"Look for {SENT} please"}).json()
    ids = {c["name"]: c["id"] for c in first["tool_calls"]}
    results = [
        {"call_id": ids["list_sheets"], "ok": True, "content": {"sheets": [SENT, "Data"]}},
        {"call_id": ids["read_range"], "ok": True, "content": {"values": [[SENT, 1], ["=x", SENT]]}},
    ]
    final = _step(client, sid, {"tool_results": results})
    assert final.status_code == 200 and final.json()["status"] == "final"
    assert client.delete(f"/copilot/sessions/{sid}", headers=H).status_code == 204
    audit_lines = [r.getMessage() for r in caplog.records if r.name.startswith("onboarding_agent.copilot")]
    assert audit_lines, "the audit log recorded nothing"
    assert SENT not in caplog.text
    assert all(SENT not in json.dumps(line) for line in audit_lines)


def test_step_runs_off_the_event_loop(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    seen: list[bool] = []

    def step(_: list[BaseMessage]) -> AIMessage:
        try:
            asyncio.get_running_loop()
            seen.append(True)
        except RuntimeError:
            seen.append(False)
        return AIMessage(content="ok")

    models.copilot.script = [step]
    sid = _start(client)["session_id"]
    assert _step(client, sid, {"user_message": "hi"}).json()["text"] == "ok"
    assert seen == [False], "the model step ran on the event loop thread"


def test_slow_step_does_not_stall_other_requests(tmp_path: Path) -> None:
    client, models = _client(tmp_path)
    entered, health_done = threading.Event(), threading.Event()
    order: list[str] = []

    def slow(_: list[BaseMessage]) -> AIMessage:
        entered.set()
        health_done.wait(5)
        order.append("model")
        return AIMessage(content="slow")

    models.copilot.script = [slow]
    with client:  # one event loop for every request, so a blocked loop would stall /health
        sid = _start(client)["session_id"]
        replies: list[Any] = []
        worker = threading.Thread(target=lambda: replies.append(_step(client, sid, {"user_message": "hi"})))
        worker.start()
        assert entered.wait(5)
        assert client.get("/health").status_code == 200
        order.append("health")
        assert _step(client, sid, {"user_message": "again"}).status_code == 409  # one step per session at a time
        health_done.set()
        worker.join(10)
    assert order == ["health", "model"]
    assert replies[0].json()["text"] == "slow"


def test_error_details_never_echo_unencodable_input(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    sid = _start(client)["session_id"]
    raw = {"Content-Type": "application/json", **H}
    r = client.post(f"/copilot/sessions/{sid}/step", content=b'{"\\ud800": 1, "user_message": "hi"}', headers=raw)
    assert r.status_code == 422, r.text
    assert "input" not in r.json()["detail"][0]


def test_disabled_flag_refuses_step_and_delete(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, enabled=False)
    assert _step(client, "any", {"user_message": "hi"}).status_code == 403
    assert client.delete("/copilot/sessions/any", headers=H).status_code == 403


def test_run_access_maps_http_errors_for_the_engine() -> None:
    def missing(run_id: str, *_: Any) -> dict[str, Any]:
        raise HTTPException(404, "run not found")

    def failed(run_id: str, *_: Any) -> dict[str, Any]:
        raise HTTPException(409, "recipe failed: boom")

    with pytest.raises(KeyError):
        _RunAccess(missing, missing).snapshot("run-1")
    with pytest.raises(KeyError):
        _RunAccess(missing, missing).dry_run("run-1", [])
    with pytest.raises(ValueError):
        _RunAccess(failed, failed).dry_run("run-1", [])


def _blocked_steps(client: TestClient, models: Models, sids: list[str]) -> tuple[threading.Event, list[Any], Any]:
    """Start one step per session, each held inside the model until ``release`` is set."""
    release = threading.Event()
    entered = threading.Semaphore(0)

    def held(_: list[BaseMessage]) -> AIMessage:
        entered.release()
        release.wait(10)
        return AIMessage(content="held")

    models.copilot.script = [held] * len(sids) + [say("later")] * 4
    replies: list[Any] = []
    workers = [
        threading.Thread(target=lambda s=sid: replies.append(_step(client, s, {"user_message": "hi"}))) for sid in sids
    ]
    for w in workers:
        w.start()
    for _ in sids:
        assert entered.acquire(timeout=5)

    def join() -> None:
        release.set()
        for w in workers:
            w.join(10)

    return release, replies, join


def test_saturated_steps_answer_503_and_sync_routes_still_answer(tmp_path: Path) -> None:
    client, models = _client(tmp_path, copilot_max_concurrent_steps=1, cors_origins="https://localhost:3100")
    with client:

        async def shrink() -> None:
            anyio.to_thread.current_default_thread_limiter().total_tokens = 1

        client.portal.call(shrink)  # type: ignore[union-attr]
        first, second = _start(client)["session_id"], _start(client)["session_id"]
        _, replies, join = _blocked_steps(client, models, [first])
        busy = _step(client, second, {"user_message": "hi"}, headers={**H, "Origin": "https://localhost:3100"})
        assert busy.status_code == 503 and busy.json() == {"detail": "copilot is busy"}
        assert busy.headers["retry-after"] == "5"
        # The browser pane can only read Retry-After when CORS exposes it.
        assert "retry-after" in busy.headers["access-control-expose-headers"].lower()
        assert client.get("/health").status_code == 200
        assert client.get("/sponsors", headers=H).status_code == 200
        assert replies == []  # both answered while the step still held its thread
        join()
        # The finished step gave its slot back.
        assert _step(client, second, {"user_message": "again"}).status_code == 200
    assert replies[0].json()["text"] == "held"


def test_delete_during_a_step_is_409_and_keeps_the_slot(tmp_path: Path) -> None:
    client, models = _client(tmp_path, copilot_max_sessions_per_actor=2)
    with client:
        sids = [_start(client)["session_id"] for _ in range(2)]
        _, replies, join = _blocked_steps(client, models, sids)
        for sid in sids:
            r = client.delete(f"/copilot/sessions/{sid}", headers=H)
            assert r.status_code == 409 and r.json() == {"detail": "a step is running"}
        # The probe that used to free slots by deleting busy sessions cannot exceed the per-actor cap.
        for _ in range(15):
            assert client.post("/copilot/sessions", json={}, headers=H).status_code == 429
        join()
        assert sorted(r.json()["text"] for r in replies) == ["held", "held"]
        assert client.delete(f"/copilot/sessions/{sids[0]}", headers=H).status_code == 204
        assert client.post("/copilot/sessions", json={}, headers=H).status_code == 200


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", None, "application/merge+json"])
def test_non_json_media_types_are_415(setup, ctype: str | None) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    store = client.app.state.copilot.store  # type: ignore[attr-defined]
    headers = {**H, **({"Content-Type": ctype} if ctype else {})}
    r = client.post("/copilot/sessions", content=b"{}", headers=headers)
    assert r.status_code == 415, r.text
    assert store._sessions == {}
    sid = _start(client)["session_id"]
    assert (
        client.post(f"/copilot/sessions/{sid}/step", content=b'{"user_message":"hi"}', headers=headers).status_code
        == 415
    )


def test_json_with_charset_is_accepted(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.copilot.script = [say("ok")]
    headers = {**H, "Content-Type": "Application/JSON; charset=utf-8"}
    r = client.post("/copilot/sessions", content=b"{}", headers=headers)
    assert r.status_code == 200, r.text
    step = client.post(
        f"/copilot/sessions/{r.json()['session_id']}/step", content=b'{"user_message":"hi"}', headers=headers
    )
    assert step.json()["text"] == "ok"


def test_internal_key_error_is_not_session_not_found(setup, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    engine = client.app.state.copilot  # type: ignore[attr-defined]
    sid = _start(client)["session_id"]

    def broken(*_: Any) -> Any:
        raise KeyError(SENT)

    monkeypatch.setattr(engine, "step", broken)
    quiet = TestClient(client.app, raise_server_exceptions=False)
    r = quiet.post(f"/copilot/sessions/{sid}/step", json={"user_message": "hi"}, headers=H)
    assert r.status_code == 500 and r.json() != NOT_FOUND
    assert SENT not in r.text


def test_declared_oversize_body_is_413_before_reading() -> None:
    from starlette.requests import Request

    from onboarding_agent.copilot.routes import MAX_BODY_BYTES, _json_body

    async def receive() -> Any:
        raise AssertionError("the body was read")

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/copilot/sessions",
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(MAX_BODY_BYTES + 1).encode())],
    }
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_json_body(Request(scope, receive)))
    assert exc.value.status_code == 413


@pytest.mark.parametrize("enabled", [False, True])
def test_bearer_token_guards_copilot_routes(tmp_path: Path, enabled: bool) -> None:
    client, models = _client(tmp_path, enabled=enabled, api_token="dev-token-123")
    models.copilot.script = [say("ok")]
    assert client.post("/copilot/sessions", json={}, headers=H).status_code == 401
    assert _step(client, "any", {"user_message": "hi"}).status_code == 401
    assert client.delete("/copilot/sessions/any", headers=H).status_code == 401
    bearer = {**H, "Authorization": "Bearer dev-token-123"}
    r = client.post("/copilot/sessions", json={}, headers=bearer)
    assert r.status_code == (200 if enabled else 403)
    if not enabled:
        return
    sid = r.json()["session_id"]
    # Query-string credentials work exactly as on the other routes: same actor, same session.
    q = {"access_token": "dev-token-123", "actor": "analyst@sponsor-a"}
    assert client.post(f"/copilot/sessions/{sid}/step", json={"user_message": "hi"}, params=q).json()["text"] == "ok"
    assert client.delete(f"/copilot/sessions/{sid}", headers=bearer).status_code == 204


def test_expired_session_is_the_same_404(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    store = client.app.state.copilot.store  # type: ignore[attr-defined]
    sid = _start(client)["session_id"]
    store.get(sid, "analyst@sponsor-a").last_used -= 10**6
    r = _step(client, sid, {"user_message": "hi"})
    assert r.status_code == 404 and r.json() == NOT_FOUND
    assert client.delete(f"/copilot/sessions/{sid}", headers=H).json() == NOT_FOUND


def test_openapi_documents_request_bodies(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    doc = client.get("/openapi.json").json()
    start = doc["paths"]["/copilot/sessions"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    step = doc["paths"]["/copilot/sessions/{session_id}/step"]["post"]["requestBody"]["content"]["application/json"]
    assert "run_id" in start["properties"]
    assert {"user_message", "tool_results"} <= set(step["schema"]["properties"])
    assert "$defs" not in json.dumps(step) and "$ref" not in json.dumps(step)
    assert not [p for p in doc["paths"] if p.startswith("/copilot") and ("gate" in p or "approve" in p)]


def test_expiry_during_a_step_keeps_the_slot(tmp_path: Path) -> None:
    client, models = _client(tmp_path, copilot_max_sessions_per_actor=1)
    store = client.app.state.copilot.store  # type: ignore[attr-defined]
    with client:
        sid = _start(client)["session_id"]
        sess = store.get(sid, "analyst@sponsor-a")
        _, _, join = _blocked_steps(client, models, [sid])
        sess.last_used -= 10**6  # expires while its step runs
        assert client.post("/copilot/sessions", json={}, headers=H).status_code == 429
        assert _step(client, sid, {"user_message": "hi"}).status_code == 404
        assert client.post("/copilot/sessions", json={}, headers=H).status_code == 429
        join()
        assert client.post("/copilot/sessions", json={}, headers=H).status_code == 200
        assert sess.closed is True
