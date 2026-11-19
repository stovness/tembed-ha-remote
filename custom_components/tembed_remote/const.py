"""Constants for the T-Embed Remote integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "tembed_remote"
NAME = "T-Embed Remote"
MANUFACTURER = "LilyGO"
MODEL = "T-Embed CC1101"

# The integration and the app are released together, but an old app can meet a
# new integration and the other way round. Both sides compare this number.
API_VERSION = 1

CONF_FAVOURITES_LABEL = "favourites_label"
CONF_HIDE_LABEL = "hide_label"
CONF_HIDDEN_AREAS = "hidden_areas"
CONF_ALLOW_REMOTE = "allow_remote"
# Set from the sidebar panel. Favourites become an explicit ordered list once
# the panel saves them; until then the favourites label decides.
CONF_FAVOURITES = "favourites"
CONF_GROUPS = "groups"
CONF_ROOM_ORDER = "room_order"
CONF_HIDDEN_ENTITIES = "hidden_entities"

DEFAULT_FAVOURITES_LABEL = "t_embed_favourite"
DEFAULT_HIDE_LABEL = "t_embed_hide"

ALLOWED_DOMAINS = frozenset(
    {"light", "switch", "fan", "scene", "script", "climate", "cover", "media_player"}
)
SWITCH_DOMAINS = frozenset({"light", "switch", "fan", "climate"})
SCENE_SCRIPT_DOMAINS = frozenset({"scene", "script"})
COVER_SERVICES = {
    "open": "open_cover",
    "close": "close_cover",
    "stop": "stop_cover",
}

PAIR_CODE_TTL = timedelta(minutes=5)
PAIR_CODE_SECONDS = int(PAIR_CODE_TTL.total_seconds())
PAIR_POLL_SECONDS = 2
PAIR_PENDING_LIMIT = 3
PAIR_START_LIMIT = 10
PAIR_START_WINDOW = timedelta(minutes=10)
PAIR_MAX_WRONG = 5

COMMAND_WAIT_SECONDS = 2.0
COMMAND_POLL_SECONDS = 0.05

# Last seen changes on every panel read. Writing that to disk per request would
# rewrite the store about 2,900 times a day for one remote polling every 30 s.
LAST_SEEN_SAVE_DELAY = 60

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.devices"

PANEL_VERSION_LENGTH = 16

# Sidebar panel
PANEL_URL_PATH = "t-embed"
PANEL_TITLE = "T-Embed"
PANEL_ICON = "mdi:remote"
PANEL_ELEMENT = "tembed-remote-panel"
PANEL_STATIC_URL = "/tembed_remote_static"

GROUP_NAME_LIMIT = 40
GROUP_LIMIT = 30
LIST_LIMIT = 200
