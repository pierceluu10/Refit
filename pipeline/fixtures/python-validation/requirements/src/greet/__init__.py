import six


def greeting(name: str) -> str:
    return six.ensure_str(f"hello {name}")


def shout(name: str) -> str:
    return greeting(name).upper()
