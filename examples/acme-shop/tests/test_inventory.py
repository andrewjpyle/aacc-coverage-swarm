from acme_shop.inventory import Inventory


def test_receive_adds_stock():
    inv = Inventory()
    assert inv.receive("WIDGET", 3) == 3
