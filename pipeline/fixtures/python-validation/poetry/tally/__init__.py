import six


def total(values: list[int]) -> int:
    return sum(values)


def label(values: list[int]) -> str:
    return six.text_type(total(values))
