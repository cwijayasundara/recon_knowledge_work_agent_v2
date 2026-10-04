"""The Copilot step engine: one bounded model loop per request; the pane runs the client tools in Excel.

Every cap is enforced here, never trusted from the client. Tool results reach the model only inside the
``<tool_result untrusted ...>`` wrapper. Audit lines carry validated addresses and counts, never contents.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel, ValidationError

from onboarding_agent.config import Settings
from onboarding_agent.copilot.audit import audit
from onboarding_agent.copilot.rules import count_cells, parse_range, truncate_cell, valid_sheet_name
from onboarding_agent.copilot.schemas import (
    ALL_TOOLS,
    CLIENT_TOOLS,
    TOOL_MODELS,
    CheckChanges,
    ProposeChanges,
    ProposeWrite,
    ReadRange,
    RunFindings,
    StepIn,
    StepOut,
    ToolCallOut,
    ToolResultIn,
    tool_specs,
)
from onboarding_agent.copilot.sessions import Session, SessionNotFound, SessionStore
from onboarding_agent.graph.state import to_sdk

_log = logging.getLogger("onboarding_agent.copilot.engine")

PROMPT_PATH = Path(__file__).resolve().parents[3] / "instructions" / "copilot.md"
MAX_MESSAGES = 200
MAX_TRANSCRIPT_BYTES = 1_000_000
MAX_CLIENT_CALLS_PER_STEP = 16
MAX_CALLS_PER_MESSAGE = 32  # every tool call in one AI message, of any kind; extras are answered, never run
MAX_DRY_RUNS_PER_TURN = 6
MAX_PROPOSALS_PER_TURN = 10
MAX_FIND_HITS = 50
MAX_RAW_HITS = 1000
FIND_EXCERPT_CHARS = 120
MAX_SHEETS = 200
MAX_HEADERS = 50
HEADER_CHARS = 120
MAX_MERGED = 50
MAX_SELECTION_VALUES = 25
MAX_SAME_SERVER_TOOL_PER_MESSAGE = 4
SERVER_HEADROOM = 1024  # bytes a server reply may need; checked against the turn before the tool runs
EMPTY_TEXT = "The model returned no answer; please rephrase."
DISCARDED_NOTE = "Earlier proposals were discarded because the request was interrupted."
TRANSCRIPT_FULL = "budget exhausted: this message's results exceed the transcript limit; summarise"
MAX_READ_RESULT_BYTES = 256_000
MAX_LIST_ITEMS = 200
MAX_KEY_CHARS = 100
MAX_FINDINGS = 50
MAX_MESSAGE_CHARS = 200
MAX_PROPOSED_CHANGES = 100
MAX_PROPOSED_WRITES = 10
_READ_SERVER_TOOLS = frozenset({"run_state", "run_findings"})
_COUNT_KEYS = frozenset({"formulas", "constants", "blanks"})
STUB = "[older tool result omitted]"
_CALL_ID = re.compile(r"[A-Za-z0-9_-]{1,80}", re.ASCII)
_SAFE_AUDIT = ("tool", "outcome", "cells", "bytes", "step")


class StepConflict(Exception):
    """The request does not match the session state (unknown/answered call ids, or a step already running): 409."""


class RunAccess(Protocol):
    """Read-only access to the bound run, supplied by the API routes.

    ``dry_run`` receives typed ``CopilotChange`` models (they convert with ``graph.state.to_sdk``), so an
    implementation can delegate to ``tools.changes.dry_run(ctx, changes)``.
    """

    def snapshot(self, run_id: str) -> dict[str, Any]: ...

    def dry_run(self, run_id: str, changes: list[Any]) -> dict[str, Any]: ...


class _ToolError(Exception):
    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra


def load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def wrap(tool: str, payload: object) -> str:
    """JSON inside an untrusted wrapper; < > & are escaped so data can never close or forge the wrapper."""
    body = json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    body = body.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return f'<tool_result untrusted tool="{tool}">{body}</tool_result>'


def unwrap(text: str) -> Any:
    head, _, rest = text.partition(">")
    if not head.startswith("<tool_result untrusted") or not rest.endswith("</tool_result>"):
        raise ValueError("not a wrapped tool result")
    return json.loads(rest[: -len("</tool_result>")])


def _bounded(node: Any, char_limit: int, depth: int = 0) -> Any:
    """Copy JSON content with strings truncated, hidden characters stripped and list/dict lengths capped."""
    if depth > 16:
        return None
    if isinstance(node, dict):
        out = {
            str(truncate_cell(str(k), MAX_KEY_CHARS)): _bounded(v, char_limit, depth + 1)
            for k, v in list(node.items())[:MAX_LIST_ITEMS]
        }
        if len(node) > MAX_LIST_ITEMS:
            out["_omitted"] = len(node) - MAX_LIST_ITEMS
        return out
    if isinstance(node, list | tuple):
        items = [_bounded(v, char_limit, depth + 1) for v in node[:MAX_LIST_ITEMS]]
        if len(node) > MAX_LIST_ITEMS:
            items.append(f"[{len(node) - MAX_LIST_ITEMS} more items omitted]")
        return items
    if node is None or isinstance(node, str | int | float | bool):
        return truncate_cell(node, char_limit)
    return None


def _shape(ok: bool, what: str) -> None:
    if not ok:
        raise _ToolError(f"unexpected result shape: {what}")


def _keys(content: Any, allowed: set[str], required: frozenset[str] | set[str] = frozenset()) -> dict[str, Any]:
    _shape(isinstance(content, dict), "expected an object")
    assert isinstance(content, dict)
    _shape(set(content) <= allowed, f"allowed keys are {', '.join(sorted(allowed))}")
    _shape(required <= set(content), f"required keys are {', '.join(sorted(required))}")
    return content


def _sheet_name(v: Any) -> str | None:
    try:
        return valid_sheet_name(v) if isinstance(v, str) else None
    except ValueError:
        return None


def _a1(v: Any) -> str | None:
    try:
        return parse_range(v).a1() if isinstance(v, str) else None
    except ValueError:
        return None


def _is_count(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 10**12


def _error_detail(content: Any) -> str:
    """A client error is reduced to one short plain string; anything else becomes a fixed text."""
    msg = content.get("message") if isinstance(content, dict) else None
    if not isinstance(msg, str):
        return "tool failed"
    cleaned = str(truncate_cell(msg, MAX_MESSAGE_CHARS))
    cleaned = "".join(" " if ch in "\t\n\r" else ch for ch in cleaned).strip()
    return cleaned or "tool failed"


def _string_leaves(node: Any) -> int:
    if isinstance(node, dict):
        return sum(_string_leaves(v) for v in node.values())
    if isinstance(node, list):
        return sum(_string_leaves(v) for v in node)
    return 1 if isinstance(node, str) else 0


def _internal(exc: Exception) -> _ToolError:
    return _ToolError(f"internal error: {type(exc).__name__}")


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors(include_url=False, include_input=False)[:3]:
        loc = ".".join(str(p) for p in err.get("loc", ()))
        parts.append(f"{loc}: {err.get('msg', 'invalid')}"[:MAX_MESSAGE_CHARS])
    return "invalid arguments: " + "; ".join(parts)


def _text(ai: AIMessage) -> tuple[str, bool]:
    """The answer text and whether the model refused; refusal text itself is never surfaced."""
    content = ai.content
    if isinstance(content, str):
        return content, False
    parts = []
    refused = False
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") in ("text", "output_text"):
            parts.append(str(block.get("text", "")))
        elif isinstance(block, dict) and block.get("type") == "refusal":
            refused = True
    return "".join(parts), refused


def _size(m: BaseMessage) -> int:
    n = len(m.content) if isinstance(m.content, str) else len(json.dumps(m.content, default=str))
    if isinstance(m, AIMessage) and (m.tool_calls or m.invalid_tool_calls):
        n += len(json.dumps([*m.tool_calls, *m.invalid_tool_calls], default=str))
    return n


def _turn_size(sess: Session) -> int:
    msgs = sess.messages
    start = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=0)
    return sum(_size(m) for m in msgs[start:])


def _safe_audit(event: str, **fields: Any) -> None:
    """The audit rejects anything not shaped like an address or count; that must never stall the loop."""
    try:
        audit(event, **fields)
        return
    except Exception:  # a rejected field or a broken log handler must never stall the loop
        pass
    try:
        audit(event, **{k: v for k, v in fields.items() if k in _SAFE_AUDIT})
    except Exception:
        _log.warning("copilot audit event dropped: a field was rejected or the log failed")


class CopilotEngine:
    def __init__(
        self,
        settings: Settings,
        model_factory: Callable[[str], Any],
        run_access: RunAccess | None,
        store: SessionStore,
        prompt: str | None = None,
    ) -> None:
        self.settings = settings
        self._factory = model_factory
        self._runs = run_access
        self.store = store
        self._prompt = prompt if prompt is not None else load_prompt()
        self._model: Any = None

    # ---- public API ------------------------------------------------------

    def start(self, actor: str, run_id: str | None) -> Session:
        sess = self.store.create(actor, run_id)
        fields: dict[str, Any] = {"actor": actor, "session": sess.id, "outcome": "ok"}
        if run_id is not None:
            fields["run_id"] = run_id
        _safe_audit("session_start", **fields)
        return sess

    def close(self, session_id: str, actor: str) -> None:
        if self.store.delete(session_id, actor):
            _safe_audit("session_end", actor=actor, session=session_id, outcome="ok")

    def close_if_idle(self, session_id: str, actor: str) -> None:
        """Close for the API. While a step runs the session keeps its slot: StepConflict, never a freed slot."""
        sess = self.store.get(session_id, actor)
        if not sess.lock.acquire(blocking=False):
            raise StepConflict("a step is running")
        try:
            self.close(session_id, actor)
        finally:
            sess.lock.release()

    def step(self, session_id: str, actor: str, body: StepIn) -> StepOut:
        sess = self.store.get(session_id, actor)
        if not sess.lock.acquire(blocking=False):
            raise StepConflict("a step is already running for this session")
        try:
            if sess.closed:  # closed between the lookup and the lock
                raise SessionNotFound("session not found")
            if body.tool_results is not None:
                if any(r.call_id not in sess.pending for r in body.tool_results):
                    raise StepConflict("unknown or already answered call id")
                for r in body.tool_results:
                    self._client_result(sess, r)
                self._compact(sess)
                if sess.pending:
                    return self._tool_calls_out(sess)
            else:
                assert body.user_message is not None
                self._close_pending(sess)
                # Proposals left undelivered belong to an interrupted turn: never deliver them out of context.
                interrupted = bool(sess.proposed_changes or sess.proposed_writes)
                sess.proposed_changes = []
                sess.proposed_writes = []
                sess.proposal_notes = [DISCARDED_NOTE] if interrupted else []
                sess.messages.append(HumanMessage(content=body.user_message))
                sess.steps_in_turn = 0
                sess.dry_runs_in_turn = 0
                sess.proposals_in_turn = 0
                self._compact(sess)
            return self._loop(sess)
        finally:
            try:
                self._answer_orphans(sess)
            finally:
                sess.lock.release()

    def _answer_orphans(self, sess: Session) -> None:
        """Defence in depth: answer any call of the last AI message that is neither answered nor pending."""
        msgs = sess.messages
        idx = next((i for i in range(len(msgs) - 1, -1, -1) if isinstance(msgs[i], AIMessage)), None)
        if idx is None:
            return
        ai = msgs[idx]
        assert isinstance(ai, AIMessage)
        answered = {m.tool_call_id for m in msgs[idx + 1 :] if isinstance(m, ToolMessage)}
        for tc in [*ai.tool_calls, *ai.invalid_tool_calls]:
            cid = tc.get("id")
            if cid and cid not in answered and cid not in sess.pending:
                answered.add(cid)
                self._reply(sess, cid, "unknown", {"error": "internal error: the call was not run"}, ok=False)

    # ---- loop ----------------------------------------------------------------

    def _bound_model(self) -> Any:
        if self._model is None:
            self._model = self._factory("copilot").bind_tools(tool_specs())
        return self._model

    def _loop(self, sess: Session) -> StepOut:
        limit = min(self.settings.copilot_max_steps_per_turn, self.settings.max_model_calls)
        while True:
            if sess.steps_in_turn >= limit:
                _safe_audit("cap_hit", session=sess.id, step=sess.steps_in_turn, outcome="cap")
                return self._final(sess, "I stopped at the step limit for this message.", ["step limit reached"])
            sess.steps_in_turn += 1
            try:
                ai = self._bound_model().invoke([SystemMessage(content=self._prompt), *sess.messages])
                if not isinstance(ai, AIMessage):
                    raise TypeError("model returned a non-AI message")
            except Exception as exc:  # the model or its client failed; only the type name is ever surfaced
                _safe_audit("error", session=sess.id, step=sess.steps_in_turn, outcome="error")
                text = f"The model could not complete this step: {type(exc).__name__}"
                return self._final(sess, text, ["model error"])
            _safe_audit("step", session=sess.id, step=sess.steps_in_turn, outcome="ok")
            # A call without an id can never be answered, and OpenAI rejects an unanswered call: drop it.
            ai = ai.model_copy(
                update={
                    "tool_calls": [tc for tc in ai.tool_calls if tc.get("id")],
                    "invalid_tool_calls": [tc for tc in ai.invalid_tool_calls if tc.get("id")],
                }
            )
            sess.messages.append(ai)
            client_calls = self._dispatch(sess, ai)
            self._compact(sess)
            if client_calls:
                return StepOut(status="tool_calls", tool_calls=client_calls)
            if not ai.tool_calls and not ai.invalid_tool_calls:
                text, refused = _text(ai)
                notes = ["the model declined to answer"] if refused else []
                if not text.strip():
                    text = EMPTY_TEXT
                    notes.append("empty answer")
                return self._final(sess, text, notes)

    def _final(self, sess: Session, text: str, notes: list[str]) -> StepOut:
        """Deliver this turn's proposals, then forget them."""
        out = StepOut(
            status="final",
            text=text,
            proposed_changes=list(sess.proposed_changes),
            proposed_writes=list(sess.proposed_writes),
            notes=[*notes, *sess.proposal_notes],
        )
        sess.proposed_changes = []
        sess.proposed_writes = []
        sess.proposal_notes = []
        return out

    def _tool_calls_out(self, sess: Session) -> StepOut:
        calls = [ToolCallOut(id=cid, name=name, args=args) for cid, (name, args) in sess.pending.items()]
        return StepOut(status="tool_calls", tool_calls=calls)

    def _close_pending(self, sess: Session) -> None:
        """Answer calls the client never returned, so no tool call is left unanswered in the transcript."""
        for cid, (name, _) in list(sess.pending.items()):
            self._reply(sess, cid, name, {"error": "no result was returned for this call"}, ok=False)
            _safe_audit("tool_result", session=sess.id, tool=name, step=sess.steps_in_turn, outcome="aborted")
        sess.pending.clear()

    def _dispatch(self, sess: Session, ai: AIMessage) -> list[ToolCallOut]:
        """Answer server, proposal and rejected calls inline; return valid client calls for the pane."""
        client: list[ToolCallOut] = []
        seen: set[str] = set()
        per_tool: dict[str, int] = {}
        over = 0
        for bad in ai.invalid_tool_calls:
            cid = bad.get("id") or ""
            if cid in seen:
                continue
            seen.add(cid)
            self._reply(sess, cid, "unknown", {"error": "the tool call arguments were not valid JSON"}, ok=False)
            _safe_audit("tool_call", session=sess.id, tool="unknown", step=sess.steps_in_turn, outcome="rejected")
        for tc in ai.tool_calls:
            cid = tc.get("id") or ""
            if cid in seen:
                continue
            seen.add(cid)
            if len(seen) > MAX_CALLS_PER_MESSAGE:
                over += 1
                self._reply(sess, cid, "unknown", {"error": "too many tool calls in one message; not run"}, ok=False)
                continue
            name = tc["name"]
            if name in _READ_SERVER_TOOLS:  # check_changes is bounded by the per-turn dry-run cap instead
                per_tool[name] = per_tool.get(name, 0) + 1
                if per_tool[name] > MAX_SAME_SERVER_TOOL_PER_MESSAGE:
                    over += 1
                    self._reply(sess, cid, name, {"error": f"too many {name} calls in one message; not run"}, ok=False)
                    continue
            self._call(sess, cid, name, tc.get("args") or {}, client)
        if over:
            _safe_audit("cap_hit", session=sess.id, tool="unknown", step=sess.steps_in_turn, outcome="cap")
        return client

    def _call(self, sess: Session, cid: str, name: str, raw_args: Any, client: list[ToolCallOut]) -> None:
        tool = name if name in ALL_TOOLS else "unknown"
        where: dict[str, Any] = {}
        try:
            try:
                if name not in TOOL_MODELS:
                    raise _ToolError(f"unknown tool; available tools: {', '.join(sorted(ALL_TOOLS))}")
                if not _CALL_ID.fullmatch(cid):
                    raise _ToolError("invalid tool call id")
                try:
                    parsed = TOOL_MODELS[name].model_validate(raw_args)
                except ValidationError as exc:
                    raise _ToolError(_validation_message(exc)) from None
                # The range is canonical A1; the sheet name is model-supplied text (it could carry injected words)
                # and is logged only on an ok tool_result, once the workbook has confirmed it.
                if isinstance(parsed, ReadRange | ProposeWrite):
                    where["range"] = parsed.range
                if name in CLIENT_TOOLS:
                    if len(client) >= MAX_CLIENT_CALLS_PER_STEP:
                        raise _ToolError("too many workbook tool calls in one step; ask for fewer at a time")
                    args = self._client_args(parsed)
                    _safe_audit(
                        "tool_call",
                        actor=sess.actor,
                        session=sess.id,
                        tool=name,
                        step=sess.steps_in_turn,
                        outcome="ok",
                        **where,
                    )
                    # Registered last, so nothing above can leave a call both answered and pending.
                    sess.pending[cid] = (name, args)
                    client.append(ToolCallOut(id=cid, name=name, args=args))
                    return
                self._fits_turn(sess, SERVER_HEADROOM)
                payload = self._server(sess, name, parsed)
            except _ToolError:
                raise
            except Exception as exc:  # a handler bug must still answer the call, without its text
                raise _internal(exc) from None
        except _ToolError as err:
            n, _ = self._reply(sess, cid, tool, {"error": err.message, **err.extra}, ok=False)
            _safe_audit(
                "tool_call",
                actor=sess.actor,
                session=sess.id,
                tool=tool,
                bytes=n,
                step=sess.steps_in_turn,
                outcome="rejected",
                **where,
            )
            return
        n, fitted = self._reply(sess, cid, name, payload, ok=True)
        event = "proposal" if name.startswith("propose_") else "tool_call"
        outcome = "ok" if fitted else "cap"
        _safe_audit(
            event,
            actor=sess.actor,
            session=sess.id,
            tool=name,
            bytes=n,
            step=sess.steps_in_turn,
            outcome=outcome,
            **where,
        )

    def _reply(self, sess: Session, cid: str, tool: str, payload: dict[str, Any], *, ok: bool) -> tuple[int, bool]:
        """Answer a call. A reply that would overflow the turn is replaced by a short budget error.

        Returns the stored size and whether the original reply was kept.
        """
        content = wrap(tool, {"ok": ok, **payload})
        kept = _turn_size(sess) + len(content) <= MAX_TRANSCRIPT_BYTES
        if not kept:
            content = wrap(tool, {"ok": False, "error": TRANSCRIPT_FULL})
            ok = False
        sess.messages.append(ToolMessage(content=content, tool_call_id=cid, status="success" if ok else "error"))
        return len(content), kept

    # ---- client tools ---------------------------------------------------------

    def _client_args(self, parsed: BaseModel) -> dict[str, Any]:
        if isinstance(parsed, ReadRange):
            spec = parse_range(parsed.range)
            cap = self.settings.copilot_max_cells_per_call
            if spec.cells > cap:
                raise _ToolError(
                    f"range too large: {spec.cells} cells requested, the per-call cap is {cap}; read a smaller range"
                )
            return {"sheet": parsed.sheet, "range": spec.a1()}
        return parsed.model_dump(exclude_none=True)

    def _client_result(self, sess: Session, result: ToolResultIn) -> None:
        name, args = sess.pending.pop(result.call_id)
        where = {"range": args["range"]} if "range" in args else {}
        cells = 0
        try:
            try:
                if not result.ok:
                    raise _ToolError("the workbook tool failed", detail=_error_detail(result.content))
                if name == "read_range":
                    payload, cells = self._read_payload(sess, args, result.content)
                else:
                    payload, cells = self._shaped(name, result.content)
                self._charge(sess, cells)
                content = wrap(name, {"ok": True, **payload})
                self._fits_turn(sess, len(content))
            except _ToolError:
                raise
            except Exception as exc:  # a handler bug must still answer the call, without its text
                raise _internal(exc) from None
        except _ToolError as err:
            n, _ = self._reply(sess, result.call_id, name, {"error": err.message, **err.extra}, ok=False)
            outcome = "cap" if err.message.startswith("budget exhausted") else "error"
            _safe_audit(
                "tool_result",
                actor=sess.actor,
                session=sess.id,
                tool=name,
                bytes=n,
                step=sess.steps_in_turn,
                outcome=outcome,
                **where,
            )
            return
        sess.messages.append(ToolMessage(content=content, tool_call_id=result.call_id, status="success"))
        sess.cells_read += cells
        _safe_audit(
            "tool_result",
            actor=sess.actor,
            session=sess.id,
            tool=name,
            cells=cells,
            bytes=len(content),
            step=sess.steps_in_turn,
            outcome="ok",
            **where,
            **({"sheet": args["sheet"]} if "sheet" in args else {}),  # the workbook confirmed it
        )

    def _charge(self, sess: Session, cells: int) -> None:
        cap = self.settings.copilot_max_cells_per_session
        if cells and sess.cells_read + cells > cap:
            raise _ToolError(
                f"budget exhausted: the session read budget of {cap} cells is used up; summarise what you have"
            )

    @staticmethod
    def _fits_turn(sess: Session, size: int) -> None:
        """Results the model has not seen yet are never stubbed, so a turn that would overflow is refused instead."""
        if _turn_size(sess) + size > MAX_TRANSCRIPT_BYTES:
            raise _ToolError(TRANSCRIPT_FULL)

    def _shaped(self, name: str, content: Any) -> tuple[dict[str, Any], int]:
        """Fixed result schemas for the non-read client tools; the session is charged for every text leaf."""
        if name == "list_sheets":
            c = _keys(content, {"sheets"}, {"sheets"})
            sheets = c["sheets"]
            _shape(isinstance(sheets, list) and len(sheets) <= MAX_SHEETS, f"sheets must be a list of <= {MAX_SHEETS}")
            names = [_sheet_name(n) for n in sheets]
            _shape(all(n is not None for n in names), "sheets must be valid sheet names")
            return {"sheets": names}, len(names)
        if name == "describe_sheet":
            payload = self._describe(content)
            return payload, _string_leaves(payload)
        if name == "get_selection":
            return self._selection(content)
        if name == "find":
            payload = self._find(content)
            return payload, _string_leaves(payload["hits"])
        raise _ToolError("tool is not available")

    @staticmethod
    def _describe(content: Any) -> dict[str, Any]:
        c = _keys(content, {"used_range", "headers", "merged", "counts"})
        used = c.get("used_range")
        if used is not None:
            used = _a1(used)
            _shape(used is not None, "used_range must be an A1 range or null")
        headers = c.get("headers", [])
        _shape(isinstance(headers, list) and len(headers) <= MAX_HEADERS, f"headers must be a list of <= {MAX_HEADERS}")
        _shape(all(isinstance(h, str) for h in headers), "headers must be strings")
        merged = c.get("merged", [])
        _shape(isinstance(merged, list) and len(merged) <= MAX_MERGED, f"merged must be a list of <= {MAX_MERGED}")
        merged_a1 = [_a1(m) for m in merged]
        _shape(all(m is not None for m in merged_a1), "merged must be A1 ranges")
        counts = c.get("counts", {})
        _shape(isinstance(counts, dict) and set(counts) <= _COUNT_KEYS, "counts allows formulas, constants, blanks")
        _shape(all(_is_count(v) for v in counts.values()), "counts must be non-negative integers")
        return {
            "used_range": used,
            "headers": [truncate_cell(h, HEADER_CHARS) for h in headers],
            "merged": merged_a1,
            "counts": dict(counts),
        }

    def _selection(self, content: Any) -> tuple[dict[str, Any], int]:
        c = _keys(content, {"sheet", "address", "cells", "values"}, {"sheet", "address", "cells"})
        sheet, address = _sheet_name(c["sheet"]), _a1(c["address"])
        _shape(sheet is not None and address is not None, "sheet must be a sheet name and address an A1 range")
        _shape(_is_count(c["cells"]), "cells must be a non-negative integer")
        payload: dict[str, Any] = {"sheet": sheet, "address": address, "cells": c["cells"]}
        n = 0
        if "values" in c:
            values = c["values"]
            _shape(isinstance(values, list), "values must be a 2D list")
            try:
                n = count_cells(values)
            except ValueError:
                raise _ToolError("unexpected result shape: values must be a 2D list of scalars") from None
            _shape(
                n <= MAX_SELECTION_VALUES, f"values are only returned for selections of <= {MAX_SELECTION_VALUES} cells"
            )
            limit = self.settings.copilot_cell_char_limit
            payload["values"] = [[truncate_cell(v, limit) for v in row] for row in values]
        return payload, 2 + n

    def _find(self, content: Any) -> dict[str, Any]:
        c = _keys(content, {"hits", "truncated"}, {"hits"})
        hits = c["hits"]
        _shape(isinstance(hits, list) and len(hits) <= MAX_RAW_HITS, f"hits must be a list of <= {MAX_RAW_HITS}")
        _shape(c.get("truncated") in (None, True, False), "truncated must be a boolean")
        excerpt = min(FIND_EXCERPT_CHARS, self.settings.copilot_cell_char_limit)
        out: list[dict[str, Any]] = []
        dropped = 0
        used = 0
        for hit in hits:
            if len(out) >= MAX_FIND_HITS:
                break
            used += 1
            ok = isinstance(hit, dict) and set(hit) == {"sheet", "address", "text"} and isinstance(hit["text"], str)
            sheet = _sheet_name(hit["sheet"]) if ok else None
            address = _a1(hit["address"]) if ok else None
            if sheet is None or address is None:
                dropped += 1  # hits failing validation are dropped, never passed on
                continue
            out.append({"sheet": sheet, "address": address, "text": truncate_cell(hit["text"], excerpt)})
        truncated = used < len(hits) or c.get("truncated") is True
        return {"hits": out, "truncated": truncated, "dropped": dropped}

    def _read_payload(self, sess: Session, args: dict[str, Any], content: Any) -> tuple[dict[str, Any], int]:
        """Validate a read_range result against the requested range; sizes declared by the client are ignored.

        Each grid (values, formulas) must fit the request and the per-call cap; the session is charged for the
        larger grid, since formulas describe the same cells as values.
        """
        spec = parse_range(args["range"])
        if not isinstance(content, dict) or not isinstance(content.get("values"), list):
            raise _ToolError("malformed read_range result: values must be a 2D list")
        values = content["values"]
        formulas = content.get("formulas")
        if formulas is not None and not isinstance(formulas, list):
            raise _ToolError("malformed read_range result: formulas must be a 2D list")
        grids = [values] if formulas is None else [values, formulas]
        try:
            counts = [count_cells(g) for g in grids]
        except ValueError:
            raise _ToolError("malformed read_range result: values must be a 2D list of scalars") from None
        for grid in grids:
            if len(grid) > spec.rows or any(len(row) > spec.cols for row in grid):
                raise _ToolError("malformed read_range result: larger than the requested range")
        cap_call = self.settings.copilot_max_cells_per_call
        for n in counts:
            if n > cap_call:
                raise _ToolError(
                    f"budget exhausted: a result grid has {n} cells, over the per-call cap of {cap_call}; "
                    "read a smaller range or summarise what you have"
                )
        cells = max(counts)
        self._charge(sess, cells)
        limit = self.settings.copilot_cell_char_limit
        payload: dict[str, Any] = {
            "sheet": args["sheet"],
            "range": spec.a1(),
            "rows": len(values),
            "cols": max((len(r) for r in values), default=0),
            "values": [[truncate_cell(c, limit) for c in row] for row in values],
            "truncated": content.get("truncated") is True,
        }
        if formulas is not None:
            payload["formulas"] = [[truncate_cell(c, limit) for c in row] for row in formulas]
        if len(wrap("read_range", payload)) > MAX_READ_RESULT_BYTES:
            raise _ToolError("result too large: read a smaller range")
        return payload, cells

    # ---- server and proposal tools ---------------------------------------------

    def _server(self, sess: Session, name: str, parsed: BaseModel) -> dict[str, Any]:
        if isinstance(parsed, ProposeWrite | ProposeChanges):
            if sess.proposals_in_turn >= MAX_PROPOSALS_PER_TURN:
                raise _ToolError("too many proposals in this turn; summarise what you proposed")
            if isinstance(parsed, ProposeWrite):
                out = self._propose_write(sess, parsed)
            else:
                out = self._propose_changes(sess, parsed)
            sess.proposals_in_turn += 1  # only successful proposals count
            return out
        if name == "run_state":
            return {"result": self._run_state(sess)}
        if isinstance(parsed, RunFindings):
            return {"result": self._run_findings(sess, parsed.severity)}
        if isinstance(parsed, CheckChanges):
            return {"result": self._dry_run(sess, parsed.changes)}
        raise _ToolError("tool is not available")

    def _run(self, sess: Session) -> tuple[RunAccess, str]:
        if sess.run_id is None or self._runs is None:
            raise _ToolError("no active run: this session is not bound to an onboarding run")
        return self._runs, sess.run_id

    def _snapshot(self, sess: Session) -> dict[str, Any]:
        runs, run_id = self._run(sess)
        try:
            snap = runs.snapshot(run_id)
        except KeyError:
            raise _ToolError("run not found") from None
        except Exception as exc:
            raise _ToolError(f"run state unavailable: {type(exc).__name__}") from None
        return snap if isinstance(snap, dict) else {}

    def _run_state(self, sess: Session) -> dict[str, Any]:
        snap = self._snapshot(sess)
        pending = snap.get("pending") if isinstance(snap.get("pending"), dict) else {}
        result = snap.get("result") if isinstance(snap.get("result"), dict) else {}
        layout = snap.get("layout") if isinstance(snap.get("layout"), dict) else {}
        assert pending is not None and result is not None and layout is not None
        findings = result.get("findings")
        counts: dict[str, Any] = {
            k: result[k]
            for k in ("rows_emitted", "rows_dropped", "errors", "ack_required", "publishable")
            if k in result
        }
        counts["findings"] = len(findings) if isinstance(findings, list) else 0
        counts["findings_by_code"] = result.get("findings_by_code") or {}
        state: dict[str, Any] = {
            "status": snap.get("status"),
            "phase": snap.get("phase"),
            "gate": pending.get("gate"),
            "allowed_actions": pending.get("allowed_actions")
            if isinstance(pending.get("allowed_actions"), list)
            else [],
            "counts": counts,
            "layout": {"sheet": layout.get("sheet"), "header_row": layout.get("header_row")} if layout else None,
            "bindings": snap.get("bindings") if isinstance(snap.get("bindings"), dict) else None,
        }
        return dict(_bounded(state, MAX_MESSAGE_CHARS))

    def _run_findings(self, sess: Session, severity: str | None) -> dict[str, Any]:
        result = self._snapshot(sess).get("result")
        findings = result.get("findings") if isinstance(result, dict) else None
        items = [f for f in findings if isinstance(f, dict)] if isinstance(findings, list) else []
        if severity is not None:
            items = [f for f in items if f.get("severity") == severity]
        shown = [
            {"code": f.get("code"), "severity": f.get("severity"), "row": f.get("row"), "message": f.get("message")}
            for f in items[:MAX_FINDINGS]
        ]
        return {"total": len(items), "findings": _bounded(shown, MAX_MESSAGE_CHARS)}

    @staticmethod
    def _check_sdk(changes: list[Any]) -> None:
        for i, change in enumerate(changes):
            try:
                to_sdk(change)
            except (ValueError, TypeError):
                raise _ToolError(f"change {i} is not a valid typed change") from None

    def _dry_run(self, sess: Session, changes: list[Any]) -> dict[str, Any]:
        runs, run_id = self._run(sess)
        self._check_sdk(changes)
        if sess.dry_runs_in_turn >= MAX_DRY_RUNS_PER_TURN:
            raise _ToolError("dry-run limit reached this turn; summarise what you have")
        sess.dry_runs_in_turn += 1
        try:
            impact = runs.dry_run(run_id, list(changes))
        except Exception as exc:
            raise _ToolError(f"dry run failed: {type(exc).__name__}") from None
        if not isinstance(impact, dict):
            raise _ToolError("dry run failed")

        def _list(key: str) -> list[Any]:
            v = impact.get(key)
            return v[:20] if isinstance(v, list) else []

        rows = impact.get("rows_changed")
        out = {
            "violations": _list("violations"),
            "requires_rebuild": bool(impact.get("requires_rebuild")),
            "rows_changed": len(rows) if isinstance(rows, list) else 0,
            "findings_added": _list("findings_added"),
            "findings_removed": _list("findings_removed"),
            "publishable_before": bool(impact.get("publishable_before")),
            "publishable_after": bool(impact.get("publishable_after")),
        }
        return dict(_bounded(out, MAX_MESSAGE_CHARS))

    def _propose_changes(self, sess: Session, parsed: ProposeChanges) -> dict[str, Any]:
        if len(sess.proposed_changes) + len(parsed.changes) > MAX_PROPOSED_CHANGES:
            raise _ToolError("too many proposed changes in this turn")
        impact = self._dry_run(sess, parsed.changes)  # refuses with "no active run" when no run is bound
        if impact["violations"]:
            raise _ToolError("changes refused", violations=impact["violations"])
        sess.proposed_changes.extend(parsed.changes)
        sess.proposal_notes.append(f"Proposal: {parsed.restated}")
        return {"message": "proposal recorded; the analyst reviews and applies it"}

    def _propose_write(self, sess: Session, parsed: ProposeWrite) -> dict[str, Any]:
        cells = parse_range(parsed.range).cells
        cap = self.settings.copilot_max_write_cells
        if cells > cap:
            raise _ToolError(f"write too large: {cells} cells, the write cap is {cap}")
        if len(sess.proposed_writes) >= MAX_PROPOSED_WRITES:
            raise _ToolError("too many write proposals in this turn")
        sess.proposed_writes.append(parsed)
        return {"message": "proposal recorded; the analyst reviews and applies it", "range": parsed.range}

    # ---- transcript bounds -------------------------------------------------------

    def _compact(self, sess: Session) -> None:
        """Bound the transcript: stub old tool results, then drop whole turns from the front.

        A turn starts at a HumanMessage, so an AI tool call and its ToolMessages always leave together.
        """
        msgs = sess.messages
        total = sum(_size(m) for m in msgs)
        last_human = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=0)
        for i, m in enumerate(msgs):
            if total <= MAX_TRANSCRIPT_BYTES:
                break
            if i >= last_human:
                break
            if isinstance(m, ToolMessage) and m.content != STUB:
                total -= _size(m) - len(STUB)
                msgs[i] = ToolMessage(content=STUB, tool_call_id=m.tool_call_id, status=m.status)
        while len(msgs) > MAX_MESSAGES or total > MAX_TRANSCRIPT_BYTES:
            nxt = next((i for i, m in enumerate(msgs) if i > 0 and isinstance(m, HumanMessage)), None)
            if nxt is None:
                break
            total -= sum(_size(m) for m in msgs[:nxt])
            del msgs[:nxt]
        if total > MAX_TRANSCRIPT_BYTES:  # one oversized turn left: stub results the model has already seen
            last_ai = max((i for i, m in enumerate(msgs) if isinstance(m, AIMessage)), default=0)
            for i, m in enumerate(msgs[:last_ai]):
                if total <= MAX_TRANSCRIPT_BYTES:
                    break
                if isinstance(m, ToolMessage) and m.content != STUB:
                    total -= _size(m) - len(STUB)
                    msgs[i] = ToolMessage(content=STUB, tool_call_id=m.tool_call_id, status=m.status)
