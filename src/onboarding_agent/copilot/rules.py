"""Pure rules for the Copilot: range syntax, caps, truncation, formula denylist.

The formula denylist refuses a denied function both when it is called (``NAME(``) and as a bare name, because Excel's
eta-reduced lambdas pass a function without a "(" (``=MAP(A1:A3, WEBSERVICE)``). Fail closed: a LET/LAMBDA variable,
a sheet name before "!" or any other identifier spelled exactly like a denied function is refused too. Column names
inside structured-reference brackets (``Table1[Image]``, ``[@Run]``) are not identifiers and are ignored.
check_formula cannot know which sheets are hidden; the add-in checks references to hidden sheets in Excel.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

MAX_ROW = 1_048_576
MAX_COL = 16_384
MAX_FORMULA_CHARS = 8192  # Excel's own formula limit; also bounds regex work
_A1 = re.compile(
    r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?",
    re.ASCII,
)
# Explicit list covers code points that are not Cc/Cf (variation selectors) plus the common Cf ones.
_INVISIBLE = (
    "\x80-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff"
)
_SHEET_BAD = re.compile(f"[\\[\\]:*?/\\\\\x00-\x1f\x7f{_INVISIBLE}]")
_CONTROL = re.compile(f"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f{_INVISIBLE}]")
_STRING = re.compile(r'"(?:[^"]|"")*"')
_DENY_FUNCS = (
    r"WEBSERVICE|FILTERXML|ENCODEURL|HYPERLINK|IMAGE|RTD|DDE|DDEAUTO|CALL|REGISTER(?:\.ID)?|EXEC|EXECUTE"
    r"|SQL\.REQUEST|FOPEN|FWRITE|FWRITELN|FREAD|FREADLN|RUN|PY|COPILOT|TRANSLATE|DETECTLANGUAGE|STOCKHISTORY"
    # Dynamic references and workbook/environment introspection: they can reach hidden sheets or leak file paths.
    r"|INDIRECT|CELL|INFO"
    # File import (Excel's IMPORTTEXT/IMPORTCSV read local or network files).
    r"|IMPORTTEXT|IMPORTCSV"
)
# A denied name standing alone (passed as a function value); run on code with strings and bracket contents blanked.
# The prefix may repeat (_xlfn._xlws.NAME). The lookbehind lets a match start only at the start of a prefix chain,
# so the repeated group stays linear.
_PREFIX = r"(?:_xl(?:fn|ws)\.)*"
_BARE = re.compile(rf"(?i)(?<![\w.]){_PREFIX}(?:{_DENY_FUNCS})(?![\w.])")
# _xll. (XLL add-in functions) and _xludf. (VBA/custom-function UDFs) are rejected anywhere outside strings.
# A denylist cannot stop a UDF with an unknown name; the add-in never runs macros and the analyst reviews every formula.
# No prefix group here: \b already matches after the "." of any _xlfn./_xlws. prefix, and a repeated prefix group
# would make every position of a long prefix chain a fresh start (quadratic).
_DENY = re.compile(rf"(?i)\b(?:{_DENY_FUNCS})\s*\(|_xll\.|_xludf\.")
# Linear by construction: every quantified class is followed by a delimiter it cannot match.
# DDE pipe, path separators, URL schemes, and [book]Sheet! (quoted refs are checked by _quoted_ref_is_external).
_EXTERNAL = re.compile(r"[|\\]|://|(?<![\w\]])\[[^\[\]@#]*\]'?[\w .\t\r\n]*'?!", re.I)


def is_hidden_char(ch: str, keep_ws: bool = False) -> bool:
    if keep_ws and ch in "\t\n\r":
        return False
    return unicodedata.category(ch) in {"Cc", "Cf", "Zl", "Zp"} or bool(_CONTROL.match(ch))


def _quoted_ref_is_external(code: str) -> bool:
    """Linear scan for 'name'! references whose quoted name holds a path/workbook character."""
    i, n = 0, len(code)
    while i < n:
        if code[i] != "'":
            i += 1
            continue
        j = i + 1
        while j < n:
            if code[j] == "'":
                if code[j + 1 : j + 2] == "'":
                    j += 2
                    continue
                break
            j += 1
        if j < n and code[j + 1 : j + 2] == "!" and any(c in "[]:/\\" for c in code[i + 1 : j]):
            return True
        i = j + 1
    return False


@dataclass(frozen=True, slots=True)
class RangeSpec:
    r1: int
    c1: int
    r2: int
    c2: int

    @property
    def rows(self) -> int:
        return self.r2 - self.r1 + 1

    @property
    def cols(self) -> int:
        return self.c2 - self.c1 + 1

    @property
    def cells(self) -> int:
        return self.rows * self.cols

    def a1(self) -> str:
        first = f"{_letters(self.c1)}{self.r1}"
        if (self.r1, self.c1) == (self.r2, self.c2):
            return first
        return f"{first}:{_letters(self.c2)}{self.r2}"


def _col(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def _letters(col: int) -> str:
    out = ""
    while col:
        col, rem = divmod(col - 1, 26)
        out = chr(65 + rem) + out
    return out


def parse_range(text: str) -> RangeSpec:
    """Parse A1 or A1:B2 (no whitespace, sheet prefix or whole rows/columns).

    Callers must enforce per-call caps with ``RangeSpec.cells``: ``A1:XFD1048576`` parses to ~17B cells.
    """
    m = _A1.fullmatch(text)
    if not m:
        raise ValueError(f"not a cell range: {text!r}")
    c1, r1 = _col(m.group(1)), int(m.group(2))
    c2, r2 = (_col(m.group(3)), int(m.group(4))) if m.group(3) else (c1, r1)
    for r in (r1, r2):
        if not 1 <= r <= MAX_ROW:
            raise ValueError(f"row out of bounds: {r}")
    for c in (c1, c2):
        if not 1 <= c <= MAX_COL:
            raise ValueError(f"column out of bounds: {c}")
    return RangeSpec(min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2))


def valid_sheet_name(name: str) -> str:
    units = len(name.encode("utf-16-le", errors="surrogatepass")) // 2
    if (
        not name.strip()
        or units > 31
        or name[0] == "'"
        or name[-1] == "'"
        or name.casefold() == "history"
        or _SHEET_BAD.search(name)
        or any(is_hidden_char(ch) for ch in name)
        or any("\ud800" <= ch <= "\udfff" for ch in name)
    ):
        raise ValueError(f"invalid sheet name: {name!r}")
    return name


def truncate_cell(value: object, limit: int) -> str | int | float | bool | None:
    """Return a scalar cell value capped at ``limit`` characters.

    Numbers with abs >= 10**15 (and non-finite floats) become strings so precision is never silently lost.
    """
    if limit < 1:
        raise ValueError("limit must be >= 1")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, int | float):
        if abs(value) < 10**15:
            return value
        value = str(value)
    if not isinstance(value, str):
        raise ValueError(f"not a cell value: {type(value).__name__}")
    cleaned = "".join(ch for ch in value if not is_hidden_char(ch, keep_ws=True))
    return cleaned if len(cleaned) <= limit else cleaned[:limit] + "\u2026"


def _blank_brackets(code: str) -> str:
    """Spaces for everything inside [...] at any depth (structured-reference column names); one linear pass."""
    out: list[str] = []
    depth = 0
    for ch in code:
        if ch == "[":
            depth += 1
            out.append(ch)
        elif ch == "]":
            if depth == 0:
                raise ValueError("formula has unbalanced brackets")
            depth -= 1
            out.append(ch)
        else:
            out.append(" " if depth else ch)
    if depth:
        raise ValueError("formula has unbalanced brackets")
    return "".join(out)


def check_formula(formula: str) -> None:
    if len(formula) > MAX_FORMULA_CHARS:
        raise ValueError("formula is too long")
    code = _STRING.sub('""', formula)
    if '"' in _STRING.sub("", code):  # unbalanced quote: fail closed
        raise ValueError("formula has unbalanced quotes")
    if any(is_hidden_char(ch, keep_ws=True) for ch in code):
        raise ValueError("formula has control or invisible characters")
    if _DENY.search(code) or _EXTERNAL.search(code) or _quoted_ref_is_external(code):
        raise ValueError("formula uses a function or reference that is not allowed")
    if _BARE.search(_blank_brackets(code)):
        raise ValueError("formula uses a function or reference that is not allowed")


def count_cells(payload: object) -> int:
    if not isinstance(payload, list):
        return 0
    n = 0
    for row in payload:
        if not isinstance(row, list) or any(isinstance(c, list | dict | tuple | bytes) for c in row):
            raise ValueError("values must be a 2D list of scalars")
        n += len(row)
    return n
