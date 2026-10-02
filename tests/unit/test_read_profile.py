from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from onboarding_sdk import profile, read
from openpyxl import load_workbook

from tests.conftest import FIXTURE_DIR


def test_csv_reads_header_and_rows() -> None:
    wb = read.open(FIXTURE_DIR / "clean.csv")
    assert [s.name for s in wb.sheets] == ["clean"]
    table = wb.sheets[0].table(header_row=1)
    assert table.columns == ["Affiliate ID", "Affiliate Name", "Fund Complex"]
    rows = list(table.rows())
    assert len(rows) == 8
    assert rows[0].row_number == 2
    assert rows[0].get("Affiliate Name") == "Meridian Capital GP IV, LLC"
    assert rows[0].get("Missing") is None


def test_csv_sniffs_delimiter_and_encoding(tmp_path: Path) -> None:
    path = tmp_path / "semi.csv"
    path.write_bytes("Affiliate ID;Affiliate Name\nAFF_1;Caf\xe9 Holdings\n".encode("cp1252"))
    table = read.open(path).sheets[0].table(header_row=1)
    assert table.columns == ["Affiliate ID", "Affiliate Name"]
    assert next(iter(table.rows())).get("Affiliate Name") == "Café Holdings"


def test_tsv(tmp_path: Path) -> None:
    path = tmp_path / "list.tsv"
    path.write_text("Affiliate ID\tAffiliate Name\nAFF_1\tA, LLC\n", encoding="utf-8")
    table = read.open(path).sheets[0].table(header_row=1)
    assert next(iter(table.rows())).get("Affiliate Name") == "A, LLC"


def test_xlsx_sheets_and_total_row_dropped() -> None:
    wb = read.open(FIXTURE_DIR / "titled.xlsx")
    assert [s.name for s in wb.sheets] == ["Affiliates", "Notes"]
    table = wb.sheet("Affiliates").table(header_row=4)
    rows = list(table.rows())
    assert len(rows) == 8
    assert rows[0].row_number == 5
    assert table.dropped == [(13, "total_row")]


def test_table_stops_at_blank_row(tmp_path: Path) -> None:
    path = tmp_path / "gap.csv"
    path.write_text("A,B\n1,x\n,\n2,y\n", encoding="utf-8")
    sheet = read.open(path).sheets[0]
    assert len(list(sheet.table(header_row=1).rows())) == 1
    assert len(list(sheet.table(header_row=1, stop_at_blank=False).rows())) == 2


def test_unsupported_type(tmp_path: Path) -> None:
    path = tmp_path / "x.pdf"
    path.write_bytes(b"%PDF")
    with pytest.raises(read.UnsupportedFileError):
        read.open(path)


@pytest.mark.parametrize(
    ("name", "sheet", "header_row"),
    [
        ("clean.csv", "clean", 1),
        ("edge.csv", "edge", 1),
        ("extra_columns.csv", "extra_columns", 1),
        ("titled.xlsx", "Affiliates", 4),
        ("renamed.xlsx", "Export", 1),
        ("ids_missing.csv", "ids_missing", 1),
        ("two_sheets.xlsx", "Affiliates", 1),
    ],
)
def test_header_row_detected(name: str, sheet: str, header_row: int) -> None:
    prof = profile.workbook(read.open(FIXTURE_DIR / name))
    sheet_profile = prof.sheet(sheet)
    assert sheet_profile.header_candidates[0].row == header_row
    assert len(sheet_profile.header_candidates) <= 3


def test_column_profile() -> None:
    prof = profile.workbook(read.open(FIXTURE_DIR / "clean.csv")).sheet("clean")
    by_name = {c.name: c for c in prof.columns}
    ident = by_name["Affiliate ID"]
    assert ident.pattern == r"AFF_\d{4}"
    assert ident.fill_rate == 1.0
    assert ident.distinct == 8
    assert ident.samples == ["AFF_9001", "AFF_9002", "AFF_9003", "AFF_9004", "AFF_9005"]
    assert ident.inferred_type == "string"
    assert prof.row_count == 8
    assert prof.looks_like_list > 0.8


def test_empty_file_profiles() -> None:
    prof = profile.workbook(read.open(FIXTURE_DIR / "empty.csv")).sheet("empty")
    assert prof.header_candidates[0].row == 1
    assert prof.row_count == 0


def test_fingerprint_stable_across_values_and_sensitive_to_headers(tmp_path: Path) -> None:
    renamed = profile.fingerprint(profile.workbook(read.open(FIXTURE_DIR / "renamed.xlsx")))
    returning = profile.fingerprint(profile.workbook(read.open(FIXTURE_DIR / "returning_sponsor.xlsx")))
    assert renamed == returning

    changed = tmp_path / "changed.xlsx"
    shutil.copy(FIXTURE_DIR / "renamed.xlsx", changed)
    wb = load_workbook(changed)
    wb["Export"]["B1"] = "Affiliate Legal Name"
    wb.save(changed)
    assert profile.fingerprint(profile.workbook(read.open(changed))) != renamed


def test_fingerprint_ignores_header_case_and_spacing(tmp_path: Path) -> None:
    a = tmp_path / "a.csv"
    b = tmp_path / "b.csv"
    a.write_text("Affiliate ID,Affiliate Name\nAFF_1,X LLC\n", encoding="utf-8")
    b.write_text("affiliate  id , AFFILIATE NAME\nAFF_2,Y LLC\n", encoding="utf-8")
    fa = profile.fingerprint(profile.workbook(read.open(a)))
    fb = profile.fingerprint(profile.workbook(read.open(b)))
    # A CSV's file name is not part of its layout.
    assert fa == fb
