"""HTTP views for the T-Embed device API."""

from __future__ import annotations

import ipaddress
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .commands import async_execute
from .const import CONF_ALLOW_REMOTE
from .panel import etag_matches, panel_payload
from .runtime import get_runtime


def _bearer(request: web.Request) -> str | None:
    header = request.headers.get("Authorization", "")
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].casefold() != "bearer":
        return None
    return parts[1].strip() or None


def _battery(request: web.Request) -> int | None:
    """Battery percentage the app reported, or None when it did not."""

    raw = request.headers.get("X-TEmbed-Battery")
    if not raw:
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    if 0 <= value <= 100:
        return value
    return None


def _not_ready(view: HomeAssistantView) -> web.Response:
    return view.json({"error": "not_setup"}, status_code=404)


def is_local_address(remote: str | None) -> bool:
    """True for private, loopback and link-local addresses.

    The app only uses plain http on the LAN, so a request that arrives from a
    public address came through a proxy or a tunnel. A key copied off a lost
    SD card would otherwise work from anywhere.
    """

    if not remote:
        return False
    try:
        address = ipaddress.ip_address(remote)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def _refuse_remote(
    view: HomeAssistantView, request: web.Request, runtime: Any
) -> web.Response | None:
    """Return the refusal when the request comes from outside the network."""

    if runtime.options.get(CONF_ALLOW_REMOTE):
        return None
    if is_local_address(request.remote):
        return None
    return view.json({"error": "local_only"}, status_code=403)


def _unpaired(view: HomeAssistantView) -> web.Response:
    return view.json({"error": "unpaired"}, status_code=401)


class PairStartView(HomeAssistantView):
    """Start a pairing request."""

    requires_auth = False
    name = "api:tembed_remote:pair_start"
    url = "/api/tembed_remote/pair/start"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def post(self, request: web.Request) -> web.Response:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return _not_ready(self)
        if refused := _refuse_remote(self, request, runtime):
            return refused
        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "bad_request"}, status_code=400)
        if not isinstance(payload, dict):
            return self.json({"error": "bad_request"}, status_code=400)

        result, error = await runtime.async_start_pairing(
            payload, request.remote or "unknown"
        )
        if error == "busy":
            return self.json({"error": "busy"}, status_code=429)
        if result is None:
            return self.json({"error": "bad_request"}, status_code=400)
        return self.json(result)


class PairStatusView(HomeAssistantView):
    """Poll one pairing request."""

    requires_auth = False
    name = "api:tembed_remote:pair_status"
    url = "/api/tembed_remote/pair/status"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return _not_ready(self)
        if refused := _refuse_remote(self, request, runtime):
            return refused
        return self.json(await runtime.async_pair_status(request.query.get("pair_id")))


class PanelView(HomeAssistantView):
    """Return the panel for one paired device."""

    requires_auth = False
    name = "api:tembed_remote:panel"
    url = "/api/tembed_remote/panel"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return _not_ready(self)
        if refused := _refuse_remote(self, request, runtime):
            return refused
        if (
            await runtime.async_authenticate(
                _bearer(request), request.remote, _battery(request)
            )
            is None
        ):
            return _unpaired(self)

        payload = panel_payload(self.hass, runtime.options)
        version = payload["v"]
        if etag_matches(request.headers.get("If-None-Match"), version):
            return web.Response(status=304, headers={"ETag": version})
        return self.json(payload, headers={"ETag": version})


class CommandView(HomeAssistantView):
    """Run one command for one paired device."""

    requires_auth = False
    name = "api:tembed_remote:command"
    url = "/api/tembed_remote/command"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def post(self, request: web.Request) -> web.Response:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return _not_ready(self)
        if refused := _refuse_remote(self, request, runtime):
            return refused
        if (
            await runtime.async_authenticate(
                _bearer(request), request.remote, _battery(request)
            )
            is None
        ):
            return _unpaired(self)

        try:
            payload: Any = await request.json()
        except ValueError:
            return self.json({"error": "bad_request"}, status_code=400)
        if not isinstance(payload, dict):
            return self.json({"error": "bad_request"}, status_code=400)

        result, error = await async_execute(
            self.hass,
            runtime.options,
            payload.get("entity_id"),
            payload.get("action"),
            payload.get("value"),
        )
        if error is not None:
            body, status = error
            return self.json(body, status_code=status)
        return self.json(result)
