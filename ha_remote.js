"use strict";

/*
 * HA Remote for the LilyGo T-Embed CC1101 running Bruce firmware.
 *
 * Bruce globals used, all checked against the firmware in README:
 *   display, keyboard, wifi, storage, now, delay, __dirpath.
 * The script is ES5-ish because Bruce embeds mquickjs, not a full browser JS.
 */

var display = require("display");
var keyboard = require("keyboard");
var wifi = require("wifi");
var storage = require("storage");
/* Bruce names the battery call getBatteryCharge (mqjs_stdlib.c, device).
   Other builds may not have the device module at all, so guard every use. */
var deviceModule = null;
try {
    deviceModule = require("device");
} catch (e) {
    deviceModule = null;
}

var WIDTH = 320;
var HEIGHT = 170;
var HOLD_MS = 400;
var SEL_RELEASE_MS = 250;
var DETAIL_IDLE_MS = 800;
var REFRESH_MS = 30000;
var BACKOFF_MS = 120000;
var CONFIG_NAME = "ha_config.json";
var PANEL_ENTITY = "sensor.t_embed_panel";
var FAVOURITES_TITLE = "Favourites";
var APP_VERSION = "0.2.1";
/* The integration's API number this copy understands. A newer integration
   asks for an app update, an older one asks for an integration update. */
var KNOWN_API = 1;
var API = "/api/tembed_remote";
var GUESS_URL = "http://homeassistant.local:8123";
var PAIR_POLL_MS = 2000;
var PAIR_RETRY_MS = 15000;


var app = {
    cfg: null,
    configPath: "",
    screen: "home",
    favourites: [],
    rooms: [],
    byId: {},
    roomName: "",
    roomIndex: 0,
    sel: 0,
    top: 0,
    detail: null,
    error: "",
    working: false,
    backoff: false,
    nextRefresh: 0,
    refreshNow: false,
    exitRequested: false,
    renderNeeded: true,
    fullRedraw: true,
    loaded: false,
    panelV: "",
    notice: "",
    setup: null,
    setupUrl: ""
};

var selActive = false;
var selStarted = 0;
var selLastSeen = 0;
var selLongDone = false;
var escDown = false;
/* Bruce stops the script if Esc is still pending when its interrupt check
   runs, which happens while we are busy drawing. Grab the press first and
   act on it at the next input poll. */
var escLatched = false;
var escHeld = false;
var escLastSeen = 0;
/* Like the dial, Esc repeats about every 200 ms while held, so only the
   first report after a gap counts as a press. */
function catchEsc() {
    if (keyboard.getEscPress()) {
        if (!escHeld) { escLatched = true; }
        escHeld = true;
        escLastSeen = now();
    }
}

function clamp(value, low, high) {
    if (value < low) { return low; }
    if (value > high) { return high; }
    return value;
}

function asText(value) {
    if (typeof value === "string") { return value; }
    if (typeof to_string === "function") { return to_string(value); }
    return "" + value;
}

function configPath() {
    var dir = typeof __dirpath !== "undefined" && __dirpath ? asText(__dirpath) : "/BruceJS/Tools";
    if (dir.length > 0 && dir.charAt(dir.length - 1) !== "/") { dir += "/"; }
    return dir + CONFIG_NAME;
}

function setError(text) {
    if (app.error === text) { return; }
    app.error = text;
    app.renderNeeded = true;
}

function clearError() { setError(""); }

/* A note that does not stop anything: the app and the integration can be
   different versions, and both sides say which one to bring forward. */
function setNotice(text) {
    if (app.notice === text) { return; }
    app.notice = text;
    app.renderNeeded = true;
}

function checkApi(data) {
    if (!data || typeof data.api !== "number") { return; }
    if (data.api > KNOWN_API) {
        setNotice("Update HA Remote on the SD card.");
    } else if (data.api < KNOWN_API) {
        setNotice("Update T-Embed Remote in Home Assistant.");
    } else {
        setNotice("");
    }
}

function scheduleBackoff() {
    app.backoff = true;
    app.nextRefresh = now() + BACKOFF_MS;
}

function scheduleNormalRefresh() {
    app.backoff = false;
    app.nextRefresh = now() + REFRESH_MS;
}

function loadConfig() {
    app.configPath = configPath();
    try {
        var text = storage.read(app.configPath);
        var cfg = JSON.parse(asText(text));
        if (!cfg || typeof cfg.url !== "string" || cfg.url.length < 1) { throw new Error("bad config"); }
        var url = trimSlash(cfg.url);
        if (typeof cfg.key === "string" && cfg.key.length > 0) {
            app.cfg = { url: url, key: cfg.key, token: "" };
        } else if (typeof cfg.token === "string" && cfg.token.length > 0) {
            app.cfg = { url: url, key: "", token: cfg.token };
        } else {
            /* Address known but not paired yet, or the pairing was removed. */
            app.cfg = null;
            return url;
        }
    } catch (e) {
        app.cfg = null;
    }
    return "";
}

function trimSlash(url) {
    while (url.length > 0 && url.charAt(url.length - 1) === "/") { url = url.substring(0, url.length - 1); }
    return url;
}

/* Paired through the T-Embed Remote integration, as opposed to the older
   setup with a long-lived token and a template sensor. */
function paired() { return !!(app.cfg && app.cfg.key); }

function saveConfig(obj) {
    try {
        return !!storage.write(app.configPath || configPath(), JSON.stringify(obj), "write");
    } catch (e) {
        return false;
    }
}

/* ---- pairing with the T-Embed Remote integration */

function setupState() {
    if (!app.setup) {
        app.setup = {
            step: "choose",
            url: app.setupUrl || "",
            code: "",
            pairId: "",
            nextPoll: 0,
            expires: 0,
            error: ""
        };
    }
    return app.setup;
}

function hostOf(url) {
    var cut = url.indexOf("://");
    var rest = cut >= 0 ? url.substring(cut + 3) : url;
    var slash = rest.indexOf("/");
    if (slash >= 0) { rest = rest.substring(0, slash); }
    return rest;
}

/* A bare fetch that does not need a saved key. Returns the response object,
   or null when the request never reached Home Assistant. */
function plainCall(url, method, path, body) {
    if (!wifi.connected()) { return null; }
    var options = { method: method, headers: { "Content-Type": "application/json" } };
    if (typeof body !== "undefined" && body !== null) { options.body = JSON.stringify(body); }
    try {
        return wifi.httpFetch(trimSlash(url) + path, options);
    } catch (e) {
        return null;
    }
}

