"""The recipe engineer's sandbox: one isolated container per run.

Layout inside every backend:
    /in      the upload, read-only
    /work    scratch space, the only writable path
    /ref     ontology and confirmed bindings, read-only
    /skills  skill files, read-only
"""

from __future__ import annotations

from abc import abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Any, Self

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

IN_DIR, WORK_DIR, REF_DIR, SKILLS_DIR = "/in", "/work", "/ref", "/skills"
MAX_OUTPUT_CHARS = 100_000
DEFAULT_TIMEOUT_S = 120


@dataclass(frozen=True, slots=True)
class SandboxMounts:
    input_dir: Path
    ref_dir: Path
    skills_dir: Path


def truncate(output: str) -> tuple[str, bool]:
    if len(output) <= MAX_OUTPUT_CHARS:
        return output, False
    return output[:MAX_OUTPUT_CHARS] + "\n... [output truncated]", True


class RunSandbox(BaseSandbox):
    """A sandbox that owns a container for the life of one run."""

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class LazySandbox(BaseSandbox):
    """Delegates to a run's sandbox, starting it on first use.

    Building an agent must not start a container; only running a command does.
    """

    def __init__(self, get: Callable[[], RunSandbox], run_id: str) -> None:
        self._get = get
        self._run_id = run_id

    @property
    def id(self) -> str:
        return f"lazy-{self._run_id}"

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        return self._get().execute(command, timeout=timeout)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self._get().upload_files(files)

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._get().download_files(paths)

    # File operations go to the real sandbox so a backend that specialises
    # them is honoured; the inherited versions would bypass it.
    def ls(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().ls(*args, **kwargs)

    def read(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().read(*args, **kwargs)

    def write(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().write(*args, **kwargs)

    def edit(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().edit(*args, **kwargs)

    def grep(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().grep(*args, **kwargs)

    def glob(self, *args: Any, **kwargs: Any) -> Any:
        return self._get().glob(*args, **kwargs)
