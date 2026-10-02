"""Print an upload's profile and fingerprint as JSON.

Usage: python -m onboarding_sdk.inspect <file>
"""

from __future__ import annotations

import json
import sys

from . import profile, read


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m onboarding_sdk.inspect <file>", file=sys.stderr)
        return 2
    prof = profile.workbook(read.open(args[0]))
    print(json.dumps({**prof.to_dict(), "fingerprint": profile.fingerprint(prof)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
