"""Stock tracking for the fictional Acme Shop (sample code for the coverage-swarm demo)."""

from __future__ import annotations


class OutOfStock(Exception):
    pass


class Inventory:
    def __init__(self, reorder_level: int = 5):
        if reorder_level < 0:
            raise ValueError("reorder_level cannot be negative")
        self.reorder_level = reorder_level
        self._stock: dict[str, int] = {}

    def receive(self, sku: str, qty: int) -> int:
        """Add stock. Returns the new on-hand count."""
        if qty <= 0:
            raise ValueError("received quantity must be positive")
        self._stock[sku] = self._stock.get(sku, 0) + qty
        return self._stock[sku]

    def ship(self, sku: str, qty: int) -> int:
        """Remove stock for an order. Never lets on-hand go below zero."""
        if qty <= 0:
            raise ValueError("shipped quantity must be positive")
        on_hand = self._stock.get(sku, 0)
        if qty > on_hand:
            raise OutOfStock(f"{sku}: wanted {qty}, have {on_hand}")
        self._stock[sku] = on_hand - qty
        return self._stock[sku]

    def on_hand(self, sku: str) -> int:
        return self._stock.get(sku, 0)

    def needs_reorder(self) -> list[str]:
        """SKUs at or below the reorder level, sorted."""
        return sorted(s for s, n in self._stock.items() if n <= self.reorder_level)

    def value(self, prices: dict[str, float]) -> float:
        """Total stock value. A SKU with no price is skipped, not counted as free."""
        total = 0.0
        for sku, n in self._stock.items():
            if sku in prices:
                total += prices[sku] * n
        return round(total, 2)
