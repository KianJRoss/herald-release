"""Relay between Herald and the assistant nodes that connect to it.

An assistant built on Herald (UltimateAssistant) runs a node on each of the
user's devices. Every node keeps ONE outbound WebSocket open to this router,
so devices need no inbound ports, tunnels or Herald of their own. Over it:

* a node runs MCP servers on its own machine (memory, tasks, screen, input...)
  and offers them by name. A tool instance whose config is
  ``{"node": <node>, "server": <name>}`` is listed and called through the
  node; results come back as the MCP result, images included. The assistant
  registers those instances itself, like any other tool. Secrets stay in
  Herald (``env_refs``); their values travel as ``env`` with each request.
* a node may serve HTTP (the assistant's main node serves its chat API).
  ``/nodes/<name>/http/<path>`` relays a request to it and streams the reply,
  so an interface on one device can reach the assistant on another.
  ``main`` names whichever connected node said it is the main one.

Herald adds nothing assistant-specific here: it forwards requests and bytes.
Frames are JSON; HTTP bodies are base64.

node -> herald  hello{node,label,main} | result{id,result|error}
                http_head{id,status,headers} | http_chunk{id,data} | http_end{id,error?}
herald -> node  welcome{node} | list{id,server,env} | call{id,server,tool,arguments,env}
                http{id,method,path,query,headers,body} | cancel{id}
"""
from __future__ import annotations

import asyncio
import base64
import itertools
from concurrent.futures import CancelledError as FutureCancelledError
import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MAIN = "main"


@dataclass
class Node:
    name: str
    label: str
    main: bool
    send: Any  # async (dict) -> None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    streams: dict[str, asyncio.Queue] = field(default_factory=dict)


