from acme_shop.pricing import unit_price


def test_unit_price_small_order():
    assert unit_price(4.00, 2) == 4.00
