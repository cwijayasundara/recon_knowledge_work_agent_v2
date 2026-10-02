"""A subprocess stand-in for the sandbox container, for offline tests only.

A temporary root holds work/, in/, ref/ and skills/ (the last three copied
from the run's mounts). File operations go through a virtual-mode
FilesystemBackend over that root; commands have their /work, /in, /ref and
/skills paths rewritten. It is not isolated and is never used outside tests.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from deepagents.backends import FilesystemBackend
from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse

from onboarding_agent.sandbox.base import RunSandbox, SandboxMounts, truncate
from tests.conftest import REPO_ROOT

_MOUNT_PATH = re.compile(r"(?<![\w.\-/])/(work|in|ref|skills)(?=/|\b|$)")


class LocalSandbox(RunSandbox):
    def __init__(self, run_id: str, mounts: SandboxMounts) -> None:
        self._run_id = run_id
        self._mounts = mounts
        self._root = Path(tempfile.mkdtemp(prefix=f"onb-sbx-{run_id}-"))
        self._fs = FilesystemBackend(root_dir=self._root, virtual_mode=True)
        self.commands: list[str] = []

    @property
    def id(self) -> str:
        return f"local-{self._run_id}"

    def _sync(self) -> None:
        for name, source in (
            ("in", self._mounts.input_dir),
            ("ref", self._mounts.ref_dir),
            ("skills", self._mounts.skills_dir),
        ):
            target = self._root / name
            shutil.rmtree(target, ignore_errors=True)
            if source.exists():
                shutil.copytree(source, target)
            else:
                target.mkdir()

    def start(self) -> None:
        (self._root / "work").mkdir(exist_ok=True)
        self._sync()

    def close(self) -> None:
        shutil.rmtree(self._root, ignore_errors=True)

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        self.commands.append(command)
        self._sync()
        env = {
            "PATH": f"{Path(sys.executable).parent}:/usr/bin:/bin",
            "PYTHONPATH": str(REPO_ROOT / "packages/onboarding_sdk"),
            "HOME": str(self._root / "work"),
        }
        rewritten = _MOUNT_PATH.sub(lambda m: f"{self._root}/{m.group(1)}", command)
        proc = subprocess.run(
            ["sh", "-c", rewritten],
            cwd=self._root / "work",
            capture_output=True,
            timeout=timeout or 120,
            env=env,
            check=False,
        )
        output = (proc.stdout + proc.stderr).decode("utf-8", errors="replace").replace(f"{self._root}", "")
        text, truncated = truncate(output)
        return ExecuteResponse(output=text, exit_code=proc.returncode, truncated=truncated)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        allowed = [(p, c) for p, c in files if p == "/work" or p.startswith("/work/")]
        results = {r.path: r for r in self._fs.upload_files(allowed)} if allowed else {}
        return [results.get(p) or FileUploadResponse(path=p, error="permission_denied") for p, _ in files]

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        self._sync()
        return self._fs.download_files(paths)

    # The base class builds these on execute() with base64-encoded paths the
    # rewrite cannot see, so route them through the filesystem backend.
    def ls(self, path: str):  # type: ignore[no-untyped-def]
        return self._fs.ls(path)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000):  # type: ignore[no-untyped-def]
        self._sync()
        return self._fs.read(file_path, offset, limit)

    def write(self, file_path: str, content: str):  # type: ignore[no-untyped-def]
        if not file_path.startswith("/work/"):
            from deepagents.backends.protocol import WriteResult

            return WriteResult(error=f"permission denied: {file_path}")
        return self._fs.write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False):  # type: ignore[no-untyped-def]
        return self._fs.edit(file_path, old_string, new_string, replace_all)

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None, *args, **kwargs):  # type: ignore[no-untyped-def]
        return self._fs.grep(pattern, path, glob, *args, **kwargs)

    def glob(self, pattern: str, path: str | None = None):  # type: ignore[no-untyped-def]
        return self._fs.glob(pattern, path)


def local_sandbox_factory(run_id: str, mounts: SandboxMounts) -> LocalSandbox:
    return LocalSandbox(run_id, mounts)
