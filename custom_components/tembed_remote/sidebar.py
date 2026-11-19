"""The T-Embed sidebar panel."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_STATIC_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
)

PANEL_FILE = Path(__file__).parent / "frontend" / "tembed-panel.js"


def _version() -> str:
    """Bust the browser cache whenever the panel file changes."""

    return str(int(PANEL_FILE.stat().st_mtime))


async def async_register_panel(hass: HomeAssistant) -> None:
    """Serve the panel script and add T-Embed to the sidebar."""

    data = hass.data.setdefault(DOMAIN, {})
    if not data.get("static_registered"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, str(PANEL_FILE.parent), False)]
        )
        data["static_registered"] = True
    if PANEL_URL_PATH in hass.data.get(frontend.DATA_PANELS, {}):
        return
    version = await hass.async_add_executor_job(_version)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{PANEL_STATIC_URL}/tembed-panel.js?v={version}",
        require_admin=True,
        config={},
    )


def async_remove_panel(hass: HomeAssistant) -> None:
    """Take T-Embed out of the sidebar."""

    if PANEL_URL_PATH in hass.data.get(frontend.DATA_PANELS, {}):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
