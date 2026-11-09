"""Cursor window bounds; storage scan/projection remains outside this helper."""
from wfd_sdk.product_query import ProductQuery


def test_cursor_window_keeps_duplicate_key_exclusion_and_bounds_key_calls():
    calls = []
    class Reader:
        def _sort_key(self, item):
            calls.append(item)
            return (item,)
    rows = [index // 2 for index in range(8192)]
    page, remaining = ProductQuery._cursor_window(Reader(), rows, (2000,), 3)
    assert page == [2001, 2001, 2002]
    assert remaining == 8192 - 4002
    assert len(calls) <= 14


def test_cursor_window_first_terminal_and_beyond_end():
    class Reader:
        def _sort_key(self, item):
            return (item,)
    reader = Reader()
    assert ProductQuery._cursor_window(reader, [1, 2, 3], None, 2) == ([1, 2], 3)
    assert ProductQuery._cursor_window(reader, [1, 2, 3], (2,), 2) == ([3], 1)
    assert ProductQuery._cursor_window(reader, [1, 2, 3], (3,), 2) == ([], 0)
    assert ProductQuery._cursor_window(reader, [], None, 2) == ([], 0)


def test_cursor_window_seeded_comparison_to_original_filter():
    import random
    rng = random.Random(20261030)
    class Reader:
        def _sort_key(self, item):
            return item
    reader = Reader()
    for _ in range(500):
        rows = sorted((rng.randrange(-12, 13), rng.randrange(4))
                      for _ in range(rng.randrange(300)))
        last = None if rng.randrange(5) == 0 else (rng.randrange(-14, 15), rng.randrange(5))
        size = rng.randrange(1, 101)
        original_suffix = rows if last is None else [item for item in rows if item > last]
        assert ProductQuery._cursor_window(reader, rows, last, size) == (
            original_suffix[:size], len(original_suffix))
