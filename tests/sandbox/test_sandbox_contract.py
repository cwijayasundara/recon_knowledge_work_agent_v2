"""Offline checks of the sandbox isolation contract and the executor app."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from onboarding_agent.sandbox.base import SandboxMounts
from onboarding_agent.sandbox.docker_backend import DockerSandbox
from tests.conftest import REPO_ROOT


def _mounts(tmp_path: Path) -> SandboxMounts:
    for name in ("in", "ref", "skills"):
        (tmp_path / name).mkdir()
    return SandboxMounts(tmp_path / "in", tmp_path / "ref", tmp_path / "skills")


def test_docker_run_kwargs_isolate(tmp_path: Path) -> None:
    kwargs = DockerSandbox("run-1", _mounts(tmp_path)).run_kwargs()
    assert kwargs["network_mode"] == "none"
    assert kwargs["read_only"] is True
    assert kwargs["environment"] == {}
    assert kwargs["cap_drop"] == ["ALL"]
    assert "/work" in kwargs["tmpfs"]
    modes = {v["bind"]: v["mode"] for v in kwargs["volumes"].values()}
    assert modes == {"/in": "ro", "/ref": "ro", "/skills": "ro"}
    assert kwargs["labels"] == {"onb.run_id": "run-1"}
    assert kwargs["mem_limit"] == "1g"


class _FakeContainer:
    id = "abc123"

    def __init__(self) -> None:
        self.removed = False
        self.archives: list[tuple[str, bytes]] = []

    def exec_run(self, cmd, workdir=None, demux=False):  # type: ignore[no-untyped-def]
        self.commands = [*getattr(self, "commands", []), cmd]

        class R:
            exit_code = 0
            output = b"hello\n"

        return R()

    def put_archive(self, path: str, data: bytes) -> bool:
        self.archives.append((path, data))
        return True

    def remove(self, force: bool = False) -> None:
        self.removed = True


class _FakeClient:
    def __init__(self) -> None:
        self.container = _FakeContainer()
        self.kwargs: dict[str, object] = {}
        outer = self

        class Containers:
            def list(self, all: bool, filters: dict) -> list:  # type: ignore[type-arg]
                return []

            def run(self, **kwargs):  # type: ignore[no-untyped-def]
                outer.kwargs = kwargs
                return outer.container

        self.containers = Containers()


def test_docker_lifecycle_and_upload_guard(tmp_path: Path) -> None:
    client = _FakeClient()
    with DockerSandbox("run-1", _mounts(tmp_path), client=client) as sandbox:
        assert sandbox.id == "abc123"
        assert sandbox.execute("echo hello").output == "hello\n"
        ok, denied = sandbox.upload_files([("/work/recipe.py", b"x"), ("/in/evil.csv", b"x")])
        assert ok.error is None
        assert denied.error == "permission_denied"
        assert all("/in/" not in " ".join(c) for c in client.container.commands)
    assert client.container.removed


def _executor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SANDBOX_ROOT", str(tmp_path))
    spec = importlib.util.spec_from_file_location("executor_app", REPO_ROOT / "sandbox/executor/app.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["executor_app"] = module
    spec.loader.exec_module(module)
    return TestClient(module.app)


def test_executor_exec_and_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _executor(tmp_path, monkeypatch)
    assert client.get("/health").json() == {"status": "ok"}
    assert client.put("/files", params={"path": "/work/a.txt"}, content=b"hi").status_code == 200
    assert client.get("/files", params={"path": "/work/a.txt"}).content == b"hi"
    result = client.post("/exec", json={"cmd": "cat a.txt; exit 3"}).json()
    assert result == {"output": "hi", "exit_code": 3, "truncated": False}


def test_executor_refuses_paths_outside_work(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _executor(tmp_path, monkeypatch)
    assert client.put("/files", params={"path": "/etc/evil"}, content=b"x").status_code == 403
    assert client.put("/files", params={"path": "/work/../../escape"}, content=b"x").status_code == 403
    assert client.get("/files", params={"path": "/etc/passwd"}).status_code == 403


def test_executor_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _executor(tmp_path, monkeypatch)
    assert client.post("/exec", json={"cmd": "sleep 5", "timeout": 1}).json()["exit_code"] == 124


def test_aca_backend_against_executor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from onboarding_sdk import recipes

    from onboarding_agent.sandbox.aca_backend import AcaSessionSandbox
    from tests.conftest import FIXTURE_DIR

    client = _executor(tmp_path / "box", monkeypatch)
    seen: list[dict[str, str]] = []

    import httpx

    class Recorder(httpx.BaseTransport):
        def handle_request(self, request: httpx.Request) -> httpx.Response:
            seen.append({"auth": request.headers["authorization"], "identifier": request.url.params["identifier"]})
            r = client.request(
                request.method,
                request.url.path,
                params=dict(request.url.params),
                content=request.read(),
                headers={"content-type": request.headers.get("content-type", "")},
            )
            return httpx.Response(
                r.status_code, content=r.content, headers={"content-type": r.headers.get("content-type", "")}
            )

    mounts = _mounts(tmp_path)
    (mounts.input_dir / "clean.csv").write_bytes((FIXTURE_DIR / "clean.csv").read_bytes())
    (mounts.ref_dir / "bindings.json").write_text("{}")
    box = AcaSessionSandbox(
        "run-9", mounts, endpoint="https://pool.example/", token=lambda: "tok", transport=Recorder()
    )
    with box:
        assert box.execute("ls ../in").output.strip() == "clean.csv"
        # Sealed: the agent's shell can no longer change the upload.
        assert box.execute("touch ../in/x").exit_code != 0
        source = recipes.standard({"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}, "clean", 1)
        assert (
            box.upload_files([("/work/recipe.py", source.encode()), ("/in/evil", b"x")])[1].error == "permission_denied"
        )
        assert box.download_files(["/work/recipe.py"])[0].content == source.encode()
        assert box.download_files(["/work/missing.py"])[0].error == "file_not_found"
    assert all(s == {"auth": "Bearer tok", "identifier": "run-9"} for s in seen)
