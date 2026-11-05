"""Local coordinator ownership locks. These do not assert external tools have stopped."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path


@contextmanager
def run_ownership(database: Path, key: str):
    directory = database.parent / (database.name + '.locks')
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / hashlib.sha256(key.encode()).hexdigest()
    with path.open('a+b') as handle:
        acquired = False
        try:
            if os.name == 'nt':
                import msvcrt
                if path.stat().st_size == 0:
                    handle.write(b'0'); handle.flush()
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    acquired = True
                except OSError:
                    pass
            else:
                import fcntl
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except BlockingIOError:
                    pass
            yield acquired
        finally:
            if acquired:
                if os.name == 'nt':
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_UN)
