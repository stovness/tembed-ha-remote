"""Config and options flows for T-Embed Remote."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import label_registry as lr
from homeassistant.helpers.selector import (
    AreaSelector,
    AreaSelectorConfig,
    BooleanSelector,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
)
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ALLOW_REMOTE,
    CONF_FAVOURITES_LABEL,
    CONF_HIDE_LABEL,
    CONF_HIDDEN_AREAS,
    DEFAULT_FAVOURITES_LABEL,
    DEFAULT_HIDE_LABEL,
    DOMAIN,
    NAME,
)
from .runtime import get_runtime


def _last_seen(device: dict[str, Any]) -> str:
    raw = device.get("last_seen_at")
    if not isinstance(raw, str):
        return "never"
    seen = dt_util.parse_datetime(raw)
    if seen is None:
        return "never"
    return dt_util.as_local(seen).strftime("%Y-%m-%d %H:%M")


class TEmbedConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add the single T-Embed Remote instance."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title=NAME, data={})
        return self.async_show_form(step_id="user", data_schema=vol.Schema({}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return TEmbedOptionsFlow()


class TEmbedOptionsFlow(OptionsFlow):
    """Settings, pairing and paired device management."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=["settings", "pairing", "devices"],
        )

    async def async_step_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        current = dict(self.config_entry.options)
        if user_input is not None:
            options = dict(current)
            favourites = str(user_input.get(CONF_FAVOURITES_LABEL, "")).strip()
            hide = str(user_input.get(CONF_HIDE_LABEL, "")).strip()
            options[CONF_FAVOURITES_LABEL] = (
                favourites or DEFAULT_FAVOURITES_LABEL
            )
            options[CONF_HIDE_LABEL] = hide or DEFAULT_HIDE_LABEL
            options[CONF_HIDDEN_AREAS] = list(user_input.get(CONF_HIDDEN_AREAS) or [])
            options[CONF_ALLOW_REMOTE] = bool(user_input.get(CONF_ALLOW_REMOTE, False))
            return self.async_create_entry(title="", data=options)

        labels = lr.async_get(self.hass)
        choices = sorted(
            (
                SelectOptionDict(value=label.label_id, label=label.name)
                for label in labels.async_list_labels()
            ),
            key=lambda option: option["label"].casefold(),
        )

        def existing(value: str | None) -> str | None:
            if not value:
                return None
            entry = labels.async_get_label(value) or labels.async_get_label_by_name(value)
            return entry.label_id if entry else None

        def label_field(key: str, fallback: str) -> vol.Optional:
            found = existing(current.get(key, fallback))
            if found is None:
                return vol.Optional(key)
            return vol.Optional(key, default=found)

        picker = SelectSelector(
            SelectSelectorConfig(options=choices, mode=SelectSelectorMode.DROPDOWN)
        )

        return self.async_show_form(
            step_id="settings",
            data_schema=vol.Schema(
                {
                    label_field(CONF_FAVOURITES_LABEL, DEFAULT_FAVOURITES_LABEL): picker,
                    label_field(CONF_HIDE_LABEL, DEFAULT_HIDE_LABEL): picker,
                    vol.Optional(
                        CONF_HIDDEN_AREAS,
                        default=list(current.get(CONF_HIDDEN_AREAS) or []),
                    ): AreaSelector(AreaSelectorConfig(multiple=True)),
                    vol.Optional(
                        CONF_ALLOW_REMOTE,
                        default=bool(current.get(CONF_ALLOW_REMOTE, False)),
                    ): BooleanSelector(),
                }
            ),
        )

    async def async_step_pairing(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return self.async_abort(reason="not_setup")

        if user_input is not None:
            raw = user_input.get("code")
            code = raw.strip() if isinstance(raw, str) else ""
            result = await runtime.async_approve_code(code)
            if result == "approved":
                return self.async_abort(reason="pairing_complete")
            if result == "expired":
                return self.async_abort(reason="pairing_expired")
            if result == "none":
                return self.async_abort(reason="no_pending")
            return self.async_show_form(
                step_id="pairing",
                data_schema=vol.Schema({vol.Required("code"): TextSelector()}),
                errors={"base": "invalid_code"},
            )

        if not runtime.has_pending():
            return self.async_abort(reason="no_pending")
        return self.async_show_form(
            step_id="pairing",
            data_schema=vol.Schema({vol.Required("code"): TextSelector()}),
        )

    async def async_step_devices(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        runtime = get_runtime(self.hass)
        if runtime is None:
            return self.async_abort(reason="not_setup")

        devices = runtime.device_list()
        if not devices:
            return self.async_abort(reason="no_devices")

        errors: dict[str, str] | None = None
        if user_input is not None:
            raw = user_input.get("device_id")
            device_id = raw if isinstance(raw, str) else ""
            if await runtime.async_remove_device(device_id):
                return self.async_abort(reason="device_removed")
            errors = {"base": "unknown_device"}

        options = [
            SelectOptionDict(
                value=device_id,
                label=f"{device.get('name', 'T-Embed')} (last seen {_last_seen(device)})",
            )
            for device_id, device in devices
        ]
        return self.async_show_form(
            step_id="devices",
            data_schema=vol.Schema(
                {
                    vol.Required("device_id"): SelectSelector(
                        SelectSelectorConfig(
                            options=options,
                            mode=SelectSelectorMode.LIST,
                        )
                    )
                }
            ),
            errors=errors,
        )
