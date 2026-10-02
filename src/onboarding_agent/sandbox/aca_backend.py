"""Azure Container Apps dynamic sessions (custom container pool) as the sandbox.

Every request goes to the pool management endpoint with ``identifier=<run_id>``
and a managed-identity token for ``https://dynamicsessions.io``; the pool routes
it to that run's session, where sandbox/executor/app.py answers.

Not yet verified against a live pool: the plan calls for a short spike to
confirm the request path format before relying on this in the dev deployment.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse

from .base import DEFAULT_TIMEOUT_S, IN_DIR, REF_DIR, SKILLS_DIR, WORK_DIR, RunSandbox, SandboxMounts, truncate

AUDIENCE = "https://dynamicsessions.io/.default"


def managed_identity_token() -> Callable[[], str]:
    from azure.identity import DefaultAzureCredential

    credential = DefaultAzureCredential()
    return lambda: credential.get_token(AUDIENCE).token


class AcaSessionSandbox(RunSandbox):
    def __init__(
        self,
        run_id: str,
        mounts: SandboxMounts,
        *,
        endpoint: str,
        token: Callable[[], str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._run_id = run_id
        self._mounts = mounts
        self._endpoint = endpoint.rstrip("/")
        self._token = token or managed_identity_token()
        self._client = httpx.Client(transport=transport, timeout=DEFAULT_TIMEOUT_S + 30)
        self._started = False

    @property
    def id(self) -> str:
        return f"aca-{self._run_id}"

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        params = {"identifier": self._run_id, **kwargs.pop("params", {})}
        headers = {"Authorization": f"Bearer {self._token()}"}
        return self._client.request(method, f"{self._endpoint}{path}", params=params, headers=headers, **kwargs)

    def _put(self, path: str, content: bytes) -> httpx.Response:
        return self._request("PUT", "/files", params={"path": path}, content=content)

    def start(self) -> None:
        """Copy the upload, references and skills into the session, then seal them read-only."""
        if self._started:
            return
        for source, target in (
            (self._mounts.input_dir, IN_DIR),
            (self._mounts.ref_dir, REF_DIR),
            (self._mounts.skills_dir, SKILLS_DIR),
        ):
            for path in sorted(Path(source).rglob("*")) if Path(source).exists() else []:
                if path.is_file():
                    response = self._put(f"{target}/{path.relative_to(source).as_posix()}", path.read_bytes())
                    if response.status_code == 403:
                        # The session outlived our process and is already sealed.
                        self._started = True
                        return
                    response.raise_for_status()
        self._request("POST", "/seal").raise_for_status()
        self._started = True

    def close(self) -> None:
        # Sessions expire on the pool's cooldown; nothing to delete explicitly.
        self._client.close()

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        response = self._request("POST", "/exec", json={"cmd": command, "timeout": timeout or DEFAULT_TIMEOUT_S})
        if response.status_code != 200:
            return ExecuteResponse(
                output=f"sandbox error {response.status_code}: {response.text[:500]}", exit_code=None
            )
        body = response.json()
        text, truncated = truncate(body["output"])
        return ExecuteResponse(output=text, exit_code=body["exit_code"], truncated=truncated or body["truncated"])

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        out = []
        for path, content in files:
            if not (path == WORK_DIR or path.startswith(WORK_DIR + "/")):
                out.append(FileUploadResponse(path=path, error="permission_denied"))
                continue
            status = self._put(path, content).status_code
            out.append(FileUploadResponse(path=path, error=None if status == 200 else "permission_denied"))
        return out

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        out = []
        for path in paths:
            response = self._request("GET", "/files", params={"path": path})
            if response.status_code == 200:
                out.append(FileDownloadResponse(path=path, content=response.content, error=None))
            else:
                error = {400: "is_directory", 403: "permission_denied"}.get(response.status_code, "file_not_found")
                out.append(FileDownloadResponse(path=path, content=None, error=error))
        return out
