"""The T-Embed Remote integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, label_registry as lr
from homeassistant.helpers.device_registry import DeviceEntry
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_FAVOURITES_LABEL,
    CONF_HIDE_LABEL,
    DEFAULT_FAVOURITES_LABEL,
    DEFAULT_HIDE_LABEL,
    DOMAIN,
)
from .sidebar import async_register_panel, async_remove_panel
from .runtime import TEmbedRuntime, get_runtime
from .views import CommandView, PairStartView, PairStatusView, PanelView
from . import websocket

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
PLATFORMS = ["sensor"]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the device API views once."""

    data = hass.data.setdefault(DOMAIN, {})
    if not data.get("views_registered"):
        hass.http.register_view(PairStartView(hass))
        hass.http.register_view(PairStatusView(hass))
        hass.http.register_view(PanelView(hass))
        hass.http.register_view(CommandView(hass))
        websocket.async_register(hass)
        data["views_registered"] = True
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Load one T-Embed Remote config entry."""

    _ensure_default_labels(hass, entry)
    runtime = TEmbedRuntime(hass, entry)
    await runtime.async_setup()
    hass.data.setdefault(DOMAIN, {})["runtime"] = runtime
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await async_register_panel(hass)
    return True


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: ConfigEntry, device: DeviceEntry
) -> bool:
    """Unpair a remote when its device is removed in Home Assistant."""

    runtime = get_runtime(hass)
    if runtime is None:
        return False
    for domain, identifier in device.identifiers:
        if domain != DOMAIN:
            continue
        if runtime.async_device_from_identifier(identifier) is None:
            continue
        return await runtime.async_remove_device(identifier)
    return False


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the platforms, then drop the device API runtime."""

    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    async_remove_panel(hass)
    data = hass.data.get(DOMAIN, {})
    runtime: TEmbedRuntime | None = data.pop("runtime", None)
    if runtime is not None:
        await runtime.async_shutdown()
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Apply new options without reloading and losing pending pairings."""

    if runtime := hass.data.get(DOMAIN, {}).get("runtime"):
        runtime.async_update_options(entry.options)


DEFAULT_LABELS = (
    (CONF_FAVOURITES_LABEL, DEFAULT_FAVOURITES_LABEL, "T-Embed favourite",
     "mdi:star", "Shown in Favourites on the T-Embed remote"),
    (CONF_HIDE_LABEL, DEFAULT_HIDE_LABEL, "T-Embed hide",
     "mdi:eye-off", "Never shown on the T-Embed remote"),
)


def _ensure_default_labels(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Create the two default labels so tagging works straight after install.

    Only touches a label the user has not changed away from the default, and
    never edits one that already exists.
    """

    registry = lr.async_get(hass)
    for key, label_id, name, icon, description in DEFAULT_LABELS:
        if entry.options.get(key, label_id) != label_id:
            continue
        if registry.async_get_label(label_id) or registry.async_get_label_by_name(name):
            continue
        registry.async_create(name, icon=icon, description=description)
