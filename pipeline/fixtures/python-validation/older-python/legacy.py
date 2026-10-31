import sys


def interpreter() -> tuple[int, int]:
    return sys.version_info[:2]