function jsonOf(res) {
    try {
        var text = bodyText(res.body);
        if (text.length < 1) { return null; }
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function setupFail(text) {
    var st = setupState();
    st.step = "error";
    st.error = text;
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function beginPairing(url) {
    var st = setupState();
    st.url = trimSlash(url);
    st.step = "starting";
    st.error = "";
    app.fullRedraw = true;
    app.renderNeeded = true;
    render();
    if (!wifi.connected()) {
        setupFail("No WiFi. Connect from the Bruce menu, then come back.");
        return;
    }
    var res = plainCall(st.url, "POST", API + "/pair/start", {
        name: "T-Embed",
        model: "lilygo-t-embed-cc1101",
        app: APP_VERSION
    });
    if (!res) {
        setupFail("Can't reach " + hostOf(st.url) + ". Check the address and that Home Assistant is running.");
        return;
    }
    if (res.status === 404) {
        setupFail("Install the T-Embed Remote integration in Home Assistant first (HACS, then Settings, Devices and services, Add integration).");
        return;
    }
    if (res.status === 429) {
        setupFail("Home Assistant is busy with other pairing requests. Wait a minute and try again.");
        return;
    }
    if (res.status < 200 || res.status >= 300) {
        setupFail("Home Assistant said " + res.status + ". Try again in a moment.");
        return;
    }
    var data = jsonOf(res);
    if (!data || typeof data.code !== "string" || data.code.length !== 6) {
        setupFail("Unexpected reply from Home Assistant. Is the integration up to date?");
        return;
    }
    st.code = data.code;
    checkApi(data);
    st.pairId = asText(data.pair_id);
    st.expires = now() + (typeof data.expires_in === "number" ? data.expires_in : 300) * 1000;
    var every = typeof data.poll === "number" ? data.poll : 2;
    st.nextPoll = now() + every * 1000;
    st.step = "code";
    /* Remember the address now, so a power cut mid pairing resumes here. */
    saveConfig({ url: st.url });
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function pollPairing() {
    var st = setupState();
    if (st.step !== "code") { return; }
    if (now() >= st.expires) {
        setupFail("The code expired. Try again for a fresh one.");
        return;
    }
    var res = plainCall(st.url, "GET", API + "/pair/status?pair_id=" + st.pairId, null);
    if (!res) {
        st.nextPoll = now() + PAIR_RETRY_MS;
        return;
    }
    if (res.status !== 200) {
        st.nextPoll = now() + PAIR_RETRY_MS;
        return;
    }
    var data = jsonOf(res);
    if (!data || typeof data.status !== "string") {
        st.nextPoll = now() + PAIR_RETRY_MS;
        return;
    }
    if (data.status === "pending") {
        st.nextPoll = now() + PAIR_POLL_MS;
        return;
    }
    if (data.status === "approved" && typeof data.key === "string" && data.key.length > 0) {
        var back = { url: st.url, key: data.key };
        if (!saveConfig(back)) {
            setupFail("Approved, but the SD card would not save the key. Check the card and try again.");
            return;
        }
        app.cfg = { url: st.url, key: data.key, token: "" };
        app.setup = null;
        app.setupUrl = "";
        app.screen = "home";
        app.sel = 0;
        app.top = 0;
        app.fullRedraw = true;
        app.renderNeeded = true;
        scheduleNormalRefresh();
        app.refreshNow = true;
        return;
    }
    setupFail("The code expired or was refused. Try again for a fresh one.");
}

/* Home Assistant no longer knows this key: forget it and pair again. */
function forgetPairing() {
    var url = app.cfg ? app.cfg.url : (app.setupUrl || "");
    app.cfg = null;
    app.panelV = "";
    app.loaded = false;
    app.favourites = [];
    app.rooms = [];
    app.byId = {};
    app.screen = "home";
    app.sel = 0;
    app.top = 0;
    app.setupUrl = url;
    app.setup = null;
    if (url.length > 0) { saveConfig({ url: url }); }
    setError("");
    goSetup();
}

function goSetup() {
    var st = setupState();
    if (st.url.length > 0) {
        app.screen = "setup";
        beginPairing(st.url);
        return;
    }
    st.step = "choose";
    app.screen = "setup";
    app.sel = 0;
    app.top = 0;
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function setupItems() {
    var st = setupState();
    if (st.step !== "choose") { return [{ kind: "retry", name: "Try again" }]; }
    var items = [];
    if (st.url.length > 0) { items.push({ kind: "retry", name: "Try " + hostOf(st.url) }); }
    items.push({ kind: "guess", name: "Use homeassistant.local" });
    items.push({ kind: "type", name: "Type an address" });
    return items;
}

function setupChoose(item) {
    var st = setupState();
    if (!item) { return; }
    if (item.kind === "retry") { beginPairing(st.url); return; }
    if (item.kind === "guess") { beginPairing(GUESS_URL); return; }
    var typed = "";
    try {
        /* keyboard is an object in Bruce: the text entry lives on it. */
        typed = asText(keyboard.keyboard("Home Assistant address", 48));
    } catch (e) {
        typed = "";
    }
    typed = trimSlash(typed);
    while (typed.length > 0 && typed.charAt(0) === " ") { typed = typed.substring(1); }
    if (typed.length < 3) { return; }
    if (typed.indexOf("://") < 0) { typed = "http://" + typed; }
    var host = hostOf(typed);
    if (host.length > 0 && host.indexOf(":") < 0 && typed.indexOf("://") >= 0) {
        var afterScheme = typed.substring(typed.indexOf("://") + 3);
        if (afterScheme.indexOf("/") < 0 && afterScheme.indexOf(":") < 0) { typed += ":8123"; }
    }
    st.url = typed;
    beginPairing(typed);
}

function bodyText(body) {
    if (typeof body === "string") { return body; }
    if (body === null || typeof body === "undefined") { return ""; }
    return asText(body);
}

/* Battery percentage for the integration's battery sensor, or -1 when this
   board, this firmware or this moment gives no usable reading. */
function batteryPercent() {
    if (!deviceModule || typeof deviceModule.getBatteryCharge !== "function") { return -1; }
    var value = -1;
    try {
        value = deviceModule.getBatteryCharge();
    } catch (e) {
        return -1;
    }
    if (typeof value !== "number") { return -1; }
    if (value < 0 || value > 100) { return -1; }
    return Math.round(value);
}


function httpJson(method, path, body) {
    if (!app.cfg) { return null; }
    if (!wifi.connected()) {
        setError("No WiFi");
        scheduleBackoff();
        return null;
    }
    app.working = true;
    app.renderNeeded = true;
    render();
    var options = {
        method: method,
        headers: {
            "Authorization": "Bearer " + (app.cfg.key || app.cfg.token),
            "Content-Type": "application/json"
        }
    };
    if (paired() && method === "GET" && app.panelV) { options.headers["If-None-Match"] = app.panelV; }
    if (paired()) {
        var battery = batteryPercent();
        if (battery >= 0) { options.headers["X-TEmbed-Battery"] = asText(battery); }
    }
    if (typeof body !== "undefined" && body !== null) { options.body = JSON.stringify(body); }
    var res = null;
    try {
        res = wifi.httpFetch(app.cfg.url + path, options);
    } catch (e) {
        app.working = false;
        setError("HA offline");
        scheduleBackoff();
        app.renderNeeded = true;
        return null;
    }
    app.working = false;
    app.renderNeeded = true;
    if (!res || typeof res.status !== "number") {
        setError("HA offline");
        scheduleBackoff();
        return null;
    }
    if (res.status === 401) {
        if (paired()) {
            forgetPairing();
            return null;
        }
        setError("Token rejected");
        scheduleNormalRefresh();
        return null;
    }
    if (res.status === 403 && paired()) {
        setError("Not allowed");
        app.refreshNow = true;
        return null;
    }
    if (res.status === 304) {
        clearError();
        return res;
    }
    if (res.status < 200 || res.status >= 300) {
        setError("HA offline");
        scheduleBackoff();
        return null;
    }
    clearError();
    return res;
}

function parsePanel(payload) {
    var data = payload;
    try {
        if (typeof data === "string") { data = JSON.parse(data); }
    } catch (e) {
        return null;
    }
    if (!data || typeof data !== "object") { return null; }
    var favIn = data.f;
    var roomsIn = data.r;
    if (!favIn || typeof favIn.length !== "number") { favIn = []; }
    if (!roomsIn || typeof roomsIn.length !== "number") { roomsIn = []; }
    var favourites = [];
    var i;
    var j;
    for (i = 0; i < favIn.length; i++) {
        var row = parseRow(favIn[i]);
        if (row) { favourites.push(row); }
    }
    var rooms = [];
    for (i = 0; i < roomsIn.length; i++) {
        var area = roomsIn[i];
        if (!area || typeof area.length !== "number" || area.length < 2) { continue; }
        var name = asText(area[0]);
        var list = area[1];
        if (!list || typeof list.length !== "number") { continue; }
        var rows = [];
        for (j = 0; j < list.length; j++) {
            var entity = parseRow(list[j]);
            if (entity) { rows.push(entity); }
        }
        if (name.length > 0 && rows.length > 0) { rooms.push({ name: name, rows: rows }); }
    }
    return { favourites: favourites, rooms: rooms };
}

function parseRow(raw) {
    if (!raw || typeof raw.length !== "number" || raw.length < 2) { return null; }
    var id = asText(raw[0]);
    if (id.length < 1 || id.indexOf(".") < 1) { return null; }
    var dot = id.indexOf(".");
    var domain = id.substring(0, dot);
    var state = raw.length > 2 && raw[2] !== null && typeof raw[2] !== "undefined" ? asText(raw[2]) : "unknown";
    var extra = raw.length > 3 && typeof raw[3] === "number" ? raw[3] : null;
    var name = raw.length > 1 && raw[1] !== null && typeof raw[1] !== "undefined" ? asText(raw[1]) : id;
    return {
        kind: "entity",
        id: id,
        domain: domain,
        name: name,
        state: state,
        extra: extra
    };
}

function registerRow(row) {
    if (!app.byId[row.id]) { app.byId[row.id] = []; }
    app.byId[row.id].push(row);
}

function rebuildLists(panel) {
    app.favourites = panel.favourites;
    app.rooms = panel.rooms;
    app.byId = {};
    var i;
    var j;
    for (i = 0; i < app.favourites.length; i++) { registerRow(app.favourites[i]); }
    for (i = 0; i < app.rooms.length; i++) {
        for (j = 0; j < app.rooms[i].rows.length; j++) { registerRow(app.rooms[i].rows[j]); }
    }
}

function findRoomIndex(name) {
    if (name === FAVOURITES_TITLE) { return -1; }
    var i;
    for (i = 0; i < app.rooms.length; i++) {
        if (app.rooms[i].name === name) { return i; }
    }
    return null;
}

function currentRows() {
    if (app.roomName === FAVOURITES_TITLE) { return app.favourites; }
    if (app.roomIndex >= 0 && app.roomIndex < app.rooms.length) { return app.rooms[app.roomIndex].rows; }
    return [];
}

function selectedRow() {
    var rows = currentRows();
    if (app.sel < 0 || app.sel >= rows.length) { return null; }
    return rows[app.sel];
}

function homeItems() {
    var items = [];
    if (app.favourites.length > 0) {
        items.push({ kind: "favourites", name: FAVOURITES_TITLE, count: app.favourites.length });
    }
    var i;
    for (i = 0; i < app.rooms.length; i++) {
        items.push({ kind: "room", name: app.rooms[i].name, roomIndex: i, count: app.rooms[i].rows.length });
    }
    return items;
}

function currentItems() {
    if (app.screen === "setup") { return setupItems(); }
    if (app.screen === "home") { return homeItems(); }
    if (app.screen === "room") {
        var rows = currentRows();
        var items = [];
        var i;
        for (i = 0; i < rows.length; i++) { items.push(rows[i]); }
        return items;
    }
    return [];
}

/* ------------------------------------------------------------------ look
 *
 * Everything below draws the screen. The layout is fixed to the T-Embed's
 * 320x170 panel: a 28 px header, five 25 px rows and a 17 px hint line.
 * Frames are drawn into one full-screen sprite and pushed in one go, so the
 * screen never flickers. If the sprite cannot be made (low memory) it draws
 * straight to the display instead.
 *
 * Text uses the bitmap fonts in the generated asset block at the end of the
 * file. Each glyph has a solid layer and a soft edge layer drawn in a colour
 * halfway to the background, which smooths the edges.
 */

var PAL = {
    bg: [10, 13, 18],
    card: [28, 35, 46],
    line: [30, 38, 49],
    track: [36, 45, 58],
    text: [238, 241, 245],
    muted: [150, 160, 175],
    dim: [92, 103, 118],
    amber: [255, 186, 82],
    teal: [70, 214, 184],
    red: [240, 82, 82]
};

/* Bruce colours arrive as RGB565 (or 24-bit on some builds). */
function bruceRgb(c) {
    if (c > 0xffff) { return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; }
    return [Math.round(((c >> 11) & 31) * 255 / 31), Math.round(((c >> 5) & 63) * 255 / 63),
        Math.round((c & 31) * 255 / 31)];
}

function luma(rgb) { return rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11; }

/* Take the background from the Bruce theme and rebuild the greys around it so
   text keeps its contrast on a light or dark theme. */
function applyBruceTheme() {
    if (typeof BRUCE_BGCOLOR === "undefined") { return; }
    var bg = bruceRgb(BRUCE_BGCOLOR);
    var light = luma(bg) > 140;
    var ink = light ? [16, 18, 22] : [238, 241, 245];
    PAL.bg = bg;
    PAL.text = ink;
    PAL.card = mix(bg, ink, 0.10);
    PAL.line = mix(bg, ink, 0.12);
    PAL.track = mix(bg, ink, 0.16);
    PAL.muted = mix(bg, ink, 0.62);
    PAL.dim = mix(bg, ink, 0.40);
}

applyBruceTheme();
var ACCENT_RGB = themeAccent();
var colorCache = {};
var target = null;
/* On the T-Embed CC1101 build of Bruce, pushSprite never reaches the panel and
   the screen stays blank, so frames are drawn straight to the display. */
var USE_SPRITE = false;
var usingSprite = false;
var frameTexts = [];

function themeAccent() {
    if (typeof BRUCE_PRICOLOR === "undefined" || !BRUCE_PRICOLOR) { return PAL.teal; }
    var rgb = bruceRgb(BRUCE_PRICOLOR);
    /* A theme colour too close to the background would vanish. */
    if (Math.abs(luma(rgb) - luma(PAL.bg)) < 60) { return PAL.teal; }
    return rgb;
}

function col(rgb) {
    var key = rgb[0] + "," + rgb[1] + "," + rgb[2];
    var c = colorCache[key];
    if (typeof c === "undefined") {
        c = display.color(rgb[0], rgb[1], rgb[2]);
        colorCache[key] = c;
    }
    return c;
}

function mix(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
    ];
}

function surface() {
    if (target) { return target; }
    target = display;
    usingSprite = false;
    if (USE_SPRITE && typeof display.createSprite === "function") {
        try {
            var sp = display.createSprite(WIDTH, HEIGHT);
            if (sp && typeof sp.pushSprite === "function") {
                target = sp;
                usingSprite = true;
            }
        } catch (e) {
            target = display;
        }
    }
    return target;
}

function releaseSurface() {
    if (usingSprite && target && typeof target.deleteSprite === "function") {
        try { target.deleteSprite(); } catch (e) { }
    }
    target = null;
    usingSprite = false;
}

/* ---- base64 + bitmaps */

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_INDEX = null;

function b64bytes(str, start, count) {
    if (!B64_INDEX) {
        B64_INDEX = {};
        var k;
        for (k = 0; k < 64; k++) { B64_INDEX[B64.charAt(k)] = k; }
    }
    var out = new Uint8Array(count);
    var o = 0;
    var i = start;
    while (o < count) {
        if ((o & 63) === 0) { catchEsc(); }
        var a = B64_INDEX[str.charAt(i)];
        var b = B64_INDEX[str.charAt(i + 1)];
        var c = B64_INDEX[str.charAt(i + 2)] || 0;
        var d = B64_INDEX[str.charAt(i + 3)] || 0;
        var n = (a << 18) | (b << 12) | (c << 6) | d;
        out[o++] = (n >> 16) & 255;
        if (o < count) { out[o++] = (n >> 8) & 255; }
        if (o < count) { out[o++] = n & 255; }
        i += 4;
    }
    return out;
}

function hasBits(bytes) {
    var i;
    for (i = 0; i < bytes.length; i++) { if (bytes[i]) { return true; } }
    return false;
}

/* Decode one two-layer bitmap at byte offset `off`. Offsets are multiples of
   3, so the base64 for each entry starts on a 4 character boundary. */
function layers(data, off, w, h) {
    var size = ((w + 7) >> 3) * h;
    var all = b64bytes(data, (off / 3) * 4, size * 2);
    var solid = new Uint8Array(size);
    var soft = new Uint8Array(size);
    var k;
    for (k = 0; k < size; k++) { solid[k] = all[k]; soft[k] = all[size + k]; }
    return { w: w, h: h, solid: solid, soft: hasBits(soft) ? soft : null };
}

function blit(bm, x, y, fg, bg) {
    catchEsc();
    var t = surface();
    if (bm.soft) { t.drawXBitmap(x, y, bm.soft, bm.w, bm.h, col(mix(bg, fg, 0.5))); }
    t.drawXBitmap(x, y, bm.solid, bm.w, bm.h, col(fg));
}

/* ---- text */

var FOLD_FROM = "\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00ff\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u2018\u2019\u201c\u201d\u2013\u2014\u00a0";
var FOLD_TO = "aaaaaaceeeeiiiinoooooouuuuyyAAAAAACEEEEIIIINOOOOOOUUUUY''\"\"-- ";

function glyphIndex(font, ch) {
    var i = font.chars.indexOf(ch);
    if (i >= 0) { return i; }
    var f = FOLD_FROM.indexOf(ch);
    if (f >= 0) { return font.chars.indexOf(FOLD_TO.charAt(f)); }
    return font.chars.indexOf("?");
}

function glyph(font, i) {
    if (!font.cache) { font.cache = {}; }
    var g = font.cache[i];
    if (!g) {
        g = font.w[i] > 0 ? layers(font.data, font.o[i], font.w[i], font.h) : { w: 0 };
        font.cache[i] = g;
    }
    return g;
}

function textWidth(font, str) {
    var w = 0;
    var i;
    for (i = 0; i < str.length; i++) {
        var gi = glyphIndex(font, str.charAt(i));
        if (gi >= 0) { w += font.adv[gi]; }
    }
    return w;
}

/* Shorten to fit `maxW` pixels, ending with an ellipsis. */
function fitText(font, str, maxW) {
    if (textWidth(font, str) <= maxW) { return str; }
    var ell = "\u2026";
    var ellW = textWidth(font, ell);
    var w = 0;
    var i;
    for (i = 0; i < str.length; i++) {
        var gi = glyphIndex(font, str.charAt(i));
        var a = gi >= 0 ? font.adv[gi] : 0;
        if (w + a + ellW > maxW) { break; }
        w += a;
    }
    var cut = str.substring(0, i);
    while (cut.length > 0 && cut.charAt(cut.length - 1) === " ") { cut = cut.substring(0, cut.length - 1); }
    return cut + ell;
}

/* Draw `str` with its cap height centred on `cy`. align: 0 left, 1 centre,
   2 right, relative to x. Returns the drawn width. */
function text(font, str, x, cy, fg, bg, align) {
    frameTexts.push(str);
    var w = textWidth(font, str);
    if (align === 1) { x -= Math.round(w / 2); } else if (align === 2) { x -= w; }
    var y = cy - Math.round((font.cap + font.base) / 2);
    var i;
    for (i = 0; i < str.length; i++) {
        var gi = glyphIndex(font, str.charAt(i));
        if (gi < 0) { continue; }
        var g = glyph(font, gi);
        if (g.w > 0) { blit(g, x + font.xo[gi], y, fg, bg); }
        x += font.adv[gi];
    }
    return w;
}

function icon(name, x, y, fg, bg) {
    var spec = ICONS[name];
    if (!spec) { return; }
    if (!spec.bm) { spec.bm = layers(ICON_DATA, spec[2], spec[0], spec[1]); }
    blit(spec.bm, x, y, fg, bg);
}

/* ---- what each row says */

function isOn(row) {
    if (row.domain === "cover") { return row.state === "open" || coverMoving(row); }
    if (row.domain === "media_player") { return isPlaying(row) || row.state === "on"; }
    return row.state === "on" || row.state === "heat" || row.state === "cool" ||
        row.state === "heat_cool" || row.state === "auto" || row.state === "dry" || row.state === "fan_only";
}

function isDead(row) {
    return row.state === "unavailable" || row.state === "unknown";
}

function rowIcon(row) {
    if (row.domain === "light") { return "bulb"; }
    if (row.domain === "fan") { return "fan"; }
    if (row.domain === "scene") { return "scene"; }
    if (row.domain === "script") { return "script"; }
    if (row.domain === "climate") { return "climate"; }
    if (row.domain === "cover") { return "cover"; }
    if (row.domain === "media_player") { return "media"; }
    return "power";
}

function isPlaying(row) {
    return row.state === "playing";
}

function coverMoving(row) {
    return row.state === "opening" || row.state === "closing";
}

function rowColorRgb(row) {
    if (isDead(row)) { return PAL.red; }
    if (row.domain === "scene" || row.domain === "script") { return ACCENT_RGB; }
    if (row.domain === "climate") {
        if (row.state === "off") { return PAL.dim; }
        return ACCENT_RGB;
    }
    if (row.domain === "cover") {
        if (row.state === "open") { return ACCENT_RGB; }
        if (row.state === "closed") { return PAL.dim; }
        return ACCENT_RGB;
    }
    if (row.domain === "media_player") {
        if (row.state === "playing") { return ACCENT_RGB; }
        if (row.state === "off" || row.state === "standby") { return PAL.dim; }
        return PAL.muted;
    }
    if (row.state !== "on") { return PAL.dim; }
    return ACCENT_RGB;
}

function rowColor(row) { return col(rowColorRgb(row)); }

function formatTemp(v) {
    return (Math.round(v * 10) / 10).toFixed(1) + "\u00b0";
}

function stateLabel(row) {
    if (row.state === "unavailable") { return "Unavailable"; }
    if (row.state === "unknown") { return "Unknown"; }
    if (row.domain === "scene" || row.domain === "script") { return "Run"; }
    if (row.domain === "climate") {
        if (row.state === "off") { return "Off"; }
        return row.extra !== null ? formatTemp(row.extra) : modeName(row.state);
    }
    if (row.domain === "cover") {
        if (row.state === "open") { return row.extra !== null ? Math.round(row.extra) + "%" : "Open"; }
        if (row.state === "closed") { return "Closed"; }
        if (row.state === "opening") { return "Opening"; }
        if (row.state === "closing") { return "Closing"; }
        return stateWord(row.state);
    }
    if (row.domain === "media_player") {
        if (row.state === "playing") { return "Playing"; }
        if (row.state === "paused") { return "Paused"; }
        if (row.state === "off") { return "Off"; }
        if (row.state === "idle" || row.state === "standby") { return "Idle"; }
        return stateWord(row.state);
    }
    if (row.state === "on") {
        if (row.domain === "light" && row.extra !== null) { return Math.round(row.extra) + "%"; }
        return "On";
    }
    if (row.state === "off") { return "Off"; }
    return stateWord(row.state);
}

function stateWord(state) {
    if (typeof state !== "string" || state.length < 1) { return ""; }
    return state.charAt(0).toUpperCase() + state.substring(1);
}

function modeName(state) {
    var names = { heat: "Heating", cool: "Cooling", heat_cool: "Auto", auto: "Auto", dry: "Dry", fan_only: "Fan", off: "Off" };
    return names[state] || state;
}

function screenTitle() {
    if (app.screen === "home") { return "Home"; }
    if (app.screen === "detail" && app.detail) { return app.detail.row.name; }
    if (app.roomName.length > 0) { return app.roomName; }
    return "Home";
}

function hintText() {
    if (app.screen === "setup") {
        var st = setupState();
        if (st.step === "choose") { return "Turn to choose, click to pick"; }
        if (st.step === "code") { return "Waiting for Home Assistant\u2026"; }
        return "Click to try again";
    }
    if (app.screen === "home") { return "Turn to choose, click to open"; }
    if (app.screen === "detail" && app.detail) {
        var d = app.detail;
        if (d.kind === "climate") { return "Turn to set, click for on or off"; }
        if (d.kind === "cover") { return "Turn to set, click to open or close"; }
        if (d.kind === "media") { return "Turn for volume, click to play or pause"; }
        if (d.dimmable) { return "Turn to dim, click for on or off"; }
        return "Click for on or off";
    }
    var row = selectedRow();
    if (!row) { return ""; }
    if (row.domain === "scene" || row.domain === "script") { return "Click to run"; }
    if (row.domain === "climate") { return "Click to adjust"; }
    if (row.domain === "cover") { return coverMoving(row) ? "Click to stop" : "Click to open or close"; }
    if (row.domain === "media_player") { return "Click to play or pause"; }
    if (row.domain === "light" && row.extra !== null) { return "Click for on or off, hold to dim"; }
    return "Click for on or off";
}

function errorLine() {
    if (app.error.length === 0) { return ""; }
    if (app.error === "No WiFi") { return "No WiFi, showing last known"; }
    if (app.error === "Token rejected") { return "Token rejected by Home Assistant"; }
    if (app.error === "HA offline") { return "Can't reach Home Assistant, retrying"; }
    return app.error;
}

/* ---- pieces */

var HEADER_H = 28;
var ROW_TOP = 29;
var ROW_H = 25;
var VISIBLE_ROWS = 5;
var FOOTER_TOP = 154;

function drawHeader(title, right) {
    var t = surface();
    var bg = PAL.bg;
    var x = 10;
    if (app.screen === "home" || app.screen === "message") {
        icon("logo", x, 6, ACCENT_RGB, bg);
    } else {
        icon("back", x + 1, 9, PAL.muted, bg);
    }
    x += 22;
    var rightW = 0;
    if (right) { rightW = text(FONT_SMALL, right, WIDTH - 10, 14, PAL.muted, bg, 2) + 8; }
    if (app.working) {
        t.drawFillCircle(WIDTH - 14 - rightW, 14, 3, col(ACCENT_RGB));
        rightW += 12;
    }
    text(FONT_TITLE, fitText(FONT_TITLE, title, WIDTH - x - 12 - rightW), x, 14, PAL.text, bg, 0);
    t.drawFillRect(0, HEADER_H - 1, WIDTH, 1, col(PAL.line));
}

function drawFooter(hint) {
    var bg = PAL.bg;
    var err = errorLine();
    if (err.length > 0) {
        var t = surface();
        t.drawFillCircle(14, FOOTER_TOP + 8, 3, col(PAL.red));
        text(FONT_SMALL, fitText(FONT_SMALL, err, WIDTH - 34), 24, FOOTER_TOP + 8, PAL.red, bg, 0);
        return;
    }
    if (app.notice.length > 0) {
        surface().drawFillCircle(14, FOOTER_TOP + 8, 3, col(PAL.amber));
        text(FONT_SMALL, fitText(FONT_SMALL, app.notice, WIDTH - 34), 24, FOOTER_TOP + 8, PAL.amber, bg, 0);
        return;
    }
    if (hint) { text(FONT_SMALL, fitText(FONT_SMALL, hint, WIDTH - 20), 10, FOOTER_TOP + 8, PAL.muted, bg, 0); }
}

function drawScrollbar(total) {
    if (total <= VISIBLE_ROWS) { return; }
    var t = surface();
    var trackTop = ROW_TOP + 2;
    var trackH = ROW_H * VISIBLE_ROWS - 4;
    var thumbH = Math.max(12, Math.round(trackH * VISIBLE_ROWS / total));
    var maxTop = total - VISIBLE_ROWS;
    var thumbY = trackTop + Math.round((trackH - thumbH) * (maxTop > 0 ? app.top / maxTop : 0));
    t.drawFillRoundRect(WIDTH - 5, trackTop, 3, trackH, 1, col(PAL.line));
    t.drawFillRoundRect(WIDTH - 5, thumbY, 3, thumbH, 1, col(PAL.muted));
}

function rowFrame(slot, selected, wide) {
    var t = surface();
    var y = ROW_TOP + slot * ROW_H;
    var right = wide ? WIDTH - 6 : WIDTH - 11;
    if (selected) {
        t.drawFillRoundRect(6, y + 1, right - 6, ROW_H - 2, 6, col(PAL.card));
        t.drawFillRoundRect(6, y + 6, 3, ROW_H - 12, 1, col(ACCENT_RGB));
        return { y: y, cy: y + Math.round(ROW_H / 2), bg: PAL.card, right: right };
    }
    return { y: y, cy: y + Math.round(ROW_H / 2), bg: PAL.bg, right: right };
}

function countOn(rows) {
    var n = 0;
    var i;
    for (i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.domain !== "scene" && r.domain !== "script" && isOn(r)) { n++; }
    }
    return n;
}

function drawHomeRow(slot, item, selected, wide) {
    var f = rowFrame(slot, selected, wide);
    var rows = item.kind === "favourites" ? app.favourites : app.rooms[item.roomIndex].rows;
    var on = countOn(rows);
    icon(item.kind === "favourites" ? "star" : "room", 16, f.cy - 8, ACCENT_RGB, f.bg);
    var x = f.right - 8;
    icon("chev", x - 7, f.cy - 5, selected ? PAL.text : PAL.dim, f.bg);
    x -= 16;
    var label = on > 0 ? on + " on" : "";
    if (label) { x -= text(FONT_SMALL, label, x, f.cy, ACCENT_RGB, f.bg, 2) + 10; }
    text(FONT_BODY, fitText(FONT_BODY, item.name, x - 42), 42, f.cy, selected ? PAL.text : mix(PAL.text, PAL.bg, 0.12), f.bg, 0);
}

function drawEntityRow(slot, row, selected, wide) {
    var f = rowFrame(slot, selected, wide);
    var c = rowColorRgb(row);
    icon(rowIcon(row), 16, f.cy - 8, c, f.bg);
    var label = stateLabel(row);
    var labelRgb = row.state === "off" ? PAL.muted : c;
    if (row.domain === "scene" || row.domain === "script") { labelRgb = selected ? ACCENT_RGB : PAL.muted; }
    var lw = text(FONT_SMALL, label, f.right - 9, f.cy, labelRgb, f.bg, 2);
    var nameRgb = isDead(row) ? PAL.muted : (selected ? PAL.text : mix(PAL.text, PAL.bg, 0.12));
    text(FONT_BODY, fitText(FONT_BODY, row.name, f.right - 9 - lw - 10 - 42), 42, f.cy, nameRgb, f.bg, 0);
}

function drawList() {
    var items = currentItems();
    var wide = items.length <= VISIBLE_ROWS;
    var s;
    for (s = 0; s < VISIBLE_ROWS; s++) {
        var idx = app.top + s;
        if (idx >= items.length) { break; }
        if (app.screen === "home") { drawHomeRow(s, items[idx], idx === app.sel, wide); }
        else { drawEntityRow(s, items[idx], idx === app.sel, wide); }
    }
    drawScrollbar(items.length);
}

function drawBar(x, y, w, h, frac, fillRgb) {
    var t = surface();
    t.drawFillRoundRect(x, y, w, h, Math.floor(h / 2), col(PAL.track));
    var fw = Math.round(w * clamp(frac, 0, 1));
    if (fw >= h) { t.drawFillRoundRect(x, y, fw, h, Math.floor(h / 2), col(fillRgb)); }
    else if (fw > 0) { t.drawFillRoundRect(x, y, h, h, Math.floor(h / 2), col(fillRgb)); }
}

function drawDetail() {
    var d = app.detail;
    var row = d.row;
    var bg = PAL.bg;
    var on = isOn(row);
    var big;
    var bigRgb;
    var sub = "";
    var cy = 76;
    if (d.kind === "climate") {
        big = formatTemp(d.value);
        bigRgb = row.state === "off" ? PAL.muted : rowColorRgb(row);
        sub = row.state === "off" ? "Off" : modeName(row.state);
        text(FONT_BIG, big, WIDTH / 2, 70, bigRgb, bg, 1);
        drawBar(56, 112, WIDTH - 112, 8, (d.value - 5) / 25, row.state === "off" ? PAL.dim : bigRgb);
        text(FONT_SMALL, "5\u00b0", 48, 116, PAL.dim, bg, 2);
        text(FONT_SMALL, "30\u00b0", WIDTH - 48, 116, PAL.dim, bg, 0);
        text(FONT_SMALL, "Target \u00b7 " + sub, WIDTH / 2, 136, row.state === "off" ? PAL.muted : PAL.text, bg, 1);
        return;
    }
    if (isDead(row)) {
        text(FONT_TITLE, stateLabel(row), WIDTH / 2, cy, PAL.red, bg, 1);
        return;
    }
    if (d.kind === "cover") {
        big = Math.round(d.value) + "%";
        bigRgb = coverMoving(row) ? ACCENT_RGB : rowColorRgb(row);
        text(FONT_BIG, big, WIDTH / 2, 70, bigRgb, bg, 1);
        drawBar(56, 112, WIDTH - 112, 8, d.value / 100, bigRgb);
        text(FONT_SMALL, "Closed", 48, 116, PAL.dim, bg, 2);
        text(FONT_SMALL, "Open", WIDTH - 48, 116, PAL.dim, bg, 0);
        text(FONT_SMALL, "Position \u00b7 " + stateLabel(row), WIDTH / 2, 136, PAL.text, bg, 1);
        return;
    }
    if (d.kind === "media") {
        big = Math.round(d.value) + "%";
        bigRgb = isPlaying(row) ? ACCENT_RGB : PAL.muted;
        text(FONT_BIG, big, WIDTH / 2, 70, bigRgb, bg, 1);
        drawBar(56, 112, WIDTH - 112, 8, d.value / 100, isPlaying(row) ? ACCENT_RGB : PAL.dim);
        text(FONT_SMALL, "0", 48, 116, PAL.dim, bg, 2);
        text(FONT_SMALL, "100", WIDTH - 48, 116, PAL.dim, bg, 0);
        text(FONT_SMALL, "Volume \u00b7 " + stateLabel(row), WIDTH / 2, 136, PAL.text, bg, 1);
        return;
    }
    if (d.dimmable) {
        big = Math.round(d.value) + "%";
        bigRgb = on ? ACCENT_RGB : PAL.muted;
        text(FONT_BIG, big, WIDTH / 2, 70, bigRgb, bg, 1);
        drawBar(56, 112, WIDTH - 112, 8, d.value / 100, on ? ACCENT_RGB : PAL.dim);
        text(FONT_SMALL, "1", 48, 116, PAL.dim, bg, 2);
        text(FONT_SMALL, "100", WIDTH - 48, 116, PAL.dim, bg, 0);
        text(FONT_SMALL, on ? "On" : "Off", WIDTH / 2, 136, on ? PAL.text : PAL.muted, bg, 1);
        return;
    }
    text(FONT_BIG, on ? "On" : "Off", WIDTH / 2, cy, on ? rowColorRgb(row) : PAL.muted, bg, 1);
}

/* Break `str` into lines no wider than maxW, at spaces. */
function wrapText(font, str, maxW) {
    var words = str.split(" ");
    var lines = [];
    var cur = "";
    var i;
    for (i = 0; i < words.length; i++) {
        var next = cur.length > 0 ? cur + " " + words[i] : words[i];
        if (cur.length > 0 && textWidth(font, next) > maxW) {
            lines.push(cur);
            cur = words[i];
        } else {
            cur = next;
        }
    }
    if (cur.length > 0) { lines.push(cur); }
    return lines;
}

function drawOptionRow(slot, label, selected) {
    var t = surface();
    var y = ROW_TOP + slot * ROW_H;
    var right = WIDTH - 11;
    var bg = PAL.bg;
    if (selected) {
        t.drawFillRoundRect(6, y + 1, right - 6, ROW_H - 2, 6, col(PAL.card));
        t.drawFillRoundRect(6, y + 6, 3, ROW_H - 12, 1, col(ACCENT_RGB));
        bg = PAL.card;
    }
    var cy = y + Math.round(ROW_H / 2);
    var rgb = selected ? PAL.text : mix(PAL.text, PAL.bg, 0.12);
    text(FONT_BODY, fitText(FONT_BODY, label, right - 34), 16, cy, rgb, bg, 0);
}

function drawSetup() {
    var st = setupState();
    if (st.step === "code") {
        drawHeader("Pair", "");
        text(FONT_SMALL, "Enter this code in Home Assistant", WIDTH / 2, 66, PAL.muted, PAL.bg, 1);
        var parts = st.code.substring(0, 3) + " " + st.code.substring(3, 6);
        text(FONT_BIG, parts, WIDTH / 2, 96, ACCENT_RGB, PAL.bg, 1);
        text(FONT_SMALL, "Open T-Embed in the sidebar", WIDTH / 2, 128, PAL.text, PAL.bg, 1);
        text(FONT_SMALL, "then Remotes", WIDTH / 2, 144, PAL.text, PAL.bg, 1);
        drawFooter(hintText());
        return;
    }
    if (st.step === "starting") {
        var saved = app.screen;
        app.screen = "message";
        drawHeader("Connect", "");
        app.screen = saved;
        drawMessage("logo", "Connecting", "Asking Home Assistant for a pairing code\u2026", ACCENT_RGB);
        drawFooter("");
        return;
    }
    if (st.step === "error") {
        app.screen = "message";
        drawHeader("Connect", "");
        drawMessage("offline", "Not connected", st.error, PAL.red);
        drawFooter(hintText());
        app.screen = "setup";
        return;
    }
    drawHeader("Connect", "");
    text(FONT_SMALL, "Where is Home Assistant?", 16, 40, PAL.muted, PAL.bg, 0);
    var items = setupItems();
    var s;
    for (s = 0; s < items.length; s++) {
        if (s >= VISIBLE_ROWS) { break; }
        drawOptionRow(s, items[s].name, s === app.sel);
    }
    drawFooter(hintText());
}

/* Full screen notice used when there is nothing else to show. */
function drawMessage(iconName, title, body, tone) {
    var bg = PAL.bg;
    var lines = wrapText(FONT_SMALL, body, WIDTH - 40);
    if (lines.length > 3) { lines = lines.slice(0, 3); }
    var top = 38 + (3 - lines.length) * 7;
    icon(iconName, WIDTH / 2 - 16, top, tone, bg);
    text(FONT_TITLE, fitText(FONT_TITLE, title, WIDTH - 24), WIDTH / 2, top + 50, PAL.text, bg, 1);
    var i;
    for (i = 0; i < lines.length; i++) {
        text(FONT_SMALL, fitText(FONT_SMALL, lines[i], WIDTH - 24), WIDTH / 2, top + 72 + i * 16, PAL.muted, bg, 1);
    }
}

function emptyMessage() {
    var e = app.error;
    if (e === "No WiFi") {
        return ["wifi", "No WiFi", "Connect to WiFi from the Bruce menu, then open HA Remote again.", PAL.red];
    }
    if (e === "Token rejected") {
        return ["key", "Token not accepted", "Make a new long-lived access token in Home Assistant and put it in ha_config.json.", PAL.red];
    }
    if (e === "Not allowed") {
        return ["key", "Not allowed", "That device is not allowed to control this. Remove it in Home Assistant, then pair again.", PAL.red];
    }
    if (e === "HA offline") {
        return ["offline", "Can't reach Home Assistant", "Check it is running and the address in ha_config.json is right. Trying again shortly.", PAL.red];
    }
    if (app.working || !app.loaded) {
        return ["logo", "Connecting", "Talking to Home Assistant\u2026", ACCENT_RGB];
    }
    return ["empty", "Nothing to show yet", "Put lights in Areas in Home Assistant, or give them the T-Embed favourite label.", PAL.muted];
}

function configDir() {
    var p = app.configPath || configPath();
    var cut = p.lastIndexOf("/");
    return cut > 0 ? p.substring(0, cut + 1) : "/";
}

function render() {
    if (!app.renderNeeded && !app.fullRedraw) { return; }
    app.renderNeeded = false;
    app.fullRedraw = false;
    frameTexts = [];
    var t = surface();
    t.fill(col(PAL.bg));
    var hasData = app.favourites.length > 0 || app.rooms.length > 0;
    if (app.screen === "setup") {
        drawSetup();
    } else if (!hasData && app.screen === "home") {
        var m = emptyMessage();
        var saved = app.screen;
        app.screen = "message";
        drawHeader("HA Remote", "");
        app.screen = saved;
        drawMessage(m[0], m[1], m[2], m[3]);
        drawFooter("");
    } else if (app.screen === "detail" && app.detail) {
        drawHeader(app.detail.row.name, "");
        drawDetail();
        drawFooter(hintText());
    } else {
        var items = currentItems();
        var pos = items.length > VISIBLE_ROWS ? (app.sel + 1) + "/" + items.length : "";
        drawHeader(screenTitle(), pos);
        drawList();
        drawFooter(hintText());
    }
    if (usingSprite) { t.pushSprite(0, 0); }
}

function applyChangedStates(states) {
    if (!states || typeof states.length !== "number") { return; }
    var i;
    var j;
    for (i = 0; i < states.length; i++) {
        var state = states[i];
        if (!state || typeof state.entity_id !== "string") { continue; }
        var rows = app.byId[state.entity_id];
        if (!rows) { continue; }
        for (j = 0; j < rows.length; j++) {
            var row = rows[j];
            if (typeof state.state === "string") { row.state = state.state; }
            var attrs = state.attributes;
            if (attrs) {
                if (row.domain === "light" && typeof attrs.brightness === "number") {
                    row.extra = Math.round(attrs.brightness * 100 / 255);
                }
                if (row.domain === "climate" && typeof attrs.temperature === "number") {
                    row.extra = attrs.temperature;
                }
                if (row.domain === "cover" && typeof attrs.current_position === "number") {
                    row.extra = attrs.current_position;
                }
                if (row.domain === "media_player" && typeof attrs.volume_level === "number") {
                    row.extra = Math.round(attrs.volume_level * 100);
                }
            }
        }
    }
    app.renderNeeded = true;
}

/* The same calls, in the integration's terms. */
function toCommand(domain, service, data) {
    var cmd = { entity_id: data.entity_id, action: service };
    if (domain === "scene" || domain === "script") { cmd.action = "run"; }
    else if (service === "set_temperature") { cmd.action = "temperature"; cmd.value = data.temperature; }
    else if (domain === "light" && service === "turn_on" && typeof data.brightness_pct === "number") {
        cmd.action = "brightness";
        cmd.value = data.brightness_pct;
    }
    else if (domain === "cover") {
        if (service === "open_cover") { cmd.action = "open"; }
        else if (service === "close_cover") { cmd.action = "close"; }
        else if (service === "stop_cover") { cmd.action = "stop"; }
        else if (service === "set_cover_position") { cmd.action = "position"; cmd.value = data.position; }
    }
    else if (domain === "media_player") {
        if (service === "media_play") { cmd.action = "play_pause"; }
        else if (service === "media_pause") { cmd.action = "play_pause"; }
        else if (service === "volume_set" && typeof data.volume_level === "number") {
            cmd.action = "volume";
            cmd.value = Math.round(data.volume_level * 100);
        }
    }
    return cmd;
}

function applyRow(raw) {
    var fresh = parseRow(raw);
    if (!fresh) { return; }
    var rows = app.byId[fresh.id];
    if (!rows) { return; }
    var i;
    for (i = 0; i < rows.length; i++) {
        rows[i].state = fresh.state;
        if (fresh.extra !== null) { rows[i].extra = fresh.extra; }
    }
    app.renderNeeded = true;
}

function requestService(domain, service, data, onSuccess, onFailure) {
    var res = paired()
        ? httpJson("POST", API + "/command", toCommand(domain, service, data))
        : httpJson("POST", "/api/services/" + domain + "/" + service, data);
    if (!res) {
        if (onFailure) { onFailure(); }
        app.renderNeeded = true;
        return false;
    }
    var changed = [];
    try {
        var text = bodyText(res.body);
        if (text.length > 0) { changed = JSON.parse(text); }
    } catch (e) {
        changed = [];
    }
    if (paired()) {
        if (changed && changed.row) { applyRow(changed.row); }
    } else {
        applyChangedStates(changed);
    }
    scheduleNormalRefresh();
    app.refreshNow = true;
    if (onSuccess) { onSuccess(); }
    app.renderNeeded = true;
    return true;
}

function toggleRow(row) {
    if (!row) { return; }
    if (row.domain === "scene" || row.domain === "script") {
        requestService(row.domain, "turn_on", { entity_id: row.id }, null, null);
        return;
    }
    if (row.domain === "cover") {
        clickCover(row);
        return;
    }
    if (row.domain === "media_player") {
        clickMedia(row);
        return;
    }
    var oldState = row.state;
    var oldExtra = row.extra;
    row.state = row.state === "on" ? "off" : "on";
    app.renderNeeded = true;
    requestService(row.domain, "toggle", { entity_id: row.id }, null, function () {
        row.state = oldState;
        row.extra = oldExtra;
        app.renderNeeded = true;
    });
}

/* One click does the one thing the cover is not doing: stop it when it is
   moving, close it when it is open, open it when it is closed. */
function clickCover(row) {
    var oldState = row.state;
    var service = "open_cover";
    var newState = "open";
    if (coverMoving(row)) {
        service = "stop_cover";
        newState = oldState === "opening" ? "open" : "closed";
    } else if (row.state === "open") {
        service = "close_cover";
        newState = "closed";
    }
    row.state = newState;
    app.renderNeeded = true;
    requestService("cover", service, { entity_id: row.id }, null, function () {
        row.state = oldState;
        app.renderNeeded = true;
    });
}

function clickMedia(row) {
    var oldState = row.state;
    var service = row.state === "playing" ? "media_pause" : "media_play";
    row.state = row.state === "playing" ? "paused" : "playing";
    app.renderNeeded = true;
    requestService("media_player", service, { entity_id: row.id }, null, function () {
        row.state = oldState;
        app.renderNeeded = true;
    });
}

function detailKind(domain) {
    if (domain === "climate") { return "climate"; }
    if (domain === "cover") { return "cover"; }
    if (domain === "media_player") { return "media"; }
    return "light";
}

function hasDetail(domain) {
    return domain === "light" || domain === "climate" || domain === "cover" || domain === "media_player";
}

function openDetail(row) {
    if (!row) { return; }
    if (!hasDetail(row.domain)) { return; }
    var value = row.extra;
    if (row.domain === "light" && value === null) { value = 100; }
    if (row.domain === "climate" && value === null) { value = 20; }
    if (row.domain === "cover" && value === null) { value = row.state === "open" ? 100 : 0; }
    if (row.domain === "media_player" && value === null) { value = 30; }
    app.detail = {
        row: row,
        kind: detailKind(row.domain),
        dimmable: row.domain === "light" && row.extra !== null,
        value: value,
        lastChange: 0,
        dirty: false
    };
    app.screen = "detail";
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function detailStep(delta) {
    var d = app.detail;
    if (!d) { return; }
    if (d.kind === "climate") {
        d.value = clamp(Math.round((d.value + delta * 0.5) * 2) / 2, 5, 30);
    } else if (d.kind === "cover" || d.kind === "media") {
        d.value = clamp(Math.round(d.value + delta * 5), 0, 100);
    } else if (d.dimmable) {
        d.value = clamp(Math.round(d.value + delta * 5), 1, 100);
    } else {
        return;
    }
    d.dirty = true;
    d.lastChange = now();
    app.renderNeeded = true;
}

function detailToggle() {
    var d = app.detail;
    if (!d) { return; }
    var row = d.row;
    var oldState = row.state;
    if (d.kind === "media") {
        clickMedia(row);
        return;
    }
    if (d.kind === "cover") {
        clickCover(row);
        return;
    }
    if (d.kind === "climate") {
        var service = row.state === "off" ? "turn_on" : "turn_off";
        row.state = service === "turn_on" ? "on" : "off";
        app.renderNeeded = true;
        requestService("climate", service, { entity_id: row.id }, null, function () {
            row.state = oldState;
            app.renderNeeded = true;
        });
        return;
    }
    var oldExtra = row.extra;
    row.state = row.state === "on" ? "off" : "on";
    app.renderNeeded = true;
    requestService("light", "toggle", { entity_id: row.id }, null, function () {
        row.state = oldState;
        row.extra = oldExtra;
        app.renderNeeded = true;
    });
}

function sendDetail() {
    var d = app.detail;
    if (!d) { return; }
    var row = d.row;
    var oldState = row.state;
    var oldExtra = row.extra;
    var oldValue = d.value;
    if (d.kind === "cover") {
        row.extra = d.value;
        row.state = d.value > 0 ? "open" : "closed";
        app.renderNeeded = true;
        requestService("cover", "set_cover_position", {
            entity_id: row.id,
            position: d.value
        }, function () {
            if (d.row.extra !== null) { d.value = d.row.extra; }
        }, function () {
            row.state = oldState;
            row.extra = oldExtra;
            d.value = oldValue;
            app.renderNeeded = true;
        });
        return;
    }
    if (d.kind === "media") {
        row.extra = d.value;
        app.renderNeeded = true;
        requestService("media_player", "volume_set", {
            entity_id: row.id,
            volume_level: d.value / 100
        }, function () {
            if (d.row.extra !== null) { d.value = d.row.extra; }
        }, function () {
            row.extra = oldExtra;
            d.value = oldValue;
            app.renderNeeded = true;
        });
        return;
    }
    if (d.kind === "climate") {
        row.extra = d.value;
        app.renderNeeded = true;
        requestService("climate", "set_temperature", {
            entity_id: row.id,
            temperature: d.value
        }, function () {
            if (d.row.extra !== null) { d.value = d.row.extra; }
        }, function () {
            row.extra = oldExtra;
            d.value = oldValue;
            app.renderNeeded = true;
        });
        return;
    }
    if (!d.dimmable) { return; }
    row.state = "on";
    row.extra = d.value;
    app.renderNeeded = true;
    requestService("light", "turn_on", {
        entity_id: row.id,
        brightness_pct: d.value
    }, function () {
        if (d.row.extra !== null) { d.value = d.row.extra; }
    }, function () {
        row.state = oldState;
        row.extra = oldExtra;
        d.value = oldValue;
        app.renderNeeded = true;
    });
}

function maybeSendDetail() {
    var d = app.detail;
    if (!d || !d.dirty) { return; }
    if (now() - d.lastChange < DETAIL_IDLE_MS) { return; }
    d.dirty = false;
    sendDetail();
}

function applyPanel(panel) {
    app.loaded = true;
    var prevScreen = app.screen;
    var prevRoom = app.roomName;
    var prevDetailId = app.detail ? app.detail.row.id : "";
    var prevSelId = "";
    if (prevScreen === "room") {
        var oldRow = selectedRow();
        if (oldRow) { prevSelId = oldRow.id; }
    }
    rebuildLists(panel);
    if (prevScreen === "room") {
        var roomIndex = findRoomIndex(prevRoom);
        if (roomIndex === null && prevRoom !== FAVOURITES_TITLE && app.rooms.length > 0) { roomIndex = 0; }
        if (roomIndex === null && prevRoom !== FAVOURITES_TITLE) {
            app.screen = "home";
            app.roomName = "";
            app.roomIndex = 0;
        } else {
            app.screen = "room";
            app.roomName = roomIndex === -1 ? FAVOURITES_TITLE : app.rooms[roomIndex].name;
            app.roomIndex = roomIndex;
        }
    }
    if (prevScreen === "detail") {
        var rows = app.byId[prevDetailId];
        if (rows && rows.length > 0) {
            app.detail.row = rows[0];
            if (!app.detail.dirty && app.detail.row.extra !== null) { app.detail.value = app.detail.row.extra; }
        } else {
            app.screen = "room";
            app.detail = null;
        }
    }
    var list = currentItems();
    if (app.sel >= list.length) { app.sel = list.length - 1; }
    if (app.sel < 0) { app.sel = 0; }
    if (prevSelId.length > 0 && app.screen === "room") {
        var cur = currentRows();
        var i;
        for (i = 0; i < cur.length; i++) {
            if (cur[i].id === prevSelId) { app.sel = i; break; }
        }
    }
    if (app.sel < app.top) { app.top = app.sel; }
    if (app.sel >= app.top + VISIBLE_ROWS) { app.top = app.sel - VISIBLE_ROWS + 1; }
    if (app.top < 0) { app.top = 0; }
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function refreshPanel() {
    var res = httpJson("GET", paired() ? API + "/panel" : "/api/states/" + PANEL_ENTITY, null);
    if (!res) { return false; }
    if (res.status === 304 && app.loaded) {
        scheduleNormalRefresh();
        return true;
    }
    var panel = null;
    try {
        var outer = JSON.parse(bodyText(res.body));
        checkApi(outer);
        if (paired()) {
            panel = parsePanel(outer);
            if (panel) { app.panelV = typeof outer.v === "string" ? outer.v : ""; }
        } else {
            if (!outer || !outer.attributes) { throw new Error("panel shape"); }
            panel = parsePanel(outer.attributes.data);
        }
    } catch (e) {
        panel = null;
    }
    if (!panel) {
        setError("HA offline");
        scheduleBackoff();
        app.renderNeeded = true;
        return false;
    }
    applyPanel(panel);
    scheduleNormalRefresh();
    return true;
}

function moveSelection(delta) {
    if (app.screen === "detail") {
        detailStep(delta);
        return;
    }
    var items = currentItems();
    if (items.length < 1) { return; }
    app.sel = clamp(app.sel + delta, 0, items.length - 1);
    if (app.sel < app.top) { app.top = app.sel; }
    if (app.sel >= app.top + VISIBLE_ROWS) { app.top = app.sel - VISIBLE_ROWS + 1; }
    app.renderNeeded = true;
}

function openFavourites() {
    app.screen = "room";
    app.roomName = FAVOURITES_TITLE;
    app.roomIndex = -1;
    app.sel = 0;
    app.top = 0;
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function openRoom(index) {
    if (index < 0 || index >= app.rooms.length) { return; }
    app.screen = "room";
    app.roomName = app.rooms[index].name;
    app.roomIndex = index;
    app.sel = 0;
    app.top = 0;
    app.fullRedraw = true;
    app.renderNeeded = true;
}

function onSelect(longPress) {
    if (app.screen === "setup") {
        var st = setupState();
        if (st.step === "choose") {
            var items = setupItems();
            if (app.sel >= 0 && app.sel < items.length) { setupChoose(items[app.sel]); }
        } else if (st.step === "code") {
            if (longPress) { return; }
            setupFail("Starting again with a fresh code.");
            beginPairing(st.url);
        } else if (st.step === "error") {
            var rows = setupItems();
            if (app.sel < 0 || app.sel > rows.length - 1) { app.sel = 0; }
            setupChoose(st.url.length > 0 ? { kind: "retry" } : { kind: "guess" });
        }
        return;
    }
    if (app.screen === "home") {
        var items = homeItems();
        if (app.sel < 0 || app.sel >= items.length) { return; }
        var item = items[app.sel];
        if (item.kind === "favourites") { openFavourites(); }
        else if (item.kind === "room") { openRoom(item.roomIndex); }
        return;
    }
    if (app.screen === "room") {
        var row = selectedRow();
        if (!row) { return; }
        if (longPress) {
            if (hasDetail(row.domain)) { openDetail(row); }
            return;
        }
        if (row.domain === "climate") { openDetail(row); return; }
        toggleRow(row);
        return;
    }
    if (app.screen === "detail" && !longPress) { detailToggle(); }
}

function onBack() {
    if (app.screen === "detail") {
        app.screen = "room";
        app.detail = null;
        app.fullRedraw = true;
        app.renderNeeded = true;
        return;
    }
    if (app.screen === "room") {
        app.screen = "home";
        app.roomName = "";
        app.roomIndex = 0;
        app.sel = 0;
        app.top = 0;
        app.fullRedraw = true;
        app.renderNeeded = true;
        return;
    }
    app.exitRequested = true;
}

function pollInput() {
    /* The T-Embed reports SelPress about every 200 ms while the dial is held,
       not once on press. A short click is the absence of that signal, so wait
       out one report period before treating it as released. */
    var held = keyboard.getSelPress(true);
    if (held) {
        if (!selActive) {
            selActive = true;
            selStarted = now();
            selLongDone = false;
        }
        selLastSeen = now();
        if (!selLongDone && now() - selStarted >= HOLD_MS) {
            selLongDone = true;
            onSelect(true);
        }
    } else if (selActive && now() - selLastSeen >= SEL_RELEASE_MS) {
        selActive = false;
        if (!selLongDone) { onSelect(false); }
    }

    catchEsc();
    if (escHeld && now() - escLastSeen >= SEL_RELEASE_MS) { escHeld = false; }
    var esc = escLatched;
    escLatched = false;
    if (esc) { onBack(); }
    if (app.exitRequested) { return; }

    if (keyboard.getPrevPress(true)) { moveSelection(-1); }
    if (keyboard.getNextPress(true)) { moveSelection(1); }
}

function step() {
    if (app.exitRequested) { return false; }
    pollInput();
    if (app.exitRequested) { return false; }
    if (app.screen === "setup") {
        var st = setupState();
        if (st.step === "code" && now() >= st.nextPoll) { pollPairing(); }
    }
    if (app.cfg && (app.refreshNow || now() >= app.nextRefresh)) {
        app.refreshNow = false;
        refreshPanel();
    }
    if (app.screen === "detail") { maybeSendDetail(); }
    render();
    return true;
}

function boot() {
    app.exitRequested = false;
    app.screen = "home";
    var savedUrl = loadConfig();
    if (app.cfg) { refreshPanel(); }
    else if (typeof savedUrl === "string" && savedUrl.length > 0) { app.setupUrl = savedUrl; }
    if (!app.cfg) {
        app.nextRefresh = now() + BACKOFF_MS;
        goSetup();
    }
    app.fullRedraw = true;
    app.renderNeeded = true;
    render();
}

function run() {
    keyboard.setLongPress(true);
    /* Bruce 1.17 stops the script on any Esc press while the interpreter is
       in state 2, even mid-render, before pollInput can see it. Moving to
       state 1 turns that check off; this app handles Esc itself. */
    if (typeof runtime !== "undefined" && runtime && typeof runtime.toForeground === "function") {
        runtime.toForeground();
    }
    boot();
    while (!app.exitRequested) {
        step();
        delay(20);
    }
    keyboard.setLongPress(false);
    releaseSurface();
}

// BEGIN GENERATED ASSETS (tools/gen_assets.py; do not edit by hand)
// Text is Inter by Rasmus Andersson, SIL Open Font License 1.1.
// Icons are original drawings for this app.
var FONT_SMALL = { h: 15, base: 12, cap: 3, chars: " !\u0022#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\u005c]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00b0\u00b7\u2026",
  adv: [3,4,6,8,8,12,8,4,4,4,6,8,4,6,4,4,8,5,7,8,8,7,8,7,8,8,4,4,8,8,8,6,12,9,8,9,9,7,7,9,9,3,7,8,7,11,9,9,8,9,8,8,8,9,9,12,8,8,8,4,4,4,6,6,4,7,7,7,7,7,5,7,7,3,3,7,3,11,7,7,7,7,5,6,4,7,7,10,7,7,7,5,4,5,8,5,4,11],
  xo: [0,0,1,0,0,1,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0],
  w: [0,3,4,8,8,10,8,2,3,4,6,6,3,5,3,5,8,5,7,7,8,7,7,7,7,7,3,3,6,6,6,6,12,9,8,9,8,7,7,9,8,3,6,8,7,10,9,9,8,9,8,8,8,8,9,12,9,8,7,3,5,4,6,6,3,6,7,7,7,7,5,7,7,3,4,7,3,10,7,7,7,7,5,6,4,7,7,10,7,7,6,5,2,5,7,5,3,10],
  o: [0,0,30,60,90,120,180,210,240,270,300,330,360,390,420,450,480,510,540,570,600,630,660,690,720,750,780,810,840,870,900,930,960,1020,1080,1110,1170,1200,1230,1260,1320,1350,1380,1410,1440,1470,1530,1590,1650,1680,1740,1770,1800,1830,1860,1920,1980,2040,2070,2100,2130,2160,2190,2220,2250,2280,2310,2340,2370,2400,2430,2460,2490,2520,2550,2580,2610,2640,2700,2730,2760,2790,2820,2850,2880,2910,2940,2970,3030,3060,3090,3120,3150,3180,3210,3240,3270,3300],
  data: "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AAAAAAAaJiIiIiIiAAAAAAAAAAAkEEBAQEBAAAAAAAAAAAAcJiJiIiYcAAAAAAAAAAAgEEEBQRAgAAAAAAAAAAAaJmJCYiYaAgICAAAAAAAkUAQgBFgkAAAAAAAAAAAsJiIiIiYsICAgAAAAAABSUEFBQVBSQEBAAAAAAAAKBgICAgICAAAAAAAAAAAUAAAAAAAAAAAAAAAAAAAcEgIcMDIcAAAAAAAAAAACJAQCAAUCAAAAAAAAAAIPAgICAgYMAAAAAAAAAgQABAQEBAACAAAAAAAAAAAiIiIiIiYsAAAAAAAAAABAQEBAQFBSAAAAAAAAAAAiIjIUFBwIAAAAAAAAAABBEAQiCAAUAAAAAAAAAAAAAAAAADIBMgEyAaIBzADMAMwAAAAAAAAAAAAAAAAAAAAAAAECAQDMAFwAMgEAAAAAAAAAAAAAAAAAAAAiFhwMHBYiAAAAAAAAAAARIAAQACARAAAAAAAAAAAiIiIUFBwICAwGAAAAAABBERQiCAAUBAIAAAAAAAA+EBgIBAY+AAAAAAAAAAAAKAAECAABAAAAAAAAGAwEBAQCBAQEBBgAAAAAAAAICAAEAggICAQAAgICAgICAgICAgICAgICAQEBAQEBAQEBAQEBAQEBAAAAAgQEBAQIBAQEBAIAAAAABQIAAAgUCAAAAgUAAAAAAAAAACY5AAAAAAAAAAAAAAAAAAkEAAAAAAAAAAAADBISDgAAAAAAAAAAAAAAAgwIAAAAAAAAAAAAAAAAAAAAAAICAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAiICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEARQBAAAAAAAA" };
var FONT_BODY = { h: 18, base: 15, cap: 4, chars: " !\u0022#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\u005c]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00b0\u00b7\u2026",
  adv: [4,5,7,10,10,15,10,5,6,6,8,10,5,7,5,6,10,6,9,9,10,9,9,9,9,9,5,5,10,10,10,8,15,11,10,11,11,9,9,11,11,4,9,10,8,14,11,12,10,12,10,10,10,11,11,15,11,10,10,6,6,6,7,7,5,9,9,9,9,9,6,9,9,4,4,8,4,13,9,9,9,9,6,8,5,9,9,12,8,9,8,7,5,7,10,7,5,14],
  xo: [0,1,1,0,0,1,0,1,1,0,0,1,0,1,1,0,0,0,1,0,0,0,0,0,0,0,1,0,1,1,1,0,0,0,1,0,1,1,1,0,1,1,0,1,1,1,1,0,1,0,1,0,0,1,0,0,0,0,0,1,0,0,0,0,1,0,1,0,0,0,0,0,1,0,-1,1,1,1,1,0,1,0,1,0,0,1,0,0,0,0,0,1,1,0,1,0,1,1],
  w: [0,3,5,10,9,13,10,3,4,5,7,8,4,5,3,6,9,6,8,9,10,9,9,8,9,9,3,4,8,8,8,8,14,11,9,11,9,8,7,11,9,2,8,9,7,12,10,11,8,11,9,9,10,9,11,15,11,11,9,4,6,4,7,7,3,8,8,8,9,9,6,9,7,3,4,8,2,12,7,9,8,9,5,8,5,7,9,12,8,9,8,5,3,6,8,6,3,12],
  o: [0,0,36,72,144,216,288,360,396,432,468,504,540,576,612,648,684,756,792,828,900,972,1044,1116,1152,1224,1296,1332,1368,1404,1440,1476,1512,1584,1656,1728,1800,1872,1908,1944,2016,2088,2124,2160,2232,2268,2340,2412,2484,2520,2592,2664,2736,2808,2880,2952,3024,3096,3168,3240,3276,3312,3348,3384,3420,3456,3492,3528,3564,3636,3708,3744,3816,3852,3888,3924,3960,3996,4068,4104,4176,4212,4284,4320,4356,4392,4428,4500,4572,4608,4680,4716,4752,4788,4824,4860,4896,4932],
  data: "AAAAAAMDAgICAgIAAAMCAAAAAAAAAAAAAQEBAQEAAAABAAAAAAAAABoaGhoAAAAAAAAAAAAAAAAAAAEBAQEAAAAAAAAAAAAAAAAAAAAAAACIAIgAiAD+AcwARABEAP8BRABkACYAAAAAAAAAAAAAAAAAAAAQAEAARAAAAjIBiACIAAAAugACAEAAAAAAAAAAAAAAAAAAAAB4APwAhgEGABwAeADgAIABhgH+AHgAAAAAAAAAAAAAAAAAMACEAAIBMAAwACIAhAAQATAAMAAAAYQAMAAwAAAAAAAAAAAAAAAMAhoCEgGSAI4AQAAgBjAJEAkICwwGAAAAAAAAAAAAAAAAAAACBAUBCQAJAVAAIABACQAGCBAQBAAJAAAAAAAAAAAAAAAAAAA4AGwARABkADwAHAA2AeIBwgDmALwBAAAAAAAAAAAAAAAAAAAEABAAIgAIAAAAAACIAAQAJQEYAUACAAAAAAAAAAAAAAICAgIAAAAAAAAAAAAAAAAAAAEBAQEAAAAAAAAAAAAAAAAAAAwEBgYCAgICAgIGBAwAAAAAAAAKAAAFBQEBBQQACgAAAAAAAAIGBAQMDAwMDAwEBgIAAAAAAAQACggAAAAAAAAKAAQAAAAAAAgKPDwKCAAAAAAAAAAAAAAAABB0AgJ0EAAAAAAAAAAAAAAAAAAAABgYGP8YGBgAAAAAAAAAAAAAAAAAAABmAAAAAAAAAAAAAAAAAAAAAAAAAAAEBgICAAAAAAAAAAAAAAAAAAACAAQEAAAAAAAAAAAAAB8AAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAAAAAAAAAAAAAAAAAAMCAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAQGAgIDAQEBAYCAgIAAAAAABAIABAEAAgIAgAEAQEAAAAAAAAAAAB4AMwAhgCGAYIBggGCAYYBhgDMAHgAAAAAAAAAAAAAAAAAAAAAADAAQAEAAAQABAAEAAAAQAEwAAAAAAAAAAAAAAAAABgeGhgYGBgYGBgYAAAAAAAAAAQABQAAAAAAAAAAAAAAAAAAABwmY2BgMBgMBgZ/AAAAAAAAACJZAAEAACAQCHmAAAAAAAAAAAAAAAA4AMwAhgCAAMAAcADAAIAAggDOAHgAAAAAAAAAAAAAAAAAAABEADIAQABAACAACAAwAEABRAEwAAQAAAAAAAAAAAAAAAAAAADgAOAA8ADQAMgAzADEAMYA/gHAAMAAAAAAAAAAAAAAAAAAAAAAABAAAAAIABAAAAAKAAAAAAA+AQAAAAAAAAAAAAAAAAAAAAD8AAQABgAGAH4A5gDAAIAAwgBmADgAAAAAAAAAAAAAAAAAAAACAHoAAAAAAAAAGAAAAEAABACYAEQAAAAAAAAAAAAAAAAAAAB4AMwAhAAGAHIAzgCGAIYBhgDMAHgAAAAAAAAAAAAAAAAAAAAAADAAQgEAAAwAMABAAQAAQAEyAAQAAAAAAAAAAAAAAP7AQGAgMBAYCAwEAAAAAAAAAAE+oABQACgAFAAKAAAAAAAAAAAAAAA4AMwAhgCGAMQAeADEAIYAhgDOAHgAAAAAAAAAAAAAAAAAAABEADIAQABAACoABAA6AEABAAEwAAQAAAAAAAAAAAAAAAAAAAA4AMwAhgCCAIYBxgG8AIAAxgBsADgAAAAAAAAAAAAAAAAAAABEADIAQAAEAUAAKABAAQABAACSAEQAAAAAAAAAAAAAAAAAAAMCAAAAAAMCAAAAAAAAAAAAAAABAAAAAAABAAAAAAAAAAAAAAQEAAAAAAAEBgICAAAAAAAAAAoKAAAAAAACAAQEAAAAAAAAAEBwHAcOOGAAAAAAAAAAAAAAAKAIAgABRJDAAAAAAAAAAAAAAAAAfgAAfgAAAAAAAAAAAAAAAAAAgX4AgX4AAAAAAAAAAAAAAAIOOOBwHAYAAAAAAAAAAAAAAAUQQACAIgkDAAAAAAAAADxmQmBgGBgIAAgIAAAAAAAAAAAYJQAQIAAQABQUAAAAAAAAAAAAAADgAzgODBgEEMYzIiMSIhIiMjImF8QcDAA4AOADAAAAAAAAAAAQBMABAAACKCAE1BQkFCQUBATQKCIDAADABxAEAAAAAAAAAAAwAHAAWABYAMgAjACMAfwBBgEGAwIDAAAAAAAAAAAAAAAAAABAAAgAIACAABQAQAFAAAIA+AIAAAUAAAAAAAAAAAAAAAAAAAA/AGMAwwDDAGMAPwBjAMMAwwDDAH8AAAAAAAAAAAAAAAAAAABAAJwAAAAAAAAAQACcAAAAAAA8AAAAAAAAAAAAAAAAAAAAAADwAJwBBAMGAAIAAgACAAYABAOcAfAAAAAAAAAAAAAAAAAAAAAIAGACCgAAAwQABAAEAAADCgBgAggAAAAAAAAAAAAAAAAAAAA/AOMAgwCDAYMBgwGDAYMBgwDjAD8AAAAAAAAAAAAAAAAAAABAABwAQAEAAAAAAAAAAAAAQAEcAEAAAAAAAAAAAAAAAH8DAwMDfwMDAwN/AAAAAAAAAAB8AAAAADwAAHwAAAAAAAAAAH8DAwMDPwMDAwMDAAAAAAAAAAB8AAAAQDwAAAAAAAAAAAAAAAAAAADwAJwBBAMGAgIAAgDCAwYCBAOcAfAAAAAAAAAAAAAAAAAAAAAIAGAACgAAAQQABAAEBMAFCgBgAggBAAAAAAAAAAAAAAAAAACDAYMBgwGDAYMB/wGDAYMBgwGDAYMBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwMDAwMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQEBAQEBCQmY8AAAAAAAAAKCgoKCgoKClpRgAAAAAAAAAAAAAAADDAGMAYwAzABsAHwA3ACMAYwDDAIMAAAAAAAAAAAAAAAAAAAAAAYAAEAAIAAAAAAAIAFAAAAAAAEABAAAAAAAAAAAAAAMDAwMDAwMDAwN/AAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAAAAHBgcGDwcPBYsFmwWbBNMEcwRjBGMEAAAAAAAAAAAAAAAAAAAACAgJAAiAChQIAAhACSgIgAgQCAAIAAAAAAAAAAAAAAAAAAADAQcBDwELARsBMwEzAWMBwwHDAYMBAAAAAAAAAAAAAAAAAACEAIAAgACUAIAAiACAAIAAIAAAAAAAAAAAAAAAAAAAAAAAAADwAJwBBAMGAgICAgYCAgYCBAOcAfAAAAAAAAAAAAAAAAAAAAAIAGACCgAABQQEBAAEBAAFCgBgAggAAAAAAAAAAAAAAD9jw8PDYz8DAwMDAAAAAAAAAECcAAAAgEAMAAAAAAAAAAAAAAAAAADwAJwBBAMGAgYCAgYGBgYCxAPcAfABAAMAAAAAAAAAAAAAAAAIAGACCgAABQAEBAAAAGAFCgAgAggCAAAAAAAAAAAAAAAAAAA/AGMAwwDDAMMAYwB/ADMAYwBDAMMAAAAAAAAAAAAAAAAAAABAAJwAAAAAAAAAgAAAAAwAAACgAAAAAAAAAAAAAAAAAAAAAAB4AMwAhgEGAAwAeADAAIABhgHOAHgAAAAAAAAAAAAAAAAAAACEADIBAAAAADIAhAAgAQAAAAAwAYQAAAAAAAAAAAAAAAAAAAD+ATAAMAAwADAAMAAwADAAMAAwADAAAAAAAAAAAAAAAAAAAAABAM4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDAYMBgwGDAYMBgwGDAYMBggHGAHwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQA4AAAAAAAAAAAAAAAAAAAAAAACAwYDBgGEAYwBjADIANgAUABwADAAAAAAAAAAAAAAAAAAAAAFAAAAgAIKAAAAQAEUAAAAqAAAAEAAAAAAAAAAAAAAAAAAAACCIMIhxjFGMUQTZBMsGiwaOA44DhgMAAAAAAAAAAAAAAAAAABFUQVQAACgAiooCAhAARAEBBAAACACAAAAAAAAAAAAAAAAAAAGAYwBzABYAHAAMABwANgAjACEAQYDAAAAAAAAAAAAAAAAAACAAgIAEACgAAgAQAAIAAAAQAEKAAEAAAAAAAAAAAAAAAAAAAAGA4YBjADIAFgAcAAwADAAMAAwADAAAAAAAAAAAAAAAAAAAAABAAAAQAEUAKAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+AcAAwABgACAAMAAYAAgADAAGAP4BAAAAAAAAAAAAAAAAAAAAAD4BAAAAAFAAAAAAABQAAAD4AQAAAAAAAAAAAAAAAA4CAgICAgICAgICAg4AAAAAAAEFAQEBAQEBAQEBAQEGAAAAAAACAgIGBAQMCAgIGBAAAAAAAAMBBAQAAggABBAQAAgAAAAAAA4MCAgICAgICAgIDA4AAAAAAAACBAQEBAQEBAQEAAAOAAAAAAAcFCYiAAAAAAAAAAAAAAAAABgAKBBEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfwAAAAAAAAAAAAAAAAAAAAAAAH8AAAAAAAICAAAAAAAAAAAAAAAAAAAAAAEEAAAAAAAAAAAAAAAAAAAAAAAAADxmQHBGQmZcAAAAAAAAAAAAAEAYoIy4pZiiAAAAAAAAAAMDAztnQ0NDQ2c7AAAAAAAAAAAAAAQYoICAoBgEAAAAAAAAAAAAADhMBgICBkw4AAAAAAAAAAAAAESywAUFwLJEAAAAAAAAAAAAAACAAIAAgAC4AO4AxgCCAIIAxgDuALgAAAAAAAAAAAAAAAAAAABAAEAAQABEABAAAABFAEUAAAAQAEQAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AEQAwgD+AAIABgDMADgAAAAAAAAAAAAAAAAAAAAAAAAAAABEALoABAABAP0AQAAyAEQAAAAAAAAAAAAAABgMBB8EBAQEBAQEAAAAAAAAACQQCgAbCgoKCgoKAAAAAAAAAAAAAAAAAAAAAAC4AO4AxgCCAIIAxgDuALwAgADGAHwAAAAAAAAAAAAAAAAAAABEABAAAABFAEUAAAAQAEAAQAA4AAAAAAAAAAMDAzt3Y2NjY2NjAAAAAAAAAAAAAAQIAAAAAAAAAAAAAAAAAAYAAAYGBgYGBgYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAwMDAwMDAwMDAQGAAAAAAAAAAAAAAAAAAAAAAoBAAAAAAMDAyMzGw8PGzNjAAAAAAAAAAAAAFAIBAAQIAAAAAAAAAAAAAMDAwMDAwMDAwMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACbA3cGIwQjBCMEIwQjBCMEAAAAAAAAAAAAAAAAAAAAAAAAAAAkBIgBQAJACkAKQApACkAKAAAAAAAAAAAAAAAAADt3Y2NjY2NjAAAAAAAAAAAAAAQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AMwAxgCCAIIAxgDMADgAAAAAAAAAAAAAAAAAAAAAAAAAAABEADIAAABFAUUBAAAyAEQAAAAAAAAAAAAAAAAAADtnQ0NDQ2c7AwMDAAAAAAAAAAQYoICAoBgEAAAAAAAAAAAAAAAAAAAAAAC4AO4AxgCCAIIAxgDuALgAgACAAIAAAAAAAAAAAAAAAAAAAABEABAAAABFAEUAAAAQAEQAQABAAEAAAAAAAAAAAA8HAwMDAwMDAAAAAAAAAAAAABAIAAAAAAAAAAAAAAAAAAAAADxmBgxwQGY8AAAAAAAAAAAAAAAYADIIohhAAAAAAAAAAAAGBh8GBgYGBgQcAAAAAAAAAAAAAAAJAAAAAAoAAAAAAAAAAAAAAGNjY2NjY3duAAAAAAAAAAAAAAAAAAAAAAgQAAAAAAAAAAAAAAAAAAAAAADCAMYARgBkACwAKAA4ABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAoAAKAEAAFAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAABiDGIE5gSkBpQGnAMcAxgDAAAAAAAAAAAAAAAAAAAAAAAAAAAFAIQIEApSACgAIASAAAQAAAAAAAAAAAAAAAAAAEZkLBgYLGTCAAAAAAAAAAAAAKAKECAgEAIFAAAAAAAAAAAAAAAAAAAAAADCAMYARgBkACwAKAA4ABgAGAAIAA4AAAAAAAAAAAAAAAAAAAAFAAAAoAAKAEAAFAAAACAAAAAWAAAAAAAAAAAAAH5gMBAYDAZ+AAAAAAAAAAAAAIAeQCgAAHiAAAAAAAAAABgMBAQEBgMGBAQEBBwAAAAAAAQQAgICAAABAgICCAAAAAICAgICAgICAgICAgICAgICAgQEBAQEBAQEBAQEBAQEBAQEAAAAAAYMDAgICBAICAgIDAYAAAAAAAACAAQEFCgUBAQEAAgAAAAAAAAAAAAAjtpzAAAAAAAAAAAAAAAAAAAAQAUAAAAAAAAAAAAAABw2IjIcAAAAAAAAAAAAAAAAAAAIEAQCAAAAAAAAAAAAAAAAAAAAAAAAAwIAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjBGIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgEKAAAAAAAA" };
var FONT_TITLE = { h: 20, base: 16, cap: 4, chars: " !\u0022#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\u005c]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00b0\u00b7\u2026",
  adv: [4,5,8,10,10,16,11,5,6,6,9,11,5,7,5,6,11,7,10,10,11,10,10,9,10,10,5,5,11,11,11,9,16,12,11,12,12,10,9,12,12,4,9,11,9,15,12,12,10,12,10,10,11,12,12,16,12,11,10,6,6,6,8,8,6,9,10,9,10,9,6,10,10,4,4,9,4,14,10,10,10,10,6,9,6,10,9,13,9,9,9,7,6,7,11,7,5,15],
  xo: [0,1,1,0,0,1,0,1,1,0,1,1,0,1,1,0,0,0,1,0,0,0,0,0,0,0,1,0,1,1,1,0,0,0,1,0,1,1,1,0,1,1,0,1,1,1,1,0,1,0,1,0,0,1,0,0,0,0,0,1,0,0,0,0,1,0,1,0,0,0,0,0,1,0,-1,1,1,1,1,0,1,0,1,0,0,1,0,0,0,0,0,1,1,0,1,0,1,1],
  w: [0,3,6,11,10,14,11,3,5,5,7,9,4,6,3,6,10,6,9,10,10,9,10,9,10,10,3,4,9,9,9,8,16,12,9,12,10,8,8,12,10,3,9,10,8,13,10,12,9,12,9,10,10,10,12,16,12,11,10,5,6,5,8,8,4,9,9,9,9,9,6,9,8,4,5,8,3,13,8,10,9,9,6,9,6,8,10,14,9,10,9,6,3,7,9,7,3,13],
  o: [0,0,42,84,165,246,327,408,450,492,534,576,657,699,741,783,825,906,948,1029,1110,1191,1272,1353,1434,1515,1596,1638,1680,1761,1842,1923,1965,2046,2127,2208,2289,2370,2412,2454,2535,2616,2658,2739,2820,2862,2943,3024,3105,3186,3267,3348,3429,3510,3591,3672,3753,3834,3915,3996,4038,4080,4122,4164,4206,4248,4329,4410,4491,4572,4653,4695,4776,4818,4860,4902,4944,4986,5067,5109,5190,5271,5352,5394,5475,5517,5559,5640,5721,5802,5883,5964,6006,6048,6090,6171,6213,6255],
  data: "AAAAAAYGBgYGAgICAAAGAgAAAAAAAAAAAQEBAQEFBQUAAAEFAAAAAAAAAAAAADYyMjIyAAAAAAAAAAAAAAAAAAAAAQUFBQQAAAAAAAAAAAAAAAAAAAAAAAAAAACYAZgBiAD+A/4DjADMAP4B/wFEAEQARAAAAAAAAAAAAAAAAAAAAAAAAAAAABABAAAAAEAAAAABAgACigCiACIAAAAAAAAAAAAAAAAAACAAIAD4APwBpgEmAC4AfADwAaABIAOmAfwB+AAgAAAAAAAAAAAAAAAAABAABAACAAgCCAEQAIAACABAAoYACAICAAQAAAAAAAAAAAAAAAAAAAAAAAAMBB4GEgISAZ4BjABADGAeIBIQEhgeCAwAAAAAAAAAAAAAAAAAAAAAEgggACEBJQIAAEAAgBIAIBAhICEAIAQSAAAAAAAAAAAAAAAAAAAAAAA4AHwAzABMAHwAOAA8A2YDxgHGAf4BOAMAAAAAAAAAAAAAAAAAAAAAQACAAAIAoAAAAAQAAgCQACECAAAAAsQAAAAAAAAAAAAAAAAAAAYCAgICAAAAAAAAAAAAAAAAAAAAAQUFBQQAAAAAAAAAAAAAAAAAAAAADAwGBgYGBgICBgYGBgwMAAAAAAAAAggAAAEBBQUBAQAIAgAAAAAAAAAABgYMDAwMDAwMDAwMDAYGAAAAAAAACAIAABAQEBAQAAACCAAAAAAAAAAAAAgoPhw+KAgAAAAAAAAAAAAAAAAABAdBAgEHBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQABAAEAD+AP4AEAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAoACgAAQEBACgAKAAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBAYGAgAAAAAAAAAAAAAAAAAAAAIKAAAEAAAAAAAAAAAAAAAAAB8fAAAAAAAAAAAAAAAAAAAAAAAAICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIHAgAAAAAAAAAAAAAAAAAAAAAABQAFAAAAAAAAAAAAADAQGBgYCAwMBAQGBgIDAAAAAAAAACgAAAAUAAAKCgAABQAAAAAAAAAAAAAAAAB4APwAjAGGAQYDBgMGAwYDhgGMAfwAeAAAAAAAAAAAAAAAAAAAAAAAgAAAAUIACAKAAIAAgACAAAgCAgAAAYAAAAAAAAAAAAAAAAAAADg+NjAwMDAwMDAwMAAAAAAAAAAABAAJCwgICAgICAgIAAAAAAAAAAAAAAAAAAA8AH4AwwDDAMAAYAAwADgAHAAOAP8A/wAAAAAAAAAAAAAAAAAAAAAAAgABACQAAAAgAIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4APwAhgGAAcAAcADwAIABgAGGAfwBeAAAAAAAAAAAAAAAAAAAAAAAhAACAUgABAAAAYAAAAEAAAYCCAACAIQAAAAAAAAAAAAAAAAAAAAAAADAAOAA8ADwANgAzADMAMYA/gP+A8AAwAAAAAAAAAAAAAAAAAAAAAAAIAEAAQABCAEAARABAAEIAQAAAAAAAQABAAAAAAAAAAAAAAAAAAAAAAD8APwABgAGAHYA/gDAAYABgAGGAfwAeAAAAAAAAAAAAAAAAAAAAAAAAgECAQgAAACIAAABBAAAAAYAQAACAAQAAAAAAAAAAAAAAAAAAAAAAABwAPwBjAEGAHYA/gGOAYYBhgGOAfwAeAAAAAAAAAAAAAAAAAAAAAAAiAAAAAIAAACAAAAAAAAAAgACQAAAAYAAAAAAAAAAAAAAAAAAAAAAAAD+Af4AwADAAGAAYAAwADAAGAAYAAwADAAAAAAAAAAAAAAAAAAAAAAAAQABAQABIACAABAAQAAIACAABAAQAAIAAAAAAAAAAAAAAAAAAAAAAAB4APwAhgGGAcwB+AD8AIYBhgGGAfwBeAAAAAAAAAAAAAAAAAAAAAAAgAACAUgACAACAAQAAAEIAAACCAICAIQAAAAAAAAAAAAAAAAAAAAAAAB4APwAhgGGAYYBzgH8AZABgAGGAfwAeAAAAAAAAAAAAAAAAAAAAAAAhAACAUgAAAAAAgACAgIoAgYASAACAAQAAAAAAAAAAAAAAAAAAAAAAAIHAgAAAAIHAgAAAAAAAAAAAAAABQAFAAAABQAFAAAAAAAAAAAAAAAAAAQMDAAAAAAMBAYGAgAAAAAAAAAACAIAAAAAAAIKAAAEAAAAAAAAAAAAAAAAAAAAAACAAOAAeAAOAAcAHgB4AOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAQAIQAEQAAACEAgAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4A/gAAAAAA/gD+AAAAAAAAAAAAAAAA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AYABgAG4AfwBxgGGAYYBhgHGAfwBuAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAACAAgAAAABAAAACAACAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4APwAhgD+Af4BBgCGAPwAeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAACAEABAAABAAAASAECAAQAAAAAAAAAAAAAAAAAADgcDD8eDAwMDAwMDAAAAAAAAAAABCACACECAgICAgICAAAAAAAAAAAAAAAAAAAAAAAAAAC4AfwBxgGGAYYBhgHGAfwBuAGAAf4AeAAAAAAAAAAAAAAAAAAAAAAABAACAAgAAAABAAAACAACAAQARAAAAYQAAAAAAAAAAAMDAzt/48PDw8PDwwAAAAAAAAAAAAAAQIAEICAgICAgAAAAAAAAAAAAAAAGAAYGBgYGBgYGBgAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAwMDAwMDAwMDAwOBgAAAAAADAAAAAAAAAAAAAAAAAEBAAAAAAAAAAMDA2MzOx8fHzNj4wAAAAAAAAAAAAAAgEAAAAAgSBAAAAAAAAAAAAAAAAMDAwMDAwMDAwMDAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7B/8PYwxjDGMMYwxjDGMMYwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAIQQABAAEAAQABAAEAAQAAAAAAAAAAAAAAAAAAAAADt/48PDw8PDwwAAAAAAAAAAAAAAQIAEICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAB4APwAxgGGAYYBhgHGAfwAeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAACAAgAAAABAAAACAACAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7AH8AxwDDAMMAwwDHAH8AOwADAAMAAwAAAAAAAAAAAAAAAAAAAAAAQACAACAAAAAAAQAAIACAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC4AfwBxgGGAYYBhgHGAfwBuAGAAYABgAEAAAAAAAAAAAAAAAAAAAAABAACAAgAAAABAAAACAACAAQAAAAAAAAAAAAAAAAAAAAAABsfAwMDAwMDAwAAAAAAAAAAAAAABAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AH4ARgAOAHwAwADGAP4APAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQACAAIAAEAAAADAAAAAAAEAAAAAAAAAAAAAAAAAAAAAGBh8eBgYGBgYcHAAAAAAAAAAAAAgIAAEICAgICAIgAAAAAAAAAAAAAAAAAMPDw8PDw+P+3AAAAAAAAAAAAAAAICAgICAgBAEiAAAAAAAAAAAAAAAAAAAAAAAAAACGAYYAxgDMAEwAbAB4ADgAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQQBAAQgAAgCgABAABABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGGOYY5gymDKQNPAU8BxgHGAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIQABBAARSAFaAIAKgAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGAMwAbAA4ADgAOABsAMYAxgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEiABAARAAAAEQAAAAoAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGAYYAxgDMAGwAbAB4ADgAMAAYABwADgAAAAAAAAAAAAAAAAAAAAAAAQBAAQgAIgCAABAABABAAAgAIAACAAAAAAAAAAAAAAAAAAAAAAAAAAD+AP4AYAAwADgAGAAMAP4A/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAQAEAAAAAAAAAAAAAAAAAAAAAAAABgcDAwMDAcDBgwMDAwcGAAAAAAAICAAAAACAAQIAAAAACAgAAAAAAYGBgYGBgYGBgYGBgYGBgYGBgYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYODAgIGDgwGAgICAwOBgAAAAAACAAQFBQEAAgAFBQUEAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAABACeAPMAYgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIoAQQEIAJEAAAAAAAAAAAAAAAAAAAAAAAAAAAg8JiI+HAAAAAAAAAAAAAAAAAAAFAJQRAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgcCAAAAAAAAAAAAAAAAAAAAAAAFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCCMcYQhgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhRAgBKUAAAAAAAAAAAAA" };
var FONT_BIG = { h: 41, base: 36, cap: 2, chars: " 0123456789%.-\u00b0OfnNA/",
  adv: [12,30,19,29,29,31,28,29,26,29,29,46,15,21,21,35,18,28,35,33,17],
  xo: [0,2,2,2,2,2,2,2,1,2,2,4,3,3,2,2,0,3,3,1,0],
  w: [0,27,15,24,25,27,24,26,24,26,26,38,8,16,17,32,18,23,29,32,17],
  o: [0,0,330,495,741,1071,1401,1647,1977,2223,2553,2883,3294,3378,3543,3789,4119,4365,4611,4941,5271],
  data: "AAAAAAAAAAAA/AEAgP8HAMD/HwDg/z8A8P9/APgDfwD4Af4A/AD8APwA+AF+APgBfgD4AX4A8AF+APADPgDwAz4A8AM/APADPwDwAz8A8AM/APADPgDwAz4A8AN+APADfgDwAX4A+AF+APgB/AD4AfwA/AD4Af4A+AN/APD/fwDg/z8AwP8fAID/BwAA/AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgAAAAgAIAAAABAAAAAIAAAAAISAAAQCAAAAAQABAgAEAIAAAAAAAAACAAAIAgEACABBAAgAQQAAAEAAAABAAAAAQAAAAEAAAABBAAAAQQAIAAEACAAAAAgCAAAAAoAAAAACAAQAAAEAAQQCAAAAhIAACAAAABAAAAAgAAAAAAAIAAACAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA/wD/wP/g//D//P38/Hz8PPwc/AT8APwA/AD8APwA/AD8APwA/AD8APwA/AD8APwA/AD8APwA/AD8APwA/AD8APwA/AAAAAAAAAAAAAAAAAABAACAAAAAEAAIAAAAAACAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AwP8D4P8P+P8f+P8//IE//AB/fgB+fgB+fgB8AAB8AAB8AAB+AAB+AAA/AIA/AMAfAOAPAOAHAPAHAPgDAPwBAP4AAH8AgD8AwB8A4A8A8AcA+AMA/P///v///v///v///v//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBIAAEEAAAAAAABAAAAEJAAgAAgAAAAACAAACCfgCCAACCAAAAAAABAABAAAAAAAAAAAAQABAIAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/gAAwP8HAOD/DwDw/x8A+P8/APwBfwD8AH4AfgB8AH4A/AAAAPwAAAB8AAAAfgAAAH4AAIA/AAD+HwAA/gcAAP4DAAD+HwAA/j8AAAB/AAAA/gAAAPwAAAD4AQAA+AEAAPgBfgD4AX4A/AH+AP4A/AH/APz/fwD4/z8A8P8fAMD/BwAA/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAAAAEAAQAAgAIAAEAEAAAIIAAAIAgACAAIIAAAAAAAAAAAAAAIIAAACAAAAAAQAAQAAAAAAgAAAACAAAAAQAAAAgAAAAQAAAgIAAAAAAAAAAAAEAAAQAAAAEAD8ABAABAAQAAQAAAAAAAAECggAAAAAAAAAAQAAAACAAIAAIAIABAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwD8AAMA/AADgPwAA4D8AAPA/AAD4PwAA+D8AAPw/AAB+PgAAfj4AAD8+AAAfPgCAHz4AwA8+AMAPPgDgBz4A4AM+APADPgD4AT4A+AE+APwAPgB8AD4AfgA+AP///wP///8D////A////wP+//8DAAA/AAAAPwAAAD8AAAA/AAAAPwAAAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAQAAAAAAAAAAAAAAAEAAAAAAAAAIABAAAAAQAAAAEAgCABAAAAAQAAEAEAIAABAAAAAQAQBAEAAAABAAACAQAEAAEAAAABAIIAAQAAAAEAAAAABAAAAAQAAAAEAAAABAEAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+P8/+P8/+P8//P8//P8//AAAfAAAfAAAfAAAfAAAfAAAfPgAfP8H/v8P/v8f/v8//oA/cAB/AAB+AAB+AAD8AAD8AAD8AAD8PgD8PgB8fgB+/gB//IE//P8f+P8f8P8HwP8DAH8AAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAABAAABAAAAAAAAAAAAAAAgAAAgAAAgAAAAgAAAgAAAgQBAgAAAAAAAAAAAAAAAEFADAAAAACAAACAAAACAAAAAAAAAAAAAQAAQQCCAQAAAAAAAkJAAAAgAAAAAAAIIAAEgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AEAAP8HAMD/HwDg/z8A8P9/APgD/wD4AfwA/AD8APwA+AB8AAAAfgAAAH7wAwA+/A8APv8fAL7/PwC//38A/wP/AP8B/gD/APwAfwD4AX8A+AF+APgBfgD4AX4A+AF+APgBfgD4AfwA/AD8Af4A+AN/APD/fwDw/z8AwP8fAID/BwAA/AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgCAAAgAAAAgAAAAQAAAAAAAAAQAAAQAAgAAAQABAAAAAQIAAAAAAAAAAAgEAEECEABBACAAQQBAAEAAAAAAhAAAAAAAAAAAAAGAAAQAAAAAAAEAAAABAAAAAAAAAAAAAACAAAQAAgAAAQAAAAAEhIAACAAAAAAAAAAgAAAAQAAIAAACAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///v///v///v///v//AAB+AAB+AAA/AAA/AIAfAIAfAMAPAMAPAOAHAOAHAPADAPADAPgBAPgBAPwAAPwAAH4AAH4AAD8AAD8AgD8AgB8AwB8AwA8A4A8A4AcA8AcA8AMA+AMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABAABAAIAAAAAgAEAAAAAQACAAAAAIABAAAAAEAAgAAAACAAQAAAABAAIAAIAAAAEAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/gAAwP8HAOD/HwDw/z8A+P8/APwDfwD8AH4A/AD8AHwA/AB8APwAfAD8APwAfAD4AX4A+IM/APD/HwDA/w8AgP8HAPD/HwD4/z8A/AF/AP4A/gB+APwAfgD4AT4A+AE/APgBfwD4AX4A/AH+APwB/gH/APz/fwD4/38A8P8fAMD/DwAA/gEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAAgAEAAAAAgAAAAAAEAAAIAAAAABgAACAAIAggAAAIIAAACCAAAAAACCAAQAAQAAREAAAAAgACAAAABAAAgAAAAgAAAAQAAAgoAAAAAAAIAAAAEBAAQAQQAAAEAAAAAAAAQAAQAAAAAAAgAAggAAAACAAAQAAAAAACAAIAAAAIABAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/gAAwP8DAOD/DwD4/x8A+P8/APyBfwD+AH4AfgD8AH4A/AA+APgAPwD4AT8A+AE/APwBfgD8AX4A/gH+AP8B/IP/Afz//wH4//sB8P/5AcB/+AEAH/gBAAD4AAAA/AAAAPwAfgB8AH4AfgD8AH8A/IE/APj/HwDw/w8A4P8HAMD/AwAAfgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAAQAEAAAAAAAAAAEAAAAAAIAAAAAgQCAAAIAAQAAAEEABAEAAAQAAAAEAEAAAAABAAAAgQAAAAABAAACRAAAAAAAAAAAAAAAAAAAIIAAAIAgAAAAAAQBAAAAAH4AAAAAAIIAgAAAAAIAAAAAQgAABAAgAAgAEAAQAAgAAAAAAACBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOADAPAA+A8A+AD8HwB4AP4/ADwAPj4APgAePAAeAB48AA8AHnyADwAefIAHAB48wAMAHjzgAQA+PuABAP4/8AAA/B94AAD4D3gAAOADPAAAAAAeAAAAAB4AAAAAD/ABAIAH/AcAgAf+DwDAA/4fAOABHx8A8AEPHgDwAA8+AHgADz4AfAAPPgA8AA8+AB4ADx4AHwAPHgAPAL8fgAcA/g/ABwD8D8ADAPgDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQBAAAAQAAAAAAAAAABAAAAABAAAAAAAAAAUAAAQABQAAQAAEAAAAAAQBAAAABQAAEAAFAAAIAAAAQAAAAAAABAAAAgAAAAAAEAAAQBAAAAAAAIAAAAAABAAAAgAAIAgAACAAAAEAAAAAAIAABAAAAAiAAAAAAECAACIAAAACAgAAAAACAAAAAAoAAAAAggAAgAAAAECGAAABAAAAIAAAQAAAAAgAgAAAEBAAAAOABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4fv7+/n44AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAESAAAEAgEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/f/9//3//f/9/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAcA8B8A+D8A/H8A/H8APvgAHvAAHvAAHvAAHvAAPvgA/P8A/H8A+D8A8B8AwAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAgAAAAAAAAAAAAAAoAAQAQAIAgAAQABAQABIAgBQAQAAgAAAAAAAEAAAAAAIAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AcAAP4/AID//wDA//8B4P//B/Af+Af4B+AP+AHAH/wBgB/8AIA/fgAAP34AAD9+AAB+fgAAfj4AAH4/AAB+PwAAfj8AAH4/AAB+PgAAfn4AAH5+AAB+fgAAP34AAD/8AIA//AGAH/gBwB/4B+AP8B/4B+D//wfA//8BgP//AAD+PwAA8AcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIGAAAAUAAAAAAASAAAAIQAAAAACAECAAAEAAEAiAAAABAIAIAAACAAAAAAAAAQAEAAAEBAAABQQAAAEAAAABAAAAAQAAAAEAAAABBAAAAAQAAAQEAAAEAAABAgAAAAAIAAAAAAEAgBAIgAAAAEAAAIAQIEAAAACAAAAIAAAABAAFAAAAIGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAP8BgP8BwP8BwP8A4A8A4AcA4AcA4AcA4AcA/v8A/v8A/v8A/v8A/v8A4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcA4AcAAAAAAAAAAAAAAAAAAAAAAIQBAAAAAAAAAAAAIAABAJAAAAAAAAAAAAAAAAAAAQABAQABAQABAQABAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/gAP/4DP/8Pv/8P//8f/8Eff4A/fwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/PwA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQBAAEEgAAAQAAQAAAAACAggAAAAIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/AIAP/wCAD/8BgA//AYAP/wOAD/8DgA//B4AP/w+AD/8PgA+/H4APPz+ADz8/gA8/foAPP36ADz/8gA8//IEPP/iBDz/wgw8/8IMPP+CHDz/gjw8/wI8PP4CfDz+Anw8/AL8PPwC+Dz8A/g8/APwPPwD8Dz8A+A8/APAPPwDwDz8A4A8/AMAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAQBAAAEAQAABAEAACQBAAAEAQAARAEAAAQBAAAEAQABBAEAAAQBCAAEAQQEBAEEABQBBAgEAQQAJAEEAAQBBAAEIQQAhAEEAARBBAEEAQQABAEEAAUBBAQEAQQABgEEAAQBBAAEEQQAAAEEAAAhBAAAAQQAAAEEAACBBAAAAQQAAAEEAAIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8A8AAPgPAAD4DwAA+B8AAPwfAAD8HwAAfD8AAH4/AAB+PgAAPn4AAD9+AAA/fgAAP/wAgB/8AIAf/ACAH/gBwA/4AcAP+AHAD/AD4AfwA+AH8Afw//8H8P//B/D//w/4//8P+P//D/gBwB/8AYAf/ACAH/wAgD/+AAA/fgAAP34AAH9/AAB+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAQAAAEAAAAAAAAAAAgAAACAAAAAAAAAABBAABBAQAAAAAAAACAAIAAAgAAIAAAAAAAAUAABAAAEAAAAAAAAiAACAAACAAEEAAAAAAAAAAAAAAICAAAAAAAAAAAAAAQBAAAAAAAQAAAAQAgAgAAAAAAgACAAABAAQAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPgAAPgAAPgAAPgAAHwAAHwAAHwAAHwAAD4AAD4AAD4AAD4AAB8AAB8AAB8AAB8AgA8AgA8AgA8AwAcAwAcAwAcAwAcA4AMA4AMA4AMA4AMA8AEA8AEA8AEA8AEA+AAA+AAA+AAA+AAAfAAAfAAAfAAAPgAAPgAAPgAAAAABAAABAAAAAAQAAIAAAIAAAAAAAAIAAEAAAAAAAAAAAAEAACAAAAAAgAAAgAAAABAAAAAAQAAAAAgAAAgAAAAAIAAAAAQAAAQAAAAAEAAAAAIAAAAAAAAACAAAAAEAAAAABAAABAAAgAAAAAAAAgAAQAAAQAAAAAAA" };
var ICON_DATA = "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";
var ICONS = {
    bulb: [16, 16, 0],
    power: [16, 16, 66],
    fan: [16, 16, 132],
    scene: [16, 16, 198],
    script: [16, 16, 264],
    climate: [16, 16, 330],
    star: [16, 16, 396],
    room: [16, 16, 462],
    chev: [10, 10, 528],
    back: [10, 10, 570],
    cover: [16, 16, 612],
    media: [16, 16, 678],
    logo: [16, 16, 744],
    wifi: [32, 32, 810],
    offline: [32, 32, 1068],
    key: [32, 32, 1326],
    card: [32, 32, 1584],
    empty: [32, 32, 1842]
};
// END GENERATED ASSETS

var HA_REMOTE = {
    app: app,
    boot: boot,
    step: step,
    run: run,
    render: render,
    parsePanel: parsePanel,
    batteryPercent: batteryPercent,
    stateLabel: stateLabel,
    rowColor: rowColor,
    checkApi: checkApi,
    texts: function () { return frameTexts.slice(); },
    openDetail: openDetail,
    toggleRow: toggleRow,
    refreshPanel: refreshPanel,
    setError: setError
};

if (typeof __HA_REMOTE_MANUAL === "undefined") {
    run();
}
