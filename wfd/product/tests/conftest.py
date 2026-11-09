"""Shared test configuration; never rewrite requests or patch service admission.

Legacy fixtures declare their source_roles explicitly at construction sites.
Real historical integrations opt in with an explicitly selected evidence root.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--wfd-history-root", action="store", default=None,
        help="Explicitly authorized historical WFD evidence root (integration tests only)")


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "integration: requires explicitly selected real historical evidence")


@pytest.fixture
def wfd_history_root(request):
    value = request.config.getoption("--wfd-history-root")
    if value is None:
        pytest.skip("real historical evidence not selected; use --wfd-history-root after authorization")
    root = Path(value).expanduser()
    if not root.is_absolute() or not root.is_dir():
        pytest.fail("--wfd-history-root must select an existing absolute authorized evidence directory")
    return root.resolve()