class Relay:
    def __init__(self) -> None:
        self.nodes: dict[str, Node] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self._ids = itertools.count(1)

    def _id(self) -> str:
        return str(next(self._ids))

    def get(self, name: str) -> Node | None:
        if name == MAIN:
            return next((n for n in self.nodes.values() if n.main), None)
        return self.nodes.get(name)

    def describe(self) -> list[dict[str, Any]]:
        return [{"node": n.name, "label": n.label, "main": n.main} for n in self.nodes.values()]

    # -- connection ---------------------------------------------------------

    def attach(self, hello: dict[str, Any], send) -> Node:
        name = str(hello.get("node") or "").lower()
        if hello.get("type") != "hello" or not NAME.match(name) or name == MAIN:
            raise ValueError("expected hello with a short lowercase node name (not 'main')")
        self.loop = asyncio.get_running_loop()
        old = self.nodes.get(name)
        if old:
            self.detach(old, "replaced by a new connection")
        node = Node(name=name, label=str(hello.get("label") or name), main=bool(hello.get("main")), send=send)
        if node.main:
            for other in self.nodes.values():
                other.main = False
        self.nodes[name] = node
        return node

    def detach(self, node: Node, reason: str = "node disconnected") -> None:
        if self.nodes.get(node.name) is node:
            del self.nodes[node.name]
        for future in node.pending.values():
            if not future.done():
                future.set_exception(ConnectionError(reason))
        for queue in node.streams.values():
            queue.put_nowait({"type": "http_end", "error": reason})
        node.pending.clear()
        node.streams.clear()

    def receive(self, node: Node, frame: dict[str, Any]) -> None:
        kind, fid = frame.get("type"), str(frame.get("id", ""))
        if kind == "result":
            future = node.pending.pop(fid, None)
            if future and not future.done():
                future.set_result(frame)
        elif kind in {"http_head", "http_chunk", "http_end"}:
            queue = node.streams.get(fid)
            if queue is not None:
                queue.put_nowait(frame)

    # -- MCP servers on a node ------------------------------------------------

    @staticmethod
    def _uncertain(name: str, reason: str) -> dict[str, Any]:
        return {"error": f"device '{name}': {reason}; execution outcome is unknown. "
                         "Inspect the target state before repeating a change.",
                "error_kind": "outcome_unknown", "execution_status": "unknown", "retry_safe": False}

    async def request(self, name: str, frame: dict[str, Any], timeout: float) -> dict[str, Any]:
        """Never replay a call whose result was lost; bound both send and response."""
        node = self.get(name)
        if node is None:
            return {"error": f"device '{name}' is not connected", "error_kind": "device_offline",
                    "execution_status": "not_started", "retry_safe": True}
        fid = self._id()
        future = asyncio.get_running_loop().create_future()
        node.pending[fid] = future

        async def exchange():
            await node.send({**frame, "id": fid})
            return await future

        try:
            return await asyncio.wait_for(exchange(), timeout)
        except asyncio.TimeoutError:
            await _quiet(node.send({"type": "cancel", "id": fid}))
            return self._uncertain(node.label, f"did not answer within {timeout:.0f}s")
        except asyncio.CancelledError:
            await _quiet(node.send({"type": "cancel", "id": fid}))
            raise
        except Exception:
            return self._uncertain(node.label, "connection interrupted")
        finally:
            node.pending.pop(fid, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # retrieve a detach error even if send failed first

    def _sync(self, name: str, frame: dict[str, Any], timeout: float) -> dict[str, Any]:
        """For tool execution on a worker thread; cancel abandoned submissions."""
        loop = self.loop
        if loop is None or not loop.is_running():
            return {"error": f"device '{name}' is not connected", "execution_status": "not_started",
                    "error_kind": "device_offline", "retry_safe": True}
        request = self.request(name, frame, timeout)
        try:
            pending = asyncio.run_coroutine_threadsafe(request, loop)
        except RuntimeError:
            request.close()
            return {"error": f"device '{name}' relay is stopped", "execution_status": "not_started",
                    "error_kind": "device_offline", "retry_safe": True}
        try:
            return pending.result(timeout + 5)
        except (TimeoutError, FutureCancelledError):
            pending.cancel()
            return self._uncertain(name, "relay event loop did not respond")

    @staticmethod
    def _tool_error(frame: dict[str, Any]) -> dict[str, Any]:
        return {"ok": False, "error": str(frame["error"]),
                **{key: frame[key] for key in ("error_kind", "execution_status", "retry_safe") if key in frame}}

    def list_tools(self, name: str, server: str, env: dict[str, str] | None = None,
                   timeout: float = 15) -> dict[str, Any]:
        frame = self._sync(name, {"type": "list", "server": server, "env": env or {}}, timeout)
        if frame.get("error"):
            return self._tool_error(frame)
        return {"ok": True, "tools": (frame.get("result") or {}).get("tools", [])}

    def call_tool(self, name: str, server: str, tool: str, arguments: dict[str, Any],
                  timeout: float, env: dict[str, str] | None = None) -> dict[str, Any]:
        frame = self._sync(name, {"type": "call", "server": server, "tool": tool,
                                  "arguments": arguments, "env": env or {}}, timeout)
        if frame.get("error"):
            return self._tool_error(frame)
        result = frame.get("result") or {}
        return {"ok": not bool(result.get("isError")), "result": result}

    # -- http -------------------------------------------------------------------

    async def http(self, name: str, method: str, path: str, query: str, headers: dict[str, str],
                   body: bytes, *, head_timeout: float = 600) -> tuple[int, dict[str, str], AsyncIterator[bytes]]:
        node = self.get(name)
        if node is None:
            raise LookupError(f"device '{name}' is not connected")
        fid = self._id()
        queue: asyncio.Queue = asyncio.Queue()
        node.streams[fid] = queue
        async def begin():
            await node.send({"type": "http", "id": fid, "method": method, "path": path, "query": query,
                             "headers": headers, "body": base64.b64encode(body).decode()})
            return await queue.get()
        try:
            head = await asyncio.wait_for(begin(), head_timeout)
        except BaseException as exc:
            node.streams.pop(fid, None)
            await _quiet(node.send({"type": "cancel", "id": fid}))
            if isinstance(exc, (asyncio.CancelledError, TimeoutError)):
                raise
            raise ConnectionError("Device connection interrupted; execution outcome may be unknown") from exc
        if head.get("type") != "http_head":
            node.streams.pop(fid, None)
            raise ConnectionError(head.get("error") or "device closed the request")

        async def chunks() -> AsyncIterator[bytes]:
            finished = False
            try:
                while True:
                    frame = await queue.get()
                    if frame.get("type") == "http_chunk":
                        yield base64.b64decode(frame.get("data") or "", validate=True)
                    elif frame.get("type") == "http_end":
                        finished = True
                        if frame.get("error"):
                            raise ConnectionError(str(frame["error"]))
                        return
                    else:
                        raise ConnectionError("Unexpected device HTTP stream frame")
            finally:
                node.streams.pop(fid, None)
                if not finished:  # the caller went away; stop the work on the device
                    await _quiet(node.send({"type": "cancel", "id": fid}))

        return int(head.get("status") or 502), dict(head.get("headers") or {}), chunks()


async def _quiet(awaitable) -> None:
    try:
        await asyncio.wait_for(awaitable, 2)
    except Exception:  # noqa: BLE001 - best effort on a closing socket
        pass


relay = Relay()


def post_to_node(node: str, path: str, body: dict[str, Any] | None = None, timeout: float = 1800) -> str:
    """Schedule action: POST JSON to a node's HTTP (``/nodes/<node>/http/<path>``).

    Lets a cron or event schedule hand its work to an application running on a
    node (an assistant's main node runs the right agent and delivers the
    result). Runs in the scheduler's worker thread, so it goes through this
    router's own HTTP endpoint like any other caller."""
    import os
    import httpx
    from herald.router.cli_gateway import self_url

    if not (node == MAIN or NAME.match(node)):
        raise ValueError(f"invalid node name {node!r}")
    key = os.environ.get("HERALD_API_KEY")
    response = httpx.post(f"{self_url()}/nodes/{node}/http/{path.lstrip('/')}", json=body or {},
                          headers={"Authorization": f"Bearer {key}"} if key else {}, timeout=timeout)
    if response.status_code >= 400:
        raise RuntimeError(f"node {node} answered HTTP {response.status_code}: {response.text[:300]}")
    try:
        data = response.json()
    except ValueError:
        return response.text[:2000]
    return str(data.get("summary") or data.get("reply") or data)[:2000] if isinstance(data, dict) else str(data)[:2000]
