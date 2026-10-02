#!/usr/bin/env sh
# Build the attribute_mapper wheel into vendor/ so container builds do not need
# the sibling string_matcher_v1 checkout in their build context.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
matcher=${STRING_MATCHER_PATH:-$here/../../advance_research/string_matcher_v1}
rm -rf "$here/vendor" && mkdir -p "$here/vendor"
uv build --wheel --out-dir "$here/vendor" "$matcher"
ls "$here/vendor"
