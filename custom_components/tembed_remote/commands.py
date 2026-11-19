"""Run one device command against Home Assistant."""

from __future__ import annotations

import asyncio
import math
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.exceptions import HomeAssistantError

from .const import (
    COMMAND_POLL_SECONDS,
    COMMAND_WAIT_SECONDS,
    COVER_SERVICES,
    SCENE_SCRIPT_DOMAINS,
    SWITCH_DOMAINS,
)
from .panel import build_entity_row, panel_payload

CommandError = tuple[dict[str, str], int]


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _signature(state: State | None) -> tuple[Any, ...] | None:
    if state is None:
        return None
    return (
        state.state,
        state.attributes.get("brightness"),
        state.attributes.get("temperature"),
        state.attributes.get("volume_level"),
        state.attributes.get("current_position"),
    )


async def _wait_for_change(
    hass: HomeAssistant, entity_id: str, before: tuple[Any, ...] | None
) -> None:
    deadline = asyncio.get_running_loop().time() + COMMAND_WAIT_SECONDS
    while asyncio.get_running_loop().time() < deadline:
        if _signature(hass.states.get(entity_id)) != before:
            return
        await asyncio.sleep(COMMAND_POLL_SECONDS)


async def async_execute(
    hass: HomeAssistant,
    options: dict[str, Any],
    entity_id: Any,
    action: Any,
    value: Any,
) -> tuple[dict[str, Any] | None, CommandError | None]:
    """Execute a command and return the resulting row or an error."""

    if not isinstance(entity_id, str) or not isinstance(action, str):
        return None, ({"error": "bad_request"}, 400)
    if "." not in entity_id:
        return None, ({"error": "bad_request"}, 400)
    domain = entity_id.split(".", 1)[0]

    allowed = set()
    panel = panel_payload(hass, options)
    for row in panel["f"]:
        allowed.add(row[0])
    for _room, rows in panel["r"]:
        for row in rows:
            allowed.add(row[0])
    if entity_id not in allowed:
        return None, ({"error": "not_allowed"}, 403)

    state = hass.states.get(entity_id)
    if state is None:
        return None, ({"error": "not_allowed"}, 403)

    service = action
    service_data: dict[str, Any] = {"entity_id": entity_id}

    if action == "play_pause":
        if domain != "media_player":
            return None, ({"error": "bad_request"}, 400)
        service = "turn_on" if state.state == "off" else "media_play_pause"
    elif action == "volume":
        volume = _number(value)
        if domain != "media_player" or volume is None or not 0 <= volume <= 100:
            return None, ({"error": "bad_request"}, 400)
        service = "volume_set"
        service_data["volume_level"] = volume / 100
    elif action in COVER_SERVICES:
        if domain != "cover":
            return None, ({"error": "bad_request"}, 400)
        service = COVER_SERVICES[action]
    elif action == "position":
        position = _number(value)
        if domain != "cover" or position is None or not 0 <= position <= 100:
            return None, ({"error": "bad_request"}, 400)
        service = "set_cover_position"
        service_data["position"] = position
    elif action in {"toggle", "turn_on", "turn_off"}:
        if domain not in SWITCH_DOMAINS:
            return None, ({"error": "bad_request"}, 400)
    elif action == "run":
        if domain not in SCENE_SCRIPT_DOMAINS:
            return None, ({"error": "bad_request"}, 400)
        service = "turn_on"
    elif action == "brightness":
        brightness = _number(value)
        if domain != "light" or brightness is None or not 1 <= brightness <= 100:
            return None, ({"error": "bad_request"}, 400)
        service = "turn_on"
        service_data["brightness_pct"] = brightness
    elif action == "temperature":
        temperature = _number(value)
        if domain != "climate" or temperature is None:
            return None, ({"error": "bad_request"}, 400)
        minimum = _number(state.attributes.get("min_temp"))
        maximum = _number(state.attributes.get("max_temp"))
        if minimum is not None:
            temperature = max(minimum, temperature)
        if maximum is not None:
            temperature = min(maximum, temperature)
        service = "set_temperature"
        service_data["temperature"] = temperature
    else:
        return None, ({"error": "bad_request"}, 400)

    before = _signature(state)
    try:
        await hass.services.async_call(domain, service, service_data, blocking=True)
    except HomeAssistantError:
        return None, ({"error": "bad_request"}, 400)

    await _wait_for_change(hass, entity_id, before)
    row = build_entity_row(hass, entity_id)
    if row is None:
        return None, ({"error": "bad_request"}, 400)
    return {"row": row}, None
