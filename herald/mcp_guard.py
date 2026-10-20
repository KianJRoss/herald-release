"""Gateway-local protection against unbounded SDK warning capture and memory growth."""
from __future__ import annotations
import ctypes
import logging
import os
import sys
import threading
from mcp import types
from mcp.server import Server
from mcp.shared.session import RequestResponder

_LOG = logging.getLogger(__name__)
_JOB_HANDLE = None


class GatewayServer(Server):
    async def _handle_message(self, message, session, lifespan_context, raise_exceptions=False):
        # SDK v1 captures process-global warnings across awaits, then logs the
        # mutable captured list inside the capture scope (python-sdk#3122).
        # Ordinary Python warning delivery to stderr needs no capture/replay.
        match message:
            case RequestResponder(request=types.ClientRequest(root=req)) as responder:
                with responder:
                    await self._handle_request(message, req, session, lifespan_context, raise_exceptions)
            case types.ClientNotification(root=notification):
                await self._handle_notification(notification)
            case Exception():
                _LOG.error('Received exception from MCP transport: %s', type(message).__name__)
                await session.send_log_message(level='error', data='Internal Server Error', logger='mcp.server.exception_handler')
                if raise_exceptions:
                    raise message


def _windows_private_bytes() -> int:
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                    *[(name, ctypes.c_size_t) for name in ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage',
                      'QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage',
                      'PeakPagefileUsage','PrivateUsage')]]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    value = Counters(); value.cb = ctypes.sizeof(value)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(value), value.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return value.PrivateUsage


def _windows_memory_limit(limit: int) -> None:
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount','WriteOperationCount',
                   'OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount')]
    class Extended(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', IO),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = Extended()
    # PROCESS_MEMORY and SILENT_BREAKAWAY_OK: protect this bridge, not a Router
    # it starts or a tool's subprocess. No KILL_ON_JOB_CLOSE flag is used.
    limits.BasicLimitInformation.LimitFlags = 0x100 | 0x1000
    limits.ProcessMemoryLimit = limit
    try:
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        kernel.CloseHandle(job)
        raise
    global _JOB_HANDLE
    _JOB_HANDLE = job  # Keep alive for this process's lifetime.


def start_memory_guard(limit_mb: int) -> threading.Event:
    stop = threading.Event()
    if limit_mb == 0:
        return stop
    if not 128 <= limit_mb <= 65536:
        raise ValueError('MCP memory limit must be 0 (disabled) or 128–65536 MiB')
    if sys.platform != 'win32':
        return stop
    limit = limit_mb * 1024 * 1024
    baseline = _windows_private_bytes()
    if baseline >= int(limit * .90):
        raise ValueError('MCP bridge already exceeds the selected memory allowance')
    try:
        _windows_memory_limit(limit)
    except OSError as exc:
        _LOG.warning('MCP hard memory limit unavailable (%s); private-memory watchdog remains active', type(exc).__name__)
    # Leave room to report/exit before the hard allocation limit is reached.
    threshold = int(limit * .90)
    def monitor():
        while not stop.wait(1):
            try:
                private = _windows_private_bytes()
            except OSError:
                continue
            if private >= threshold:
                try:
                    sys.stderr.write(f'Herald MCP bridge reached its {limit_mb} MiB memory allowance; exiting this bridge only.\n')
                    sys.stderr.flush()
                finally:
                    os._exit(75)
    threading.Thread(target=monitor, name='herald-mcp-memory-guard', daemon=True).start()
    return stop
