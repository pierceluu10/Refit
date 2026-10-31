from greet import greeting, shout


def test_greeting():
    assert greeting("ada") == "hello ada"


def test_shout():
    assert shout("ada") == "HELLO ADA"


def test_already_failing():
    assert greeting("ada") == "hi ada"
