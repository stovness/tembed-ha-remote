"""Websocket commands behind the T-Embed sidebar panel.

All of them need an admin, the same as the integration's settings page.
"""

from __future__ import annotations

import secrets
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry, label_registry
from homeassistant.util import dt as dt_util

from .const import (
    ALLOWED_DOMAINS,
    CONF_ALLOW_REMOTE,
    CONF_FAVOURITES,
    CONF_FAVOURITES_LABEL,
    CONF_GROUPS,
    CONF_HIDDEN_AREAS,
    CONF_HIDDEN_ENTITIES,
    CONF_HIDE_LABEL,
    CONF_ROOM_ORDER,
    DEFAULT_FAVOURITES_LABEL,
    DEFAULT_HIDE_LABEL,
    DOMAIN,
    GROUP_LIMIT,
    GROUP_NAME_LIMIT,
    LIST_LIMIT,
)
from .panel import _label_id, _trim_area, label_favourites, panel_payload, usable_entities
from .runtime import get_runtime

ENTITY_LIST = vol.All([vol.All(str, vol.Length(min=3, max=255))], vol.Length(max=LIST_LIMIT))
GROUP_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): vol.All(str, vol.Length(max=32)),
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=GROUP_NAME_LIMIT)),
        vol.Required("entities"): ENTITY_LIST,
    }
)


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the panel's websocket commands once."""

    for handler in (
        ws_config,
        ws_status,
        ws_save_layout,
        ws_save_settings,
        ws_pair,
        ws_remove_device,
        ws_rename_device,
    ):
        websocket_api.async_register_command(hass, handler)


def _runtime_or_error(hass: HomeAssistant, connection, msg) -> Any:
    runtime = get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_setup", "Add T-Embed Remote first.")
    return runtime


def _devices(runtime) -> list[dict[str, Any]]:
    return [
        {
            "id": device_id,
            "name": device.get("name", "T-Embed"),
            "model": device.get("model"),
            "app": device.get("app"),
            "battery": device.get("battery"),
            "created_at": device.get("created_at"),
            "last_seen_at": device.get("last_seen_at"),
            "last_seen_ip": device.get("last_seen_ip"),
        }
        for device_id, device in runtime.device_list()
    ]


def _pending(runtime) -> list[dict[str, Any]]:
    now = dt_util.utcnow()
    return [
        {
            "name": pending.name,
            "ip": pending.ip,
            "expires_at": pending.expires_at.isoformat(),
        }
        for pending in runtime.pending.values()
        if pending.status == "pending" and now < pending.expires_at
    ]


def _status(runtime) -> dict[str, Any]:
    return {"devices": _devices(runtime), "pending": _pending(runtime)}


def _layout(hass: HomeAssistant, options: dict[str, Any]) -> dict[str, Any]:
    explicit = options.get(CONF_FAVOURITES)
    return {
        "favourites": list(explicit)
        if isinstance(explicit, list)
        else label_favourites(hass, options),
        "favourites_from_label": not isinstance(explicit, list),
        "groups": list(options.get(CONF_GROUPS) or []),
        "room_order": list(options.get(CONF_ROOM_ORDER) or []),
        "hidden_areas": list(options.get(CONF_HIDDEN_AREAS) or []),
        "hidden_entities": list(options.get(CONF_HIDDEN_ENTITIES) or []),
    }


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config"})
@websocket_api.require_admin
@callback
def ws_config(hass: HomeAssistant, connection, msg) -> None:
    """Everything the panel needs to draw itself."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    options = runtime.options
    areas = area_registry.async_get(hass).areas
    area_names = {area_id: area.name for area_id, area in areas.items()}

    # The panel lists hidden entities too, so they can be shown again.
    listing = dict(options)
    listing[CONF_HIDDEN_ENTITIES] = []
    entities = []
    for entry, state, area_id in usable_entities(hass, listing):
        friendly = state.attributes.get("friendly_name") or entry.name or entry.original_name
        name = str(friendly or entry.entity_id).strip()
        entities.append(
            {
                "entity_id": entry.entity_id,
                "name": name,
                "short": _trim_area(name, area_names.get(area_id)) if area_id else name,
                "domain": entry.domain,
                "area_id": area_id,
            }
        )
    entities.sort(key=lambda item: item["name"].casefold())

    labels = label_registry.async_get(hass)
    connection.send_result(
        msg["id"],
        {
            "areas": [
                {"id": area_id, "name": area.name, "icon": area.icon}
                for area_id, area in areas.items()
            ],
            "entities": entities,
            "layout": _layout(hass, options),
            "settings": {
                CONF_ALLOW_REMOTE: bool(options.get(CONF_ALLOW_REMOTE, False)),
                "favourites_label": _label_name(
                    labels, options.get(CONF_FAVOURITES_LABEL, DEFAULT_FAVOURITES_LABEL)
                ),
                "hide_label": _label_name(
                    labels, options.get(CONF_HIDE_LABEL, DEFAULT_HIDE_LABEL)
                ),
            },
            "preview": panel_payload(hass, options),
            **_status(runtime),
        },
    )


def _label_name(labels, value: str | None) -> str | None:
    label_id = _label_id(labels, value)
    if label_id and (entry := labels.async_get_label(label_id)):
        return entry.name
    return None


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/status"})
@websocket_api.require_admin
@callback
def ws_status(hass: HomeAssistant, connection, msg) -> None:
    """Paired remotes and waiting pairing requests, polled by the panel."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    connection.send_result(msg["id"], _status(runtime))


