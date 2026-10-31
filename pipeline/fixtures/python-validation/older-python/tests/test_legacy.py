from legacy import interpreter


def test_runs_on_a_declared_python():
    assert (3, 12) <= interpreter() < (3, 14)
