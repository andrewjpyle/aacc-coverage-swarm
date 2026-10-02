"""Price calculation for the fictional Acme Shop (sample code for the coverage-swarm demo)."""

from __future__ import annotations

TAX_RATES = {"KS": 0.065, "MO": 0.04225, "NE": 0.055}
BULK_THRESHOLD = 10      # orders of 10 or more units get the bulk discount
BULK_DISCOUNT = 0.10
MAX_COUPON = 0.50        # no coupon may take more than half off


def unit_price(base: float, quantity: int) -> float:
    """Price of one unit. Orders of BULK_THRESHOLD units or more get BULK_DISCOUNT off."""
    if base < 0:
        raise ValueError("base price cannot be negative")
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    if quantity > BULK_THRESHOLD:
        return round(base * (1 - BULK_DISCOUNT), 2)
    return base


def apply_coupon(subtotal: float, percent_off: float) -> float:
    """Subtotal after a percentage coupon, capped at MAX_COUPON."""
    if percent_off < 0:
        raise ValueError("coupon cannot be negative")
    rate = min(percent_off / 100, MAX_COUPON)
    return round(subtotal * (1 - rate), 2)


def sales_tax(amount: float, state: str) -> float:
    """Sales tax for a two-letter state code. Unknown states pay no tax."""
    rate = TAX_RATES.get(state.upper(), 0.0)
    return round(amount * rate, 2)


def order_total(base: float, quantity: int, state: str, coupon: float = 0.0) -> dict:
    """Full breakdown for an order line."""
    price = unit_price(base, quantity)
    subtotal = round(price * quantity, 2)
    discounted = apply_coupon(subtotal, coupon) if coupon else subtotal
    tax = sales_tax(discounted, state)
    return {
        "unit_price": price,
        "subtotal": subtotal,
        "discounted": discounted,
        "tax": tax,
        "total": round(discounted + tax, 2),
    }
