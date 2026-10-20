"""Moved to herald.sanitization, shared with the programming package; this keeps the old import path.

The old name is the same module object, so patches applied to either path apply to both.
"""
import sys

from herald import sanitization as _moved

sys.modules[__name__] = _moved
