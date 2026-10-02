"""Command line: run an onboarding in the terminal, serve the API, list a sponsor's history.

onboard run affiliate <file> --sponsor sponsor-a [--actor you@firm] [--yes]
onboard serve [--host 0.0.0.0] [--port 8000]
onboard history sponsor-a
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, TextIO

from ..assembly import Services, build_checkpointer, build_services
from ..config import Settings
from ..graph.build import UploadRejected, Workbench

HELP = """Commands at a gate:
  a | approve                     pass the gate
  answer <question-id> <option>   answer a brief question
  i | instruct <text>             tell the agent what to change (it proposes, you apply)
  apply                           apply the agent's last proposal
  ack-warnings                    acknowledge every open warning (you are confirming each)
  change <json list>              apply typed changes, e.g. [{"kind":"exclude_row","row":1,"reason":"blank"}]
  r | reject <reason>             reject
  ? | help                        this text"""


def _print_event(out: TextIO) -> Callable[[str, str, dict[str, Any]], None]:
    def sink(run_id: str, kind: str, payload: dict[str, Any]) -> None:
        if kind == "step":
            out.write(f"  · {payload['step_id']:<16} {payload['state']}\n")
        elif kind == "phase":
            out.write(f"== {payload['phase']} {payload['state']}\n")
        elif kind == "error":
            out.write(f"!! {payload['message']}\n")
        elif kind == "decision":
            entry = payload["entry"]
            out.write(f"  ✓ {entry['kind']} by {entry['actor']}\n")
        out.flush()

    return sink


def _show_gate(pending: dict[str, Any], snap: dict[str, Any], out: TextIO) -> None:
    gate = pending["gate"]
    out.write(f"\n--- gate: {gate} ---\n")
    if pending.get("message"):
        out.write(f"note: {pending['message']}\n")
    if gate == "brief" and snap.get("brief"):
        brief = snap["brief"]
        src = brief["source"]
        out.write(
            f"{brief.get('summary', '')}\nsheet {src['sheet']!r}, header row {src['header_row']}, "
            f"{src.get('rows_emitted', 0)} rows\n"
        )
        for b in brief["bindings"]:
            out.write(f"  {b['field']:<15} ← {b['column']!s:<24} [{b.get('route')}]  {b.get('evidence', '')}\n")
        for q in brief.get("questions", []):
            out.write(f"  ? {q['id']}: {q['text']}  options: {q['options']}\n")
    if gate == "findings":
        result = snap.get("result") or {}
        report = snap.get("report") or {}
        out.write(f"{report.get('summary', '')}\n")
        for f in result.get("findings", []):
            mark = "✓" if f.get("acknowledged") else " "
            out.write(f"  [{mark}] {f['severity']:<7} {f['code']:<38} row {f['row']}  {f['message']}\n")
        if snap.get("proposal"):
            out.write(f"proposal: {json.dumps(snap['proposal'], default=str)[:600]}\n")
    if gate == "signoff":
        for a in pending.get("artifacts", []):
            out.write(f"  {a['name']:<16} {a['bytes']:>7} bytes  sha256 {a['sha256'][:16]}…\n")
    for reason in pending.get("blocked_reasons", []):
        out.write(f"  blocked: {reason}\n")


def _parse(line: str, snap: dict[str, Any]) -> dict[str, Any] | None:
    word, _, rest = line.strip().partition(" ")
    if word in ("a", "approve"):
        return {"action": "approve"}
    if word == "answer":
        qid, _, option = rest.partition(" ")
        return {"action": "answer", "question_id": qid, "option": option.strip()}
    if word in ("i", "instruct"):
        return {"action": "instruct", "text": rest}
    if word == "apply":
        proposal = snap.get("proposal") or {}
        return {"action": "change", "changes": proposal.get("changes", [])}
    if word == "ack-warnings":
        items = (snap.get("result") or {}).get("findings", [])
        changes = [
            {"kind": "acknowledge_finding", "code": f["code"], "row": f["row"]}
            for f in items
            if f.get("requires_ack") and not f.get("acknowledged")
        ]
        return {"action": "change", "changes": changes}
    if word == "change":
        return {"action": "change", "changes": json.loads(rest)}
    if word in ("r", "reject"):
        return {"action": "reject", "reason": rest or None}
    return None


def run(
    args: argparse.Namespace,
    services: Services,
    *,
    inp: TextIO = sys.stdin,
    out: TextIO = sys.stdout,
) -> int:
    bench = Workbench(services, checkpointer=build_checkpointer(services), sink=_print_event(out))
    path = Path(args.file)
    try:
        run_id = bench.start(
            sponsor_id=args.sponsor, entity=args.entity, file_name=path.name, data=path.read_bytes(), actor=args.actor
        )
    except (UploadRejected, FileNotFoundError) as exc:
        out.write(f"cannot start: {exc}\n")
        return 2
    out.write(f"run {run_id}\n")
    while True:
        snap = bench.snapshot(run_id)
        pending = snap.get("pending")
        if pending is None:
            out.write(f"\nrun {run_id} finished: {snap.get('status')}\n")
            for a in snap.get("artifacts", []):
                out.write(f"  {bench.services.stores.objects.local_path(a['key'])}\n")
            return 0 if snap.get("status") == "locked" else 1
        _show_gate(pending, snap, out)
        if args.yes:
            response: dict[str, Any] | None = {"action": "approve"}
            if pending.get("blocked_reasons"):
                out.write("gate is blocked; --yes only approves open gates\n")
                return 1
        else:
            out.write("> ")
            out.flush()
            line = inp.readline()
            if not line:
                return 1
            if line.strip() in ("?", "help"):
                out.write(HELP + "\n")
                continue
            try:
                response = _parse(line, snap)
            except json.JSONDecodeError as exc:
                out.write(f"bad JSON: {exc}\n")
                continue
            if response is None:
                out.write("unknown command; ? for help\n")
                continue
        assert response is not None
        bench.respond(run_id, {**response, "actor": args.actor})


def history(args: argparse.Namespace, services: Services, out: TextIO = sys.stdout) -> int:
    for record in services.stores.recipes.list(args.sponsor):
        out.write(
            json.dumps(
                {
                    "fingerprint": record.fingerprint[:12],
                    "version": record.version,
                    "active": record.active,
                    "bindings": record.bindings,
                    "layout": record.layout,
                    "approved_by": record.approved_by,
                }
            )
            + "\n"
        )
    return 0


def serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("onboarding_agent.surfaces.api:app_factory", factory=True, host=args.host, port=args.port)
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="onboard", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run", help="run an onboarding in the terminal")
    r.add_argument("entity", choices=["affiliate"])
    r.add_argument("file")
    r.add_argument("--sponsor", required=True)
    r.add_argument("--actor", default="analyst")
    r.add_argument("--yes", action="store_true", help="approve every open gate (you are the approver)")
    s = sub.add_parser("serve", help="start the API")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    h = sub.add_parser("history", help="list a sponsor's confirmed bindings")
    h.add_argument("sponsor")
    return p


def main(argv: list[str] | None = None, services: Services | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "serve":
        return serve(args)
    services = services or build_services(Settings())
    try:
        if args.command == "run":
            return run(args, services)
        return history(args, services)
    finally:
        services.close()


if __name__ == "__main__":
    raise SystemExit(main())