def _update_options(hass: HomeAssistant, runtime, changes: dict[str, Any]) -> None:
    options = dict(runtime.entry.options)
    for key, value in changes.items():
        if value is None:
            options.pop(key, None)
        else:
            options[key] = value
    hass.config_entries.async_update_entry(runtime.entry, options=options)
    # The update listener does this too, but the panel reads straight back.
    runtime.async_update_options(options)


def _clean_ids(values: list[str]) -> list[str]:
    seen: list[str] = []
    for value in values:
        if value.split(".", 1)[0] in ALLOWED_DOMAINS and value not in seen:
            seen.append(value)
    return seen


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/save_layout",
        # None goes back to the favourites label.
        vol.Optional("favourites"): vol.Any(None, ENTITY_LIST),
        vol.Optional("groups"): vol.All([GROUP_SCHEMA], vol.Length(max=GROUP_LIMIT)),
        vol.Optional("room_order"): vol.All(
            [vol.All(str, vol.Length(max=80))], vol.Length(max=LIST_LIMIT)
        ),
        vol.Optional("hidden_areas"): vol.All(
            [vol.All(str, vol.Length(max=80))], vol.Length(max=LIST_LIMIT)
        ),
        vol.Optional("hidden_entities"): ENTITY_LIST,
    }
)
@websocket_api.require_admin
@callback
def ws_save_layout(hass: HomeAssistant, connection, msg) -> None:
    """Save favourites, groups, room order and what is hidden."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    changes: dict[str, Any] = {}
    if "favourites" in msg:
        changes[CONF_FAVOURITES] = (
            None if msg["favourites"] is None else _clean_ids(msg["favourites"])
        )
    if "groups" in msg:
        groups = []
        used: set[str] = set()
        for group in msg["groups"]:
            group_id = group.get("id") or secrets.token_hex(4)
            while group_id in used:
                group_id = secrets.token_hex(4)
            used.add(group_id)
            groups.append(
                {
                    "id": group_id,
                    "name": group["name"],
                    "entities": _clean_ids(group["entities"]),
                }
            )
        changes[CONF_GROUPS] = groups
    if "room_order" in msg:
        changes[CONF_ROOM_ORDER] = list(dict.fromkeys(msg["room_order"]))
    if "hidden_areas" in msg:
        changes[CONF_HIDDEN_AREAS] = list(dict.fromkeys(msg["hidden_areas"]))
    if "hidden_entities" in msg:
        changes[CONF_HIDDEN_ENTITIES] = _clean_ids(msg["hidden_entities"])
    _update_options(hass, runtime, changes)
    connection.send_result(
        msg["id"],
        {
            "layout": _layout(hass, runtime.options),
            "preview": panel_payload(hass, runtime.options),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/save_settings",
        vol.Required(CONF_ALLOW_REMOTE): bool,
    }
)
@websocket_api.require_admin
@callback
def ws_save_settings(hass: HomeAssistant, connection, msg) -> None:
    """Save the settings tab."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    _update_options(hass, runtime, {CONF_ALLOW_REMOTE: msg[CONF_ALLOW_REMOTE]})
    connection.send_result(msg["id"], {CONF_ALLOW_REMOTE: msg[CONF_ALLOW_REMOTE]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/pair",
        vol.Required("code"): vol.All(str, vol.Strip, vol.Length(max=16)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_pair(hass: HomeAssistant, connection, msg) -> None:
    """Approve the code shown on a remote. Result: approved, wrong, expired or none."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    code = "".join(ch for ch in msg["code"] if ch.isdigit())
    result = await runtime.async_approve_code(code)
    connection.send_result(msg["id"], {"result": result, **_status(runtime)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/remove_device",
        vol.Required("device_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_remove_device(hass: HomeAssistant, connection, msg) -> None:
    """Unpair one remote. Its key stops working straight away."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    removed = await runtime.async_remove_device(msg["device_id"])
    connection.send_result(msg["id"], {"removed": removed, **_status(runtime)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/rename_device",
        vol.Required("device_id"): str,
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=64)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_rename_device(hass: HomeAssistant, connection, msg) -> None:
    """Rename one remote."""

    runtime = _runtime_or_error(hass, connection, msg)
    if runtime is None:
        return
    renamed = await runtime.async_rename_device(msg["device_id"], msg["name"])
    connection.send_result(msg["id"], {"renamed": renamed, **_status(runtime)})
