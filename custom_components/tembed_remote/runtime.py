"""Pairing, device keys and persistent storage for T-Embed Remote."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import hmac
import secrets
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    API_VERSION,
    DOMAIN,
    LAST_SEEN_SAVE_DELAY,
    MANUFACTURER,
    MODEL,
    PAIR_CODE_SECONDS,
    PAIR_CODE_TTL,
    PAIR_MAX_WRONG,
    PAIR_PENDING_LIMIT,
    PAIR_POLL_SECONDS,
    PAIR_START_LIMIT,
    PAIR_START_WINDOW,
    STORAGE_KEY,
    STORAGE_VERSION,
)

NOTIFICATION_TITLE = "A T-Embed wants to connect"
NOTIFICATION_INSTRUCTIONS = (
    "[Open the T-Embed page](/t-embed/remotes) "
    "and enter the code shown on the T-Embed."
)


@dataclass
class PendingPairing:
    """One pending pairing request held in memory."""

    pair_id: str
    code: str
    name: str
    model: str
    app: str
    ip: str
    created_at: datetime
    expires_at: datetime
    status: str = "pending"
    key: str | None = None
    device_id: str | None = None
    notified: bool = True

    @property
    def notification_id(self) -> str:
        return f"{DOMAIN}_pair"


def get_runtime(hass: HomeAssistant) -> TEmbedRuntime | None:
    """Return the active runtime, if the integration is set up."""

    return hass.data.get(DOMAIN, {}).get("runtime")


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _short_text(value: Any, fallback: str, limit: int = 64) -> str:
    if not isinstance(value, str):
        return fallback
    value = value.strip()
    if not value:
        return fallback
    return value[:limit]


def _device_info(device_id: str, device: dict[str, Any]) -> dict[str, Any]:
    """Registry details for one paired remote."""

    return {
        "identifiers": {(DOMAIN, device_id)},
        "name": str(device.get("name", "T-Embed")),
        "manufacturer": MANUFACTURER,
        "model": str(device.get("model", MODEL)),
        "sw_version": str(device.get("app", "unknown")),
    }


class TEmbedRuntime:
    """Holds pairing state, device hashes and current options."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.options: dict[str, Any] = dict(entry.options)
        self.devices: dict[str, dict[str, Any]] = {}
        self.pending: dict[str, PendingPairing] = {}
        self._starts: dict[str, list[datetime]] = {}
        self._wrong_attempts = 0
        self._lock = asyncio.Lock()
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._listeners: list[Callable[[], None]] = []
        # In memory only: when each remote was last pushed to Home Assistant.
        self._last_notified: dict[str, datetime] = {}

    async def async_setup(self) -> None:
        """Load paired devices."""

        data = await self._store.async_load()
        if isinstance(data, dict):
            devices = data.get("devices")
            if isinstance(devices, dict):
                self.devices = {
                    device_id: device
                    for device_id, device in devices.items()
                    if isinstance(device, dict)
                    and isinstance(device.get("key_hash"), str)
                }
        self._async_sync_devices()
        persistent_notification.async_dismiss(self.hass, f"{DOMAIN}_pair")

    async def async_shutdown(self) -> None:
        """Dismiss pairing notices and flush state."""

        for pending in list(self.pending.values()):
            self._dismiss(pending)
        self.pending.clear()
        await self._store.async_save(self._data())

    def async_update_options(self, options: dict[str, Any]) -> None:
        """Apply changed options without dropping pairings or devices."""

        self.options = dict(options)

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Call back when a remote is added or removed."""

        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    @callback
    def _async_notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    def _data(self) -> dict[str, Any]:
        return {"version": STORAGE_VERSION, "devices": self.devices}

    async def _save(self) -> None:
        await self._store.async_save(self._data())

    def _save_soon(self) -> None:
        """Queue a save instead of writing on every request.

        Used for last seen, which changes on every panel read. Pairing,
        removal and unload still write immediately.
        """

        self._store.async_delay_save(self._data, LAST_SEEN_SAVE_DELAY)

    def device_info(self, device_id: str, device: dict[str, Any]) -> DeviceInfo:
        """Registry details for one remote, shared by registry and entities."""

        return DeviceInfo(**_device_info(device_id, device))

    @callback
    def _async_sync_devices(self) -> None:
        """Make sure every paired remote has a Home Assistant device."""

        registry = dr.async_get(self.hass)
        for device_id, device in self.devices.items():
            info = _device_info(device_id, device)
            entry = _registry_device(registry, device_id, self.entry.entry_id)
            if entry is None:
                registry.async_get_or_create(
                    config_entry_id=self.entry.entry_id, **info
                )
                continue
            changes = {
                key: value
                for key, value in info.items()
                if key != "identifiers" and getattr(entry, key) != value
            }
            if changes:
                registry.async_update_device(entry.id, **changes)

    def _dismiss(self, pending: PendingPairing) -> None:
        if not pending.notified or not self.hass.is_running:
            return
        pending.notified = False
        if any(
            other.notified and other.status == "pending"
            for other in self.pending.values()
        ):
            return
        persistent_notification.async_dismiss(self.hass, pending.notification_id)

    def _notify(self, pending: PendingPairing) -> None:
        persistent_notification.async_create(
            self.hass,
            NOTIFICATION_INSTRUCTIONS,
            title=NOTIFICATION_TITLE,
            notification_id=pending.notification_id,
        )

    def _expire(self, pending: PendingPairing) -> None:
        if pending.status == "pending":
            pending.status = "expired"
            self._dismiss(pending)

    def _prune(self, now: datetime) -> None:
        for pair_id, pending in list(self.pending.items()):
            if pending.status == "pending" and now >= pending.expires_at:
                self._expire(pending)
            if (
                pending.status != "pending"
                and now >= pending.created_at + (PAIR_CODE_TTL * 2)
            ):
                self.pending.pop(pair_id, None)

    def _active(self, now: datetime) -> list[PendingPairing]:
        return [
            pending
            for pending in self.pending.values()
            if pending.status == "pending" and now < pending.expires_at
        ]

    def _new_code(self, active: list[PendingPairing]) -> str:
        used = {pending.code for pending in active}
        while True:
            code = f"{secrets.randbelow(1_000_000):06d}"
            if code not in used:
                return code

    async def async_start_pairing(
        self, payload: dict[str, Any], ip: str
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Create a pairing request, or return an error code."""

        async with self._lock:
            now = dt_util.utcnow()
            self._prune(now)

            cutoff = now - PAIR_START_WINDOW
            starts = [start for start in self._starts.get(ip, []) if start > cutoff]
            if len(starts) >= PAIR_START_LIMIT:
                self._starts[ip] = starts
                return None, "busy"
            starts.append(now)
            self._starts[ip] = starts

            active = self._active(now)
            if len(active) >= PAIR_PENDING_LIMIT:
                return None, "busy"
            if not active:
                self._wrong_attempts = 0

            name = _short_text(payload.get("name"), "T-Embed")
            model = _short_text(payload.get("model"), "lilygo-t-embed-cc1101", 80)
            app = _short_text(payload.get("app"), "unknown", 32)
            pending = PendingPairing(
                pair_id=secrets.token_urlsafe(24),
                code=self._new_code(active),
                name=name,
                model=model,
                app=app,
                ip=ip,
                created_at=now,
                expires_at=now + PAIR_CODE_TTL,
            )
            self.pending[pending.pair_id] = pending
            self._notify(pending)
            return {
                "api": API_VERSION,
                "pair_id": pending.pair_id,
                "code": pending.code,
                "expires_in": PAIR_CODE_SECONDS,
                "poll": PAIR_POLL_SECONDS,
            }, None

    async def async_pair_status(self, pair_id: str | None) -> dict[str, Any]:
        """Return the current state of one pairing request."""

        if not pair_id:
            return {"status": "gone"}
        async with self._lock:
            now = dt_util.utcnow()
            self._prune(now)
            pending = self.pending.get(pair_id)
            if pending is None:
                return {"status": "gone"}
            if pending.status == "approved":
                result = {
                    "status": "approved",
                    "key": pending.key,
                    "device_id": pending.device_id,
                }
                self.pending.pop(pair_id, None)
                return result
            if pending.status == "expired":
                return {"status": "expired"}
            if now >= pending.expires_at:
                self._expire(pending)
                return {"status": "expired"}
            return {"status": "pending"}

    async def async_approve_code(self, code: str) -> str:
        """Approve a code. Returns approved, wrong, expired or none."""

        async with self._lock:
            now = dt_util.utcnow()
            self._prune(now)
            active = self._active(now)
            if not active:
                return "none"

            match = next((pending for pending in active if pending.code == code), None)
            if match is None:
                self._wrong_attempts += 1
                if self._wrong_attempts >= PAIR_MAX_WRONG:
                    for pending in active:
                        self._expire(pending)
                    self._wrong_attempts = 0
                    return "expired"
                return "wrong"

            key = secrets.token_urlsafe(32)
            device_id = secrets.token_hex(8)
            timestamp = now.isoformat()
            self.devices[device_id] = {
                "name": match.name,
                "model": match.model,
                "app": match.app,
                "key_hash": _key_hash(key),
                "created_at": timestamp,
                "last_seen_at": timestamp,
                "last_seen_ip": match.ip,
                "battery": None,
            }
            self._last_notified[device_id] = now
            await self._save()
            self._async_sync_devices()
            self._async_notify()

            match.status = "approved"
            match.key = key
            match.device_id = device_id
            self._wrong_attempts = 0
            self._dismiss(match)
            return "approved"

    async def async_remove_device(self, device_id: str) -> bool:
        """Remove a paired device and invalidate its key."""

        async with self._lock:
            if self.devices.pop(device_id, None) is None:
                return False
            self._last_notified.pop(device_id, None)
            await self._save()
            self._async_forget(device_id)
            return True

    async def async_rename_device(self, device_id: str, name: str) -> bool:
        """Rename a paired remote, here and in the device registry."""

        async with self._lock:
            device = self.devices.get(device_id)
            if device is None:
                return False
            device["name"] = name[:64]
            await self._save()
            self._async_sync_devices()
            self._async_notify()
            return True

    @callback
    def _async_forget(self, device_id: str) -> None:
        """Remove the registry entry for a remote that is no longer paired."""

        registry = dr.async_get(self.hass)
        entry = _registry_device(registry, device_id, self.entry.entry_id)
        if entry is not None:
            registry.async_remove_device(entry.id)
        self._async_notify()

    @callback
    def async_device_from_identifier(self, identifier: str) -> str | None:
        """Return the device id behind a registry identifier, if it is ours."""

        return identifier if identifier in self.devices else None

    async def async_authenticate(
        self, key: str | None, ip: str | None, battery: int | None = None
    ) -> str | None:
        """Check a device key, update last seen and battery, return the device id."""

        if not key:
            return None
        digest = _key_hash(key)
        async with self._lock:
            found: str | None = None
            for device_id, device in self.devices.items():
                if hmac.compare_digest(device["key_hash"], digest):
                    found = device_id
            if found is None:
                return None
            seen_at = dt_util.utcnow()
            now = seen_at.isoformat()
            device = self.devices[found]
            device["last_seen_at"] = now
            if ip:
                device["last_seen_ip"] = ip
            changed = False
            if battery is not None and battery != device.get("battery"):
                device["battery"] = battery
                changed = True
            # Last seen only needs telling to Home Assistant once a minute, so
            # the recorder gets one row per remote per minute at most. The
            # stamp is kept in memory so polling cannot push it forward.
            last = self._last_notified.get(found)
            if last is None or seen_at - last >= timedelta(
                seconds=LAST_SEEN_SAVE_DELAY
            ):
                self._last_notified[found] = seen_at
                changed = True
            if changed:
                self._async_notify()
            self._save_soon()
            return found

    def has_pending(self) -> bool:
        """Return True when at least one pairing code is still usable."""

        now = dt_util.utcnow()
        return bool(self._active(now))

    def device_list(self) -> list[tuple[str, dict[str, Any]]]:
        """Return devices in name order for the options flow."""

        return sorted(
            self.devices.items(),
            key=lambda item: (str(item[1].get("name", "")).casefold(), item[0]),
        )


def _registry_device(
    registry: dr.DeviceRegistry, device_id: str, entry_id: str
) -> dr.DeviceEntry | None:
    """The registry entry for a paired remote.

    Home Assistant 2026.11 replaced async_get_device with a lookup by single
    identifier. Use the new call where it exists so newer versions stay quiet.
    """

    identifier = (DOMAIN, device_id)
    lookup = getattr(registry, "async_get_device_by_identifier", None)
    if lookup is not None:
        return lookup(identifier, entry_id)
    return registry.async_get_device(identifiers={identifier})
