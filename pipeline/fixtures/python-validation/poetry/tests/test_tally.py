from tally import label, total


def test_total():
    assert total([1, 2, 3]) == 6


def test_label():
    assert label([1, 2]) == "3"
