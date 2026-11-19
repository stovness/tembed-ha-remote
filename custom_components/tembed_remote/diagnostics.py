"""Diagnostics for T-Embed Remote.

Nothing here identifies a person or a remote: no device keys, no key hashes,
no addresses. Names, models and versions are what the app sent when it paired,
and they are the only thing that makes a bug report useful.
"""

from __future__ import annotations

import json

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .panel import panel_payload
from .runtime import get_runtime

TO_REDACT = {
    "key",
    "key_hash",
    "last_seen_ip",
    "ip",
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict:
    """Return diagnostics for the config entry."""

    runtime = get_runtime(hass)
    if runtime is None:
        return {"setup": False}

    devices: list[dict] = []
    for device_id, device in runtime.device_list():
        devices.append(
            async_redact_data(
                {
                    "id": device_id,
                    "name": device.get("name"),
                    "model": device.get("model"),
                    "app": device.get("app"),
                    "created_at": device.get("created_at"),
                    "last_seen_at": device.get("last_seen_at"),
                    "battery": device.get("battery"),
                    "key_hash": device.get("key_hash"),
                    "last_seen_ip": device.get("last_seen_ip"),
                },
                TO_REDACT,
            )
        )

    payload = panel_payload(hass, runtime.options)
    size = len(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )

    return {
        "setup": True,
        "entry": {
            "version": entry.version,
            "options": async_redact_data(dict(entry.options), TO_REDACT),
        },
        "devices": {
            "count": len(devices),
            "pending_pairings": len(runtime.pending),
            "items": devices,
        },
        "panel": {
            "bytes": size,
            "favourites": len(payload.get("f", [])),
            "rooms": len(payload.get("r", [])),
            "entities": sum(len(room[1]) for room in payload.get("r", [])),
        },
    }
