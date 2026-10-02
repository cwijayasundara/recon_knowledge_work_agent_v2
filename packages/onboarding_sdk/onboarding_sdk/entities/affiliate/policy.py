"""Affiliate policy constants: limits, the approved item types and the Intacct template."""

from __future__ import annotations

from dataclasses import dataclass

TEMPLATE_VERSION = "intacct-affiliate-v1"
TEMPLATE_COLUMNS: tuple[str, ...] = ("ITEM_ID", "NAME", "ITEM_TYPE", "DESCRIPTION", "DONOTIMPORT")


@dataclass(frozen=True, slots=True)
class AffiliatePolicy:
    item_id_limit: int = 30
    name_limit: int = 100
    default_item_type: str = "Inventory"
    approved_item_types: tuple[str, ...] = ("Inventory", "Non-Inventory")
