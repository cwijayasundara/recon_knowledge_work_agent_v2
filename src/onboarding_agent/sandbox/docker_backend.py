"""Docker sandbox: ``--network none``, read-only root, tmpfs /work, no environment."""

from __future__ import annotations

import base64
import posixpath
import shlex
from typing import Any

from deepagents.backends.protocol import (
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
)

from .base import (
    DEFAULT_TIMEOUT_S,
    IN_DIR,
    REF_DIR,
    SKILLS_DIR,
    WORK_DIR,
    RunSandbox,
    SandboxMounts,
    truncate,
)

CLEAN_ENV = "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1"
UPLOAD_CHUNK = 64 * 1024


def _chunks(text: str) -> list[str]:
    return [text[i : i + UPLOAD_CHUNK] for i in range(0, len(text), UPLOAD_CHUNK)] or [""]


class DockerSandbox(RunSandbox):
    def __init__(
        self,
        run_id: str,
        mounts: SandboxMounts,
        *,
        image: str = "onb-sandbox",
        client: Any | None = None,
    ) -> None:
        self._run_id = run_id
        self._mounts = mounts
        self._image = image
        self._client = client
        self._container: Any | None = None

    @property
    def id(self) -> str:
        return self._container.id if self._container is not None else f"onb-{self._run_id}"

    def _docker(self) -> Any:
        if self._client is None:
            import docker

            self._client = docker.from_env()
        return self._client

    def run_kwargs(self) -> dict[str, Any]:
        """Container settings. Kept separate so the isolation contract is testable."""
        return {
            "image": self._image,
            "command": ["sleep", "infinity"],
            "detach": True,
            "network_mode": "none",
            "read_only": True,
            "tmpfs": {WORK_DIR: "rw,size=256m,uid=1000,gid=1000", "/tmp": "rw,size=64m"},
            "volumes": {
                str(self._mounts.input_dir.resolve()): {"bind": IN_DIR, "mode": "ro"},
                str(self._mounts.ref_dir.resolve()): {"bind": REF_DIR, "mode": "ro"},
                str(self._mounts.skills_dir.resolve()): {"bind": SKILLS_DIR, "mode": "ro"},
            },
            "environment": {},
            "user": "runner",
            "working_dir": WORK_DIR,
            "mem_limit": "1g",
            "nano_cpus": 1_000_000_000,
            "pids_limit": 256,
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges"],
            "labels": {"onb.run_id": self._run_id},
            "name": f"onb-sandbox-{self._run_id}",
        }

    def start(self) -> None:
        if self._container is None:
            # A container left by a previous process for this run (a restart) is replaced.
            for old in self._docker().containers.list(all=True, filters={"label": f"onb.run_id={self._run_id}"}):
                old.remove(force=True)
            self._container = self._docker().containers.run(**self.run_kwargs())

    def close(self) -> None:
        if self._container is not None:
            self._container.remove(force=True)
            self._container = None

    def _require(self) -> Any:
        if self._container is None:
            raise RuntimeError("sandbox is not started")
        return self._container

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        seconds = timeout or DEFAULT_TIMEOUT_S
        # env -i: a command sees only this minimal environment, never the image's ENV.
        wrapped = f"{CLEAN_ENV} timeout {int(seconds)} sh -c {shlex.quote(command)}"
        result = self._require().exec_run(["sh", "-c", wrapped], workdir=WORK_DIR, demux=False)
        output = (result.output or b"").decode("utf-8", errors="replace")
        if result.exit_code == 124:
            output += f"\n[timed out after {seconds}s]"
        text, truncated = truncate(output)
        return ExecuteResponse(output=text, exit_code=result.exit_code, truncated=truncated)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        # Docker's archive API refuses a read-only root filesystem even for the
        # /work tmpfs, so files go in through exec, base64 in chunks.
        container = self._require()
        responses: list[FileUploadResponse] = []
        for path, content in files:
            normal = posixpath.normpath(path)
            if not (normal == WORK_DIR or normal.startswith(WORK_DIR + "/")):
                responses.append(FileUploadResponse(path=path, error="permission_denied"))
                continue
            target = shlex.quote(normal)
            encoded = base64.b64encode(content).decode()
            steps = [f"mkdir -p {shlex.quote(posixpath.dirname(normal))} && : > {target}"]
            steps += [f"printf %s {chunk} | base64 -d >> {target}" for chunk in _chunks(encoded)]
            ok = all(container.exec_run(["sh", "-c", step], workdir=WORK_DIR).exit_code == 0 for step in steps)
            responses.append(FileUploadResponse(path=path, error=None if ok else "permission_denied"))
        return responses

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        # Through exec for the same reason as uploads: the archive API needs a writable root.
        container = self._require()
        responses: list[FileDownloadResponse] = []
        for path in paths:
            quoted = shlex.quote(path)
            probe = f"if [ -d {quoted} ]; then exit 3; elif [ -f {quoted} ]; then base64 {quoted}; else exit 4; fi"
            result = container.exec_run(["sh", "-c", probe], workdir=WORK_DIR, demux=False)
            if result.exit_code == 3:
                responses.append(FileDownloadResponse(path=path, content=None, error="is_directory"))
            elif result.exit_code != 0:
                responses.append(FileDownloadResponse(path=path, content=None, error="file_not_found"))
            else:
                content = base64.b64decode(b"".join((result.output or b"").split()))
                responses.append(FileDownloadResponse(path=path, content=content, error=None))
        return responses
