"""Sensors for each paired T-Embed remote."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import StateType
from homeassistant.util import dt as dt_util

from .runtime import TEmbedRuntime, get_runtime


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add a sensor pair for every paired remote, now and later."""

    runtime = get_runtime(hass)
    if runtime is None:
        return

    known: set[tuple[str, str]] = set()
    entities: list[TEmbedSensor] = []

    @callback
    def add_new() -> None:
        new: list[TEmbedSensor] = []
        for device_id, device in runtime.devices.items():
            if (device_id, "last_seen") not in known:
                known.add((device_id, "last_seen"))
                new.append(TEmbedLastSeen(runtime, device_id))
            if (device_id, "battery") not in known and battery_of(device) is not None:
                known.add((device_id, "battery"))
                new.append(TEmbedBattery(runtime, device_id))
        if new:
            entities.extend(new)
            async_add_entities(new)
        for entity in entities:
            entity.async_device_changed()

    add_new()
    entry.async_on_unload(runtime.async_add_listener(add_new))


def battery_of(device: dict[str, Any]) -> int | None:
    """Return a usable battery percentage, or None."""

    value = device.get("battery")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if 0 <= value <= 100:
        return value
    return None


class TEmbedSensor(SensorEntity):
    """Base for the sensors that hang off one remote."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, runtime: TEmbedRuntime, device_id: str, key: str) -> None:
        self.runtime = runtime
        self.device_id = device_id
        self._attr_unique_id = f"{device_id}_{key}"
        self._attr_translation_key = key

    @property
    def device_info(self) -> DeviceInfo:
        device = self.runtime.devices.get(self.device_id, {})
        return self.runtime.device_info(self.device_id, device)

    @property
    def available(self) -> bool:
        return self.device_id in self.runtime.devices

    @callback
    def async_device_changed(self) -> None:
        if self.hass is not None:
            self.async_write_ha_state()


class TEmbedLastSeen(TEmbedSensor):
    """When the remote last read the panel."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, runtime: TEmbedRuntime, device_id: str) -> None:
        super().__init__(runtime, device_id, "last_seen")

    @property
    def native_value(self) -> Any:
        raw = self.runtime.devices.get(self.device_id, {}).get("last_seen_at")
        if not isinstance(raw, str):
            return None
        return dt_util.parse_datetime(raw)


class TEmbedBattery(TEmbedSensor):
    """Battery percentage the remote reported."""

    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = PERCENTAGE

    def __init__(self, runtime: TEmbedRuntime, device_id: str) -> None:
        super().__init__(runtime, device_id, "battery")

    @property
    def native_value(self) -> StateType:
        return battery_of(self.runtime.devices.get(self.device_id, {}))
