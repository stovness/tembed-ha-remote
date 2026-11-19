"""Build the panel payload from Home Assistant's registries and states."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import (
    area_registry,
    device_registry,
    entity_registry,
    label_registry,
)
from homeassistant.helpers.entity_registry import RegistryEntry

from .const import (
    ALLOWED_DOMAINS,
    API_VERSION,
    CONF_FAVOURITES,
    CONF_FAVOURITES_LABEL,
    CONF_GROUPS,
    CONF_HIDE_LABEL,
    CONF_HIDDEN_AREAS,
    CONF_HIDDEN_ENTITIES,
    CONF_ROOM_ORDER,
    DEFAULT_FAVOURITES_LABEL,
    DEFAULT_HIDE_LABEL,
    PANEL_VERSION_LENGTH,
)

Row = list[Any]


def _as_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _label_id(registry: label_registry.LabelRegistry, value: str | None) -> str | None:
    """Resolve a configured label id or display name to a label id."""

    if not value:
        return None
    if entry := registry.async_get_label(value):
        return entry.label_id
    if entry := registry.async_get_label_by_name(value):
        return entry.label_id
    return value


def _area_name(hass: HomeAssistant, entry: RegistryEntry) -> str | None:
    areas = area_registry.async_get(hass)
    devices = device_registry.async_get(hass)
    area_id = entry.area_id
    if area_id is None and entry.device_id:
        if device := devices.async_get(entry.device_id):
            area_id = device.area_id
    if area_id is None:
        return None
    if area := areas.areas.get(area_id):
        return area.name
    return None


def _friendly_name(state: State, entry: RegistryEntry) -> str:
    name = state.attributes.get("friendly_name")
    if not isinstance(name, str) or not name.strip():
        name = entry.name or entry.original_name or state.entity_id
    return name.strip()


def _trim_area(name: str, area_name: str | None) -> str:
    if area_name:
        prefix = area_name.casefold() + " "
        if name.casefold().startswith(prefix):
            name = name[len(area_name) :].lstrip()
    if not name:
        return name
    return name[0].upper() + name[1:]


def _extra(state: State) -> int | float | None:
    if state.domain == "light":
        modes = state.attributes.get("supported_color_modes") or []
        dimmable = any(str(mode).casefold() != "onoff" for mode in modes)
        if not dimmable:
            return None
        brightness = _as_number(state.attributes.get("brightness"))
        if brightness is None:
            return None
        return max(0, min(100, round(brightness * 100 / 255)))
    if state.domain == "climate":
        temperature = _as_number(state.attributes.get("temperature"))
        if temperature is None:
            temperature = _as_number(state.attributes.get("target_temp_low"))
        if temperature is None:
            temperature = _as_number(state.attributes.get("target_temp_high"))
        return temperature
    if state.domain == "cover":
        position = _as_number(state.attributes.get("current_position"))
        if position is None:
            return None
        return max(0, min(100, round(position)))
    if state.domain == "media_player":
        volume = _as_number(state.attributes.get("volume_level"))
        if volume is None:
            return None
        return max(0, min(100, round(volume * 100)))
    return None


def build_row(state: State, entry: RegistryEntry, area_name: str | None) -> Row:
    """Build one [entity_id, name, state, extra] row."""

    name = _trim_area(_friendly_name(state, entry), area_name)
    return [state.entity_id, name, state.state, _extra(state)]


def build_entity_row(hass: HomeAssistant, entity_id: str) -> Row | None:
    """Build a row for one entity, if it has a state and a registry entry."""

    entities = entity_registry.async_get(hass)
    entry = entities.async_get(entity_id)
    state = hass.states.get(entity_id)
    if entry is None or state is None:
        return None
    return build_row(state, entry, _area_name(hass, entry))


def _usable_entity(entry: RegistryEntry, state: State, hide_label: str | None) -> bool:
    if entry.domain not in ALLOWED_DOMAINS:
        return False
    if entry.disabled_by is not None or entry.hidden_by is not None:
        return False
    if hide_label is not None and hide_label in entry.labels:
        return False
    return state.state is not None


def _entity_area(entry: RegistryEntry, devices: Any) -> str | None:
    area_id = entry.area_id
    if area_id is None and entry.device_id:
        if device := devices.async_get(entry.device_id):
            area_id = device.area_id
    return area_id


def usable_entities(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[tuple[RegistryEntry, State, str | None]]:
    """Every entity the remote may show, with its area id.

    Leaves out what the hide label or the panel's hidden list removes.
    """

    devices = device_registry.async_get(hass)
    entities = entity_registry.async_get(hass).entities
    labels = label_registry.async_get(hass)
    hide_label = _label_id(labels, options.get(CONF_HIDE_LABEL, DEFAULT_HIDE_LABEL))
    hidden_entities = set(options.get(CONF_HIDDEN_ENTITIES) or [])

    found: list[tuple[RegistryEntry, State, str | None]] = []
    for entry in entities.values():
        if entry.entity_id in hidden_entities:
            continue
        state = hass.states.get(entry.entity_id)
        if state is None or not _usable_entity(entry, state, hide_label):
            continue
        found.append((entry, state, _entity_area(entry, devices)))
    return found


def label_favourites(hass: HomeAssistant, options: dict[str, Any]) -> list[str]:
    """Entity ids carrying the favourites label, used until the panel saves a list."""

    labels = label_registry.async_get(hass)
    label = _label_id(
        labels, options.get(CONF_FAVOURITES_LABEL, DEFAULT_FAVOURITES_LABEL)
    )
    if label is None:
        return []
    return [
        entry.entity_id
        for entry, _state, _area in usable_entities(hass, options)
        if label in entry.labels
    ]


def _content(hass: HomeAssistant, options: dict[str, Any]) -> dict[str, Any]:
    areas = area_registry.async_get(hass).areas
    hidden_areas = set(options.get(CONF_HIDDEN_AREAS) or [])
    area_names = {area_id: area.name for area_id, area in areas.items()}

    usable = usable_entities(hass, options)
    by_id = {entry.entity_id: (entry, state, area_id) for entry, state, area_id in usable}

    def row(entity_id: str, trim: bool = True) -> Row | None:
        found = by_id.get(entity_id)
        if found is None:
            return None
        entry, state, area_id = found
        area_name = area_names.get(area_id) if (trim and area_id) else None
        return build_row(state, entry, area_name)

    explicit = options.get(CONF_FAVOURITES)
    favourite_ids = (
        list(explicit) if isinstance(explicit, list) else label_favourites(hass, options)
    )
    favourites = [r for r in (row(eid) for eid in favourite_ids) if r is not None]

    sections: dict[str, list[Any]] = {}
    rooms: dict[str, list[Row]] = {}
    for entry, _state, area_id in usable:
        if area_id is None or area_id not in area_names or area_id in hidden_areas:
            continue
        if (r := row(entry.entity_id)) is not None:
            rooms.setdefault(area_id, []).append(r)
    for area_id, area in areas.items():
        if rows := rooms.get(area_id):
            sections[f"a:{area_id}"] = [area.name, rows]

    for group in options.get(CONF_GROUPS) or []:
        if not isinstance(group, dict):
            continue
        # A group mixes rooms, so names keep their room prefix.
        rows = [
            r
            for r in (row(eid, trim=False) for eid in group.get("entities") or [])
            if r is not None
        ]
        if rows and group.get("id") and group.get("name"):
            sections[f"g:{group['id']}"] = [str(group["name"]), rows]

    room_list: list[list[Any]] = []
    for key in options.get(CONF_ROOM_ORDER) or []:
        if key in sections:
            room_list.append(sections.pop(key))
    room_list.extend(sections.values())

    return {"f": favourites, "r": room_list}


def panel_payload(hass: HomeAssistant, options: dict[str, Any]) -> dict[str, Any]:
    """Build the versioned panel payload."""

    content = _content(hass, options)
    raw = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    version = hashlib.sha256(raw.encode()).hexdigest()[:PANEL_VERSION_LENGTH]
    return {"api": API_VERSION, "v": version, **content}


def etag_matches(header: str | None, version: str) -> bool:
    """Return True when an If-None-Match header contains the version."""

    if not header:
        return False
    for part in header.split(","):
        candidate = part.strip()
        if candidate.startswith("W/"):
            candidate = candidate[2:].strip()
        if candidate.startswith('"') and candidate.endswith('"'):
            candidate = candidate[1:-1]
        if candidate in {version, "*"}:
            return True
    return False
