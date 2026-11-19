# Device API (integration <-> T-Embed app)

The Home Assistant integration `tembed_remote` serves these endpoints. The
app on the T-Embed is the only client. Bodies from the integration are JSON.
API version 1.

Every JSON response from the integration carries `"api": 1`, the version of
this API. The app has the same number compiled in. If the integration's number
is higher the app says "Update HA Remote on the SD card."; if it is lower the
app says "Update T-Embed Remote in Home Assistant.". Both keep working: the
number only drives a notice in the footer. A response without `api` is treated
as version 1, so an older integration still serves an older app.

Paired devices send `Authorization: Bearer <device key>`. Device keys are not
Home Assistant tokens: they only work on these endpoints and only for the
entities in that device's panel.

Devices may also send `X-TEmbed-Battery: <0-100>` on panel reads and commands.
The integration stores the last reading and exposes it as a battery sensor;
anything missing, out of range or not a whole number is ignored.

## Access

All four endpoints answer only requests that arrive from a local address:
private, loopback or link-local. The address is the one Home Assistant has
worked out for the request (`request.remote`, which respects
`use_x_forwarded_for` and trusted proxies). Anything else gets 403
`{"error": "local_only"}`. The remote only uses plain http on the LAN, so a
key copied off a lost SD card does not work from the internet.

Settings has a switch, "Allow from outside my network", off by default, which
turns that check off for setups that need it.

## Pairing

### POST /api/tembed_remote/pair/start  (no auth)

Request: `{"name": "T-Embed", "model": "lilygo-t-embed-cc1101", "app": "1.0.0"}`

Response 200: `{"api": 1, "pair_id": "<random 22+ chars>", "code": "483920", "expires_in": 300, "poll": 2}`

- Code is 6 random digits. Pairing request lives 5 minutes.
- Home Assistant shows a persistent notification "A T-Embed wants to connect",
  linking to where the code is entered.
- At most 3 pending requests at once, and at most 10 starts per 10 minutes per
  client IP. Over the limit: 429 `{"error": "busy"}`.
- 404 if the integration is installed but not set up (a plain 404 from Home
  Assistant; the app then shows "Add T-Embed Remote in Home Assistant").

### GET /api/tembed_remote/pair/status?pair_id=...  (no auth)

- `{"api": 1, "status": "pending"}` while waiting.
- `{"status": "approved", "key": "<device key>", "device_id": "<id>"}` once,
  right after the user enters the right code. The key is returned exactly
  once; later calls return `{"status": "gone"}`.
- `{"status": "expired"}` after 5 minutes, or after 5 wrong codes. Wrong
  codes are counted across all pending requests, because the code form only
  sends the code and does not identify a request.
- `{"status": "gone"}` for unknown ids.

## Use

### GET /api/tembed_remote/panel  (device key)

Response 200: same shape the template sensor produces today, plus a version:

```
{"api": 1,
 "v": "<short hash of the content>",
 "f": [[entity_id, name, state, extra], ...],
 "r": [[area_name, [[entity_id, name, state, extra], ...]], ...]}
```

- `extra`: brightness 0-100 for dimmable lights, target temperature for
  climate, cover position 0-100, media player volume 0-100, otherwise null.
- Domains: light, switch, fan, scene, script, climate, cover, media_player.
- Favourites: entities with the favourites label (setting, default
  `t_embed_favourite`). Rooms: Areas, in area registry order, skipping
  hidden rooms (setting) and areas with no usable entities. Entities that are
  hidden, disabled or carry the hide label (`t_embed_hide`) are left out.
  An entity's area comes from its device if the entity has none.
- Names: friendly name with a leading area name removed ("Bedroom lamp" in
  Bedroom becomes "Lamp"), first letter upper-cased.
- `If-None-Match: <v>` returns 304 with no body when nothing changed.
- Size: a 25 area, 300 entity house produces about 18 KB, which is the worst
  case tested. No row cap is needed below 24 KB; above that, cap rows per room.
- 401 `{"error": "unpaired"}` for an unknown or removed key (the app then
  goes back to pairing).

### POST /api/tembed_remote/command  (device key)

Request: `{"entity_id": "light.bedroom_lamp", "action": "...", "value": ...}`

Actions:
- `toggle`, `turn_on`, `turn_off`: light, switch, fan, climate.
- `brightness`: light, value 1-100 (percent).
- `run`: scene (turn_on), script (turn_on).
- `temperature`: climate, value in the entity's unit, clamped to its min/max.
- `open`, `close`, `stop`: cover (`open_cover`, `close_cover`, `stop_cover`).
- `position`: cover, value 0-100 (`set_cover_position`).
- `play_pause`: media_player (`media_play_pause`, or `turn_on` when the
  player is off).
- `volume`: media_player, value 0-100 (`volume_set`, stored as 0.0-1.0).

Response 200: `{"row": [entity_id, name, state, extra]}` with the state after
the call (wait up to 2 s for the state to change).

Errors: 403 `{"error": "not_allowed"}` if the entity is not in this device's
panel, 400 `{"error": "bad_request"}` for a bad action or value, 401 as above,
403 `{"error": "local_only"}` from outside the local network.

## Settings (integration options)

- Favourites label (default `t_embed_favourite`).
- Hide label (default `t_embed_hide`).
- Hidden rooms (pick Areas).
- Allow from outside my network (off by default; see Access above).
- Paired devices: list with name and last seen, and remove.
- Enter a pairing code.

## Remotes in Home Assistant

Each paired remote is a device, with the name, model and app version it
reported at pairing, and two diagnostic sensors:

- Last seen: timestamp of the last authenticated request.
- Battery: percentage from `X-TEmbed-Battery`, created the first time the app
  sends a usable reading.

Removing the device in Home Assistant unpairs the remote and invalidates its
key; the app asks for a new code on its next request. The Configure, Paired
devices list does the same thing.
