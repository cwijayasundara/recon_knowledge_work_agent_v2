"""Sandbox executor: run a command and move files in the sandbox's directories.

Used by the Azure Container Apps session backend. It runs inside the sandbox
container, so it holds no secrets and has no network egress.

ACA sessions cannot bind-mount /in, /ref and /skills, so the host writes them
once and then calls /seal; after that only /work is writable.
SANDBOX_ROOT prefixes every path (empty in the container; a temp dir in tests).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

MAX_OUTPUT = 100_000
MOUNTS = ("/in", "/work", "/ref", "/skills")

app = FastAPI(title="onboarding sandbox executor")
_state = {"sealed": False}


def _root() -> str:
    return os.environ.get("SANDBOX_ROOT", "")


def _real(path: str) -> Path:
    return Path(_root() + path)


def _work_dir() -> Path:
    return _real("/work")


def _resolve(path: str, *, write: bool) -> Path:
    if not path.startswith("/"):
        path = "/work/" + path
    target = _real(path).resolve()
    allowed = ("/work",) if write and _state["sealed"] else MOUNTS
    roots = [_real(m).resolve() for m in allowed]
    if not any(target == root or root in target.parents for root in roots):
        raise HTTPException(403, f"path {path!r} is outside the sandbox work area")
    return target


class ExecRequest(BaseModel):
    cmd: str
    timeout: int = Field(default=120, ge=1, le=900)


class ExecResponse(BaseModel):
    output: str
    exit_code: int | None
    truncated: bool


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/exec")
def execute(request: ExecRequest) -> ExecResponse:
    _work_dir().mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            ["sh", "-c", request.cmd], cwd=_work_dir(), capture_output=True, timeout=request.timeout, check=False
        )
    except subprocess.TimeoutExpired:
        return ExecResponse(output=f"timed out after {request.timeout}s", exit_code=124, truncated=False)
    output = (proc.stdout + proc.stderr).decode("utf-8", errors="replace")
    return ExecResponse(output=output[:MAX_OUTPUT], exit_code=proc.returncode, truncated=len(output) > MAX_OUTPUT)


@app.put("/files")
async def put_file(request: Request, path: str = Query(...)) -> dict[str, str]:
    target = _resolve(path, write=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(await request.body())
    return {"path": path}


@app.get("/files")
def get_file(path: str = Query(...)) -> Response:
    target = _resolve(path, write=False)
    if target.is_dir():
        raise HTTPException(400, "is a directory")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    return Response(target.read_bytes(), media_type="application/octet-stream")


@app.post("/seal")
def seal() -> dict[str, bool]:
    """Make /in, /ref and /skills read-only for the rest of the session."""
    for mount in ("/in", "/ref", "/skills"):
        root = _real(mount)
        if root.exists():
            for path in [root, *root.rglob("*")]:
                path.chmod(path.stat().st_mode & 0o555)
    _state["sealed"] = True
    return {"sealed": True}
