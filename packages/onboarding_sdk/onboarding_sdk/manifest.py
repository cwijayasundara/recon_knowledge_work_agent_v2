"""The run manifest: what went in, what decided it, what came out."""

from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from . import __version__
from .entities.affiliate.rules import AffiliateOptions, Finding

SCHEMA_PATH = Path(__file__).parent / "schemas" / "manifest.schema.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build(
    *,
    run_id: str,
    sponsor_id: str,
    entity: str,
    upload_name: str,
    upload_bytes: bytes,
    recipe: Mapping[str, Any],
    options: AffiliateOptions,
    bindings: Sequence[Mapping[str, Any]],
    decisions: Sequence[Mapping[str, Any]],
    outputs: Mapping[str, bytes],
    approvers: Sequence[Mapping[str, Any]],
    created_at: str,
    finalized_at: str | None,
    findings: Sequence[Finding] = (),
) -> dict[str, Any]:
    if not sponsor_id or sponsor_id == "*":
        raise ValueError("a manifest belongs to one sponsor")
    return {
        "manifest_version": 1,
        "run_id": run_id,
        "sponsor_id": sponsor_id,
        "entity": entity,
        "sdk_version": __version__,
        "upload": {"name": upload_name, "sha256": sha256(upload_bytes)},
        "recipe": dict(recipe),
        "options": options.to_dict(),
        "bindings": [dict(b) for b in bindings],
        "decisions": [dict(d) for d in decisions],
        "findings": {
            "counts": dict(sorted(Counter(f.code for f in findings).items())),
            "acknowledged": options.to_dict()["acknowledged"],
        },
        "outputs": [{"name": name, "sha256": sha256(data), "bytes": len(data)} for name, data in outputs.items()],
        "approvers": [dict(a) for a in approvers],
        "created_at": created_at,
        "finalized_at": finalized_at,
    }
