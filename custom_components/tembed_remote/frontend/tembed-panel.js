/* T-Embed Remote: the sidebar page in Home Assistant.
 *
 * A plain web component with no build step. Home Assistant hands it `hass`,
 * `narrow` and `route`. Everything is saved straight away through the
 * integration's websocket commands, so there is no Save button to forget.
 */

const DOMAIN = "tembed_remote";
const POLL_MS = 3000;
const SAVE_DELAY_MS = 500;
const PREVIEW_ROWS = 5;

const DOMAIN_ICONS = {
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch",
  fan: "mdi:fan",
  scene: "mdi:palette",
  script: "mdi:script-text-play",
  climate: "mdi:thermostat",
  cover: "mdi:window-shutter",
  media_player: "mdi:speaker",
};

const DOMAIN_NAMES = {
  light: "Light",
  switch: "Switch",
  fan: "Fan",
  scene: "Scene",
  script: "Script",
  climate: "Heating",
  cover: "Blind",
  media_player: "Speaker",
};

const TABS = [
  { id: "layout", label: "Home screen", icon: "mdi:view-list" },
  { id: "remotes", label: "Remotes", icon: "mdi:remote" },
  { id: "settings", label: "Settings", icon: "mdi:cog" },
];

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ago(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function moved(list, index, delta) {
  const next = list.slice();
  const to = index + delta;
  if (to < 0 || to >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

const STYLE = `
  :host {
    display: block;
    min-height: 100vh;
    background: var(--primary-background-color);
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    --te-radius: var(--ha-card-border-radius, 12px);
    --te-card: var(--card-background-color, #fff);
    --te-line: var(--divider-color, rgba(0,0,0,.12));
    --te-muted: var(--secondary-text-color, #727272);
    --te-accent: var(--primary-color, #03a9f4);
    --te-danger: var(--error-color, #db4437);
    --te-ok: var(--success-color, #43a047);
  }
  * { box-sizing: border-box; }
  .toolbar {
    display: flex; align-items: center; gap: 4px;
    height: var(--header-height, 56px); padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, #fff);
    border-bottom: var(--app-header-border-bottom, none);
    position: sticky; top: 0; z-index: 2;
  }
  .toolbar .title { font-size: 20px; font-weight: 400; margin-left: 8px; flex: 1; }
  .tabs {
    display: flex; gap: 4px; padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, #fff);
    position: sticky; top: var(--header-height, 56px); z-index: 2;
  }
  .tab {
    appearance: none; border: 0; background: none; color: inherit; cursor: pointer;
    font: inherit; font-size: 14px; font-weight: 500; letter-spacing: .02em;
    padding: 12px 16px; opacity: .72; border-bottom: 2px solid transparent;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .tab ha-icon { --mdc-icon-size: 20px; }
  .tab[aria-selected="true"] { opacity: 1; border-bottom-color: currentColor; }
  .tab .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--warning-color, #ffa600);
    box-shadow: 0 0 0 3px rgba(255,166,0,.25);
  }
  main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 96px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
  .narrow .grid { grid-template-columns: minmax(0, 1fr); }
  .stack { display: grid; gap: 24px; }
  .card {
    background: var(--te-card); border-radius: var(--te-radius);
    box-shadow: var(--ha-card-box-shadow, 0 2px 2px rgba(0,0,0,.14), 0 1px 5px rgba(0,0,0,.12));
    border: var(--ha-card-border-width, 0) solid var(--ha-card-border-color, var(--te-line));
    overflow: hidden;
  }
  .card-head { padding: 18px 20px 4px; display: flex; align-items: flex-start; gap: 12px; }
  .card-head h2 { margin: 0; font-size: 18px; font-weight: 500; }
  .card-head p { margin: 4px 0 0; color: var(--te-muted); font-size: 14px; line-height: 1.45; }
  .card-head .grow { flex: 1; min-width: 0; }
  .card-body { padding: 8px 8px 12px; }
  .card-foot { padding: 4px 16px 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .empty {
    margin: 8px 12px 4px; padding: 20px; border: 1px dashed var(--te-line); border-radius: 10px;
    color: var(--te-muted); font-size: 14px; text-align: center; line-height: 1.5;
  }
  .row {
    display: flex; align-items: center; gap: 12px; min-height: 52px;
    padding: 6px 8px 6px 12px; border-radius: 10px;
  }
  .row + .row { margin-top: 2px; }
  .row:hover { background: rgba(127,127,127,.06); }
  .row .icon {
    width: 36px; height: 36px; border-radius: 50%; flex: none;
    display: grid; place-items: center;
    background: rgba(var(--rgb-primary-color, 3,169,244), .12); color: var(--te-accent);
  }
  .row .icon.group { border-radius: 10px; }
  .row .icon.off { background: rgba(127,127,127,.12); color: var(--te-muted); }
  .row .text { flex: 1; min-width: 0; }
  .row .name { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .sub { font-size: 13px; color: var(--te-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row.hidden .name, .row.hidden .icon { opacity: .45; }
  .row.hidden .name { text-decoration: line-through; text-decoration-color: var(--te-muted); }
  .row.click { cursor: pointer; }
  .chev { color: var(--te-muted); transition: transform .15s; }
  .chev.open { transform: rotate(90deg); }
  .children { margin: 0 0 6px 48px; border-left: 2px solid var(--te-line); padding-left: 6px; }
  .children .row { min-height: 44px; }
  .children .row .icon { width: 30px; height: 30px; --mdc-icon-size: 18px; }
  .actions { display: flex; align-items: center; gap: 0; flex: none; }
  .ibtn {
    appearance: none; border: 0; background: none; cursor: pointer; color: var(--te-muted);
    width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    --mdc-icon-size: 22px;
  }
  .ibtn:hover { background: rgba(127,127,127,.12); color: var(--primary-text-color); }
  .ibtn:disabled { opacity: .25; cursor: default; background: none; }
  .ibtn.danger:hover { color: var(--te-danger); }
  .btn {
    appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 14px; font-weight: 500;
    letter-spacing: .03em; border-radius: 20px; padding: 0 18px; height: 40px;
    display: inline-flex; align-items: center; gap: 8px; --mdc-icon-size: 20px;
    background: rgba(var(--rgb-primary-color, 3,169,244), .12); color: var(--te-accent);
  }
  .btn:hover { background: rgba(var(--rgb-primary-color, 3,169,244), .2); }
  .btn.primary { background: var(--te-accent); color: var(--text-primary-color, #fff); }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.plain { background: none; }
  .btn.plain:hover { background: rgba(127,127,127,.1); }
  .btn.danger { background: none; color: var(--te-danger); }
  .btn.danger:hover { background: rgba(219,68,55,.1); }
  .btn:disabled { opacity: .5; cursor: default; }
  .note { font-size: 13px; color: var(--te-muted); line-height: 1.5; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500;
    padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,.12); color: var(--te-muted);
  }
  .pill.ok { background: rgba(67,160,71,.14); color: var(--te-ok); }

  /* Device preview */
  .preview-wrap { position: sticky; top: calc(var(--header-height, 56px) + 72px); }
  .narrow .preview-wrap { position: static; }
  .device {
    margin: 12px 20px 8px; padding: 14px; border-radius: 26px;
    background: linear-gradient(160deg, #3a3f47, #1c1f24 60%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 10px 24px rgba(0,0,0,.25);
  }
  .screen {
    aspect-ratio: 320 / 170; border-radius: 6px; overflow: hidden;
    background: #0a0d12; color: #eef1f5; display: flex; flex-direction: column;
    font-family: Inter, system-ui, sans-serif; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
  }
  .screen .bar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5% 5% 2%; font-size: 13px; font-weight: 600;
  }
  .screen .bar span:last-child { color: #969fb0; font-weight: 500; font-size: 11px; }
  .screen .rule { height: 1px; margin: 0 5%; background: #1e2631; }
  .screen ul { list-style: none; margin: 1% 0 0; padding: 0 3%; flex: 1; }
  .screen li {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; padding: 1.6% 3%; border-radius: 4px; white-space: nowrap;
  }
  .screen li .n { overflow: hidden; text-overflow: ellipsis; }
  .screen li .c { color: #8892a0; font-size: 11px; margin-left: 8px; }
  .screen li.sel { background: var(--te-accent); color: #0a0d12; font-weight: 600; }
  .screen li.sel .c { color: inherit; opacity: .7; }
  .screen .more { text-align: center; color: #5c6776; font-size: 10px; padding-bottom: 2%; }
  .dial { display: flex; justify-content: center; margin-top: 12px; }
  .dial span {
    width: 44px; height: 44px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #5a616b, #23272d 70%);
    box-shadow: 0 2px 6px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.15);
  }

  /* Pairing */
  .pair { padding: 24px 20px; text-align: center; }
  .pair h2 { margin: 0 0 6px; font-size: 22px; font-weight: 500; }
  .pair p { margin: 0 auto; max-width: 460px; color: var(--te-muted); line-height: 1.5; }
  .code {
    display: block; margin: 20px auto 8px; width: min(100%, 300px);
    font: 500 34px/1 ui-monospace, "Roboto Mono", monospace; letter-spacing: .32em; text-align: center;
    padding: 14px 0 14px .32em; border-radius: 12px; outline: none;
    border: 2px solid var(--te-line); background: var(--primary-background-color);
    color: var(--primary-text-color);
  }
  .code:focus { border-color: var(--te-accent); }
  .code.bad { border-color: var(--te-danger); animation: shake .3s; }
  @keyframes shake { 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
  .msg { min-height: 22px; font-size: 14px; margin: 4px 0 12px; }
  .msg.bad { color: var(--te-danger); }
  .msg.ok { color: var(--te-ok); }
  .waiting {
    display: inline-flex; align-items: center; gap: 10px; color: var(--te-muted); font-size: 14px;
    margin-top: 18px; padding: 8px 14px; border-radius: 20px; background: rgba(127,127,127,.08);
  }
  .pulse {
    width: 10px; height: 10px; border-radius: 50%; background: var(--te-accent);
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(var(--rgb-primary-color, 3,169,244), .5); }
    70% { box-shadow: 0 0 0 10px rgba(var(--rgb-primary-color, 3,169,244), 0); }
    100% { box-shadow: 0 0 0 0 rgba(var(--rgb-primary-color, 3,169,244), 0); } }
  .steps { list-style: none; margin: 22px auto 0; padding: 0; max-width: 520px; text-align: left; counter-reset: s; }
  .steps li { counter-increment: s; display: flex; gap: 14px; padding: 10px 0; line-height: 1.5; font-size: 14px; }
  .steps li::before {
    content: counter(s); flex: none; width: 26px; height: 26px; border-radius: 50%;
    display: grid; place-items: center; font-weight: 600; font-size: 13px;
    background: rgba(var(--rgb-primary-color, 3,169,244), .14); color: var(--te-accent);
  }
  .steps code {
    font-family: ui-monospace, monospace; font-size: 13px; padding: 1px 6px; border-radius: 6px;
    background: rgba(127,127,127,.12);
  }
  .banner {
    display: flex; align-items: center; gap: 14px; padding: 14px 16px; margin-bottom: 24px;
    border-radius: var(--te-radius); background: rgba(255,166,0,.12);
    border: 1px solid rgba(255,166,0,.35); cursor: pointer;
  }
  .banner .text { flex: 1; font-size: 15px; }
  .banner ha-icon { color: var(--warning-color, #ffa600); }
  .device-card { display: flex; gap: 16px; padding: 16px 16px 16px 20px; align-items: center; }
  .device-card + .device-card { border-top: 1px solid var(--te-line); }
  .device-card .grow { flex: 1; min-width: 0; }
  .device-card .title { font-size: 16px; font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .device-card .meta { color: var(--te-muted); font-size: 13px; margin-top: 4px; line-height: 1.6; }
  .devimg {
    width: 52px; height: 52px; border-radius: 14px; flex: none; display: grid; place-items: center;
    background: linear-gradient(160deg, #3a3f47, #1c1f24); color: #cfd6df; --mdc-icon-size: 26px;
  }

  /* Settings */
  .setting { display: flex; gap: 16px; align-items: center; padding: 14px 20px; }
  .setting + .setting { border-top: 1px solid var(--te-line); }
  .setting .grow { flex: 1; }
  .setting .label { font-size: 15px; }
  .switch { position: relative; width: 40px; height: 22px; flex: none; }
  .switch input { opacity: 0; width: 100%; height: 100%; margin: 0; position: absolute; cursor: pointer; z-index: 1; }
  .switch span {
    position: absolute; inset: 0; border-radius: 11px; background: rgba(127,127,127,.4); transition: .15s;
  }
  .switch span::after {
    content: ""; position: absolute; width: 18px; height: 18px; left: 2px; top: 2px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: .15s;
  }
  .switch input:checked + span { background: var(--te-accent); }
  .switch input:checked + span::after { transform: translateX(18px); }

  /* Dialog */
  .scrim {
    position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.45);
    display: grid; place-items: center; padding: 16px; animation: fade .12s;
  }
  @keyframes fade { from { opacity: 0; } }
  .dialog {
    width: min(560px, 100%); max-height: min(720px, calc(100vh - 32px));
    display: flex; flex-direction: column;
    background: var(--te-card); border-radius: 20px; box-shadow: 0 12px 40px rgba(0,0,0,.35);
  }
  .narrow .scrim { padding: 0; place-items: end stretch; }
  .narrow .dialog { width: 100%; max-height: 92vh; border-radius: 20px 20px 0 0; }
  .dialog h2 { margin: 0; padding: 22px 24px 4px; font-size: 20px; font-weight: 500; }
  .dialog .hint { padding: 0 24px; color: var(--te-muted); font-size: 14px; }
  .field {
    display: block; width: calc(100% - 48px); margin: 14px 24px 0; height: 48px; padding: 0 16px;
    font: inherit; font-size: 15px; border-radius: 10px; outline: none;
    border: 1px solid var(--te-line); background: var(--primary-background-color);
    color: var(--primary-text-color);
  }
  .field:focus { border-color: var(--te-accent); box-shadow: 0 0 0 1px var(--te-accent); }
  .filters { display: flex; gap: 6px; padding: 12px 24px 4px; flex-wrap: wrap; }
  .chip {
    appearance: none; border: 1px solid var(--te-line); background: none; color: var(--primary-text-color);
    font: inherit; font-size: 13px; border-radius: 16px; padding: 5px 12px; cursor: pointer;
  }
  .chip[aria-pressed="true"] { background: rgba(var(--rgb-primary-color, 3,169,244), .14); border-color: transparent; color: var(--te-accent); font-weight: 500; }
  .picklist { overflow: auto; padding: 8px 12px; flex: 1; min-height: 160px; }
  .picklist .area { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--te-muted); padding: 14px 12px 4px; }
  .pick { cursor: pointer; }
  .pick .check {
    width: 22px; height: 22px; border-radius: 6px; border: 2px solid var(--te-muted); flex: none;
    display: grid; place-items: center; color: transparent; --mdc-icon-size: 18px;
  }
  .pick.on .check { background: var(--te-accent); border-color: var(--te-accent); color: var(--text-primary-color, #fff); }
  .dialog .foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 12px 20px 18px; border-top: 1px solid var(--te-line); }
  .dialog .foot .count { flex: 1; color: var(--te-muted); font-size: 14px; padding-left: 4px; }

  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 20;
    background: var(--primary-text-color); color: var(--primary-background-color);
    padding: 10px 18px; border-radius: 8px; font-size: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    animation: fade .15s;
  }
  .loading { padding: 80px 16px; text-align: center; color: var(--te-muted); }
`;

class TEmbedRemotePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = null;
    this._data = null;
    this._error = null;
    this._open = new Set();
    this._dialog = null;
    this._pairMsg = null;
    this._pairBusy = false;
    this._toast = null;
    this._saveTimer = null;
    this._pollTimer = null;
    this._statusSig = "";
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("input", (ev) => this._onInput(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("keydown", (ev) => this._onKey(ev));
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = hass;
    if (first) this._load();
  }

  get hass() { return this._hass; }

  set narrow(value) {
    this._narrow = value;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.narrow = value;
    const root = this.shadowRoot.querySelector(".root");
    if (root) root.classList.toggle("narrow", !!value || window.innerWidth < 870);
  }

  set route(route) {
    this._route = route;
    const path = (route && route.path) || "";
    const want = path.replace(/^\//, "").split("/")[0];
    if (TABS.some((t) => t.id === want) && want !== this._tab) {
      this._tab = want;
      if (this._data) this._render();
    }
  }

  connectedCallback() {
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._onResize = () => this.narrow = this._narrow;
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    clearInterval(this._pollTimer);
    window.removeEventListener("resize", this._onResize);
    this._flushSave();
  }

  /* ---- data */

  _ws(type, extra) {
    return this._hass.callWS({ type: `${DOMAIN}/${type}`, ...(extra || {}) });
  }

  async _load() {
    try {
      this._data = await this._ws("config");
      this._error = null;
      if (!this._tab) this._tab = this._data.devices.length ? "layout" : "remotes";
      this._statusSig = this._sig(this._data);
    } catch (err) {
      this._error = (err && err.message) || "Could not load T-Embed Remote.";
    }
    this._render();
  }

  _sig(status) {
    return JSON.stringify([
      status.pending,
      status.devices.map((d) => [d.id, d.name, d.battery, d.app, ago(d.last_seen_at)]),
    ]);
  }

  async _poll() {
    if (!this._hass || !this._data || document.hidden) return;
    try {
      const status = await this._ws("status");
      const sig = this._sig(status);
      if (sig === this._statusSig) return;
      const hadPending = this._data.pending.length;
      this._statusSig = sig;
      this._data.devices = status.devices;
      this._data.pending = status.pending;
      if (!hadPending && status.pending.length && this._tab !== "remotes" && !this._dialog) {
        this._showToast("A T-Embed is waiting to pair");
      }
      if (!status.pending.length) this._pairMsg = null;
      this._render();
    } catch (err) {
      /* Home Assistant restarting; the next poll will catch up. */
    }
  }

  get _layout() { return this._data.layout; }

  _entity(id) {
    return this._data.entities.find((e) => e.entity_id === id);
  }

  _areaName(id) {
    const area = this._data.areas.find((a) => a.id === id);
    return area ? area.name : "";
  }

  _change(patch) {
    Object.assign(this._layout, patch);
    this._pending = { ...(this._pending || {}), ...patch };
    this._render();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DELAY_MS);
  }

  async _flushSave() {
    clearTimeout(this._saveTimer);
    const patch = this._pending;
    if (!patch || !this._hass) return;
    this._pending = null;
    const body = {};
    for (const key of ["favourites", "groups", "room_order", "hidden_areas", "hidden_entities"]) {
      if (key in patch) body[key] = patch[key];
    }
    try {
      const result = await this._ws("save_layout", body);
      if (!this._pending) {
        this._data.layout = result.layout;
        this._data.preview = result.preview;
        this._render();
      }
      this._showToast("Saved. Remotes update within 30 seconds.");
    } catch (err) {
      this._showToast(`Not saved: ${(err && err.message) || "unknown error"}`);
      this._load();
    }
  }

  _showToast(text) {
    this._toast = text;
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = null; this._render(); }, 2600);
  }

  /* ---- sections: areas and groups in one ordered list */

  _sections() {
    const layout = this._layout;
    const byArea = {};
    for (const e of this._data.entities) {
      if (e.area_id) (byArea[e.area_id] = byArea[e.area_id] || []).push(e);
    }
    const all = {};
    for (const area of this._data.areas) {
      const members = byArea[area.id] || [];
      if (!members.length) continue;
      all[`a:${area.id}`] = { key: `a:${area.id}`, kind: "area", area, members };
    }
    for (const group of layout.groups) {
      all[`g:${group.id}`] = { key: `g:${group.id}`, kind: "group", group };
    }
    const ordered = [];
    for (const key of layout.room_order) {
      if (all[key]) { ordered.push(all[key]); delete all[key]; }
    }
    return ordered.concat(Object.values(all));
  }

  _sectionVisible(section) {
    const layout = this._layout;
    if (section.kind === "area") {
      if (layout.hidden_areas.includes(section.area.id)) return 0;
      return section.members.filter((e) => !layout.hidden_entities.includes(e.entity_id)).length;
    }
    return section.group.entities.filter(
      (id) => this._entity(id) && !layout.hidden_entities.includes(id)
    ).length;
  }

  /* ---- events */

  _onClick(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el) {
      if (ev.target.classList && ev.target.classList.contains("scrim")) this._closeDialog();
      return;
    }
    const action = el.dataset.action;
    const arg = el.dataset.arg;
    const index = Number(el.dataset.index);
    const layout = this._data && this._layout;

    switch (action) {
      case "tab":
        this._tab = arg;
        history.replaceState(null, "", `/t-embed/${arg}`);
        this._render();
        break;
      case "fav-up": this._change({ favourites: moved(layout.favourites, index, -1) }); break;
      case "fav-down": this._change({ favourites: moved(layout.favourites, index, 1) }); break;
      case "fav-remove":
        this._change({ favourites: layout.favourites.filter((id) => id !== arg) });
        break;
      case "fav-add":
        this._openPicker({
          title: "Choose favourites",
          hint: "Favourites sit at the top of the remote's home screen.",
          selected: layout.favourites,
          done: (ids) => this._change({ favourites: ids }),
        });
        break;
      case "sec-up":
      case "sec-down": {
        const keys = this._sections().map((s) => s.key);
        this._change({ room_order: moved(keys, index, action === "sec-up" ? -1 : 1) });
        break;
      }
      case "toggle-open":
        if (this._open.has(arg)) this._open.delete(arg); else this._open.add(arg);
        this._render();
        break;
      case "area-hide": {
        const hidden = layout.hidden_areas.includes(arg)
          ? layout.hidden_areas.filter((id) => id !== arg)
          : layout.hidden_areas.concat([arg]);
        this._change({ hidden_areas: hidden });
        break;
      }
      case "entity-hide": {
        const hidden = layout.hidden_entities.includes(arg)
          ? layout.hidden_entities.filter((id) => id !== arg)
          : layout.hidden_entities.concat([arg]);
        this._change({ hidden_entities: hidden });
        break;
      }
      case "group-new": this._openGroup(null); break;
      case "group-edit": this._openGroup(layout.groups.find((g) => g.id === arg)); break;
      case "group-delete": {
        const group = layout.groups.find((g) => g.id === arg);
        this._dialog = {
          kind: "confirm",
          title: `Delete “${group.name}”?`,
          text: "The group goes from the remote. The lights and switches in it are not touched.",
          okLabel: "Delete",
          ok: () => this._change({ groups: layout.groups.filter((g) => g.id !== arg) }),
        };
        this._render();
        break;
      }
      case "pick": this._togglePick(arg); break;
      case "filter":
        this._dialog.filter = arg;
        this._renderPickList();
        break;
      case "dialog-cancel": this._closeDialog(); break;
      case "dialog-ok": this._dialogOk(); break;
      case "pair": this._pair(); break;
      case "goto-remotes":
        this._tab = "remotes";
        history.replaceState(null, "", "/t-embed/remotes");
        this._render();
        break;
      case "device-rename": {
        const device = this._data.devices.find((d) => d.id === arg);
        this._dialog = { kind: "rename", title: "Rename remote", deviceId: arg, value: device.name };
        this._render();
        this._focus(".field");
        break;
      }
      case "device-remove": {
        const device = this._data.devices.find((d) => d.id === arg);
        this._dialog = {
          kind: "confirm",
          title: `Remove “${device.name}”?`,
          text: "It stops working straight away. To use it again, open HA Remote on it and pair with a new code.",
          okLabel: "Remove",
          ok: async () => {
            const result = await this._ws("remove_device", { device_id: arg });
            this._data.devices = result.devices;
            this._data.pending = result.pending;
            this._showToast("Remote removed");
          },
        };
        this._render();
        break;
      }
      case "use-label":
        this._dialog = {
          kind: "confirm",
          title: "Go back to the favourites label?",
          text: "Your list here is cleared, and anything tagged with the favourites label shows instead.",
          okLabel: "Use label",
          ok: async () => {
            await this._ws("save_layout", { favourites: null });
            await this._load();
          },
        };
        this._render();
        break;
      default:
        break;
    }
  }

  _onInput(ev) {
    const t = ev.target;
    if (t.classList.contains("search")) {
      this._dialog.query = t.value;
      this._renderPickList();
    } else if (t.classList.contains("field") && this._dialog) {
      this._dialog.value = t.value;
    } else if (t.classList.contains("code")) {
      const digits = t.value.replace(/\D/g, "").slice(0, 6);
      if (t.value !== digits) t.value = digits;
      t.classList.remove("bad");
      this._code = digits;
      if (digits.length === 6) this._pair();
    }
  }

  async _onChange(ev) {
    const t = ev.target;
    if (t.name === "allow_remote") {
      try {
        await this._ws("save_settings", { allow_remote: t.checked });
        this._data.settings.allow_remote = t.checked;
        this._showToast("Saved");
      } catch (err) {
        t.checked = !t.checked;
        this._showToast("Not saved");
      }
    }
  }

  _onKey(ev) {
    if (ev.key === "Escape" && this._dialog) { this._closeDialog(); return; }
    if (ev.key === "Enter" && ev.target.classList.contains("field")) this._dialogOk();
    if (ev.key === "Enter" && ev.target.classList.contains("code")) this._pair();
  }

  /* ---- dialogs */

  _openPicker({ title, hint, selected, done, name }) {
    this._dialog = {
      kind: "picker",
      title,
      hint,
      selected: selected.slice(),
      done,
      name,
      value: name || "",
      query: "",
      filter: "all",
    };
    this._render();
    this._focus(name !== undefined ? ".field" : ".search");
  }

  _openGroup(group) {
    const layout = this._layout;
    this._openPicker({
      title: group ? "Edit group" : "New group",
      hint: "A group shows on the remote like a room. Use it for things like “Downstairs” or “Bedtime”.",
      selected: group ? group.entities : [],
      name: group ? group.name : "",
      done: (ids, name) => {
        const clean = { id: group ? group.id : "", name, entities: ids };
        const groups = group
          ? layout.groups.map((g) => (g.id === group.id ? clean : g))
          : layout.groups.concat([clean]);
        this._change({ groups });
      },
    });
  }

  _togglePick(id) {
    const d = this._dialog;
    d.selected = d.selected.includes(id) ? d.selected.filter((x) => x !== id) : d.selected.concat([id]);
    this._renderPickList();
  }

  _dialogOk() {
    const d = this._dialog;
    if (!d) return;
    if (d.kind === "picker") {
      if (d.name !== undefined) {
        const name = (d.value || "").trim();
        if (!name) {
          const field = this.shadowRoot.querySelector(".field");
          if (field) { field.focus(); field.placeholder = "Give the group a name first"; }
          return;
        }
        this._dialog = null;
        d.done(d.selected, name);
      } else {
        this._dialog = null;
        d.done(d.selected);
      }
    } else if (d.kind === "confirm") {
      this._dialog = null;
      Promise.resolve(d.ok()).then(() => this._render());
    } else if (d.kind === "rename") {
      const name = (d.value || "").trim();
      if (!name) return;
      this._dialog = null;
      this._ws("rename_device", { device_id: d.deviceId, name }).then((result) => {
        this._data.devices = result.devices;
        this._render();
      });
    }
    this._render();
  }

  _closeDialog() {
    this._dialog = null;
    this._render();
  }

  _focus(selector) {
    requestAnimationFrame(() => {
      const el = this.shadowRoot.querySelector(selector);
      if (el) { el.focus(); if (el.select) el.select(); }
    });
  }

  /* ---- pairing */

  async _pair() {
    const code = (this._code || "").replace(/\D/g, "");
    if (this._pairBusy) return;
    if (code.length !== 6) {
      this._pairMsg = { bad: true, text: "The code has 6 digits." };
      this._render();
      return;
    }
    this._pairBusy = true;
    try {
      const result = await this._ws("pair", { code });
      this._data.devices = result.devices;
      this._data.pending = result.pending;
      const messages = {
        approved: { bad: false, text: "Paired. Your remote loads its rooms in a couple of seconds." },
        wrong: { bad: true, text: "That code isn’t right. Check the T-Embed screen and try again." },
        expired: { bad: true, text: "That code has expired. The remote shows a new one; enter that instead." },
        none: { bad: true, text: "No remote is waiting. Open HA Remote on the T-Embed first." },
      };
      this._pairMsg = messages[result.result] || messages.wrong;
      this._code = "";
      if (result.result === "approved") this._showToast("Remote paired");
      this._render();
      if (result.result !== "approved") {
        const input = this.shadowRoot.querySelector(".code");
        if (input) { input.classList.add("bad"); input.focus(); }
      }
    } catch (err) {
      this._pairMsg = { bad: true, text: (err && err.message) || "Pairing failed." };
      this._render();
    } finally {
      this._pairBusy = false;
    }
  }

  /* ---- rendering */

  _render() {
    const root = this.shadowRoot;
    const active = root.activeElement;
    const keep = active && active.classList && active.classList.contains("code")
      ? { value: active.value, start: active.selectionStart } : null;
    const narrow = !!this._narrow || window.innerWidth < 870;
    const pendingCount = this._data ? this._data.pending.length : 0;

    let body;
    if (this._error) body = `<div class="loading">${esc(this._error)}</div>`;
    else if (!this._data) body = `<div class="loading">Loading…</div>`;
    else if (this._tab === "remotes") body = this._renderRemotes();
    else if (this._tab === "settings") body = this._renderSettings();
    else body = this._renderLayout();

    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="root ${narrow ? "narrow" : ""}">
        <div class="toolbar">
          <ha-menu-button></ha-menu-button>
          <div class="title">T-Embed Remote</div>
        </div>
        <nav class="tabs" role="tablist">
          ${TABS.map((t) => `
            <button class="tab" role="tab" data-action="tab" data-arg="${t.id}"
              aria-selected="${this._tab === t.id}">
              <ha-icon icon="${t.icon}"></ha-icon>${t.label}
              ${t.id === "remotes" && pendingCount ? `<span class="dot" title="Waiting to pair"></span>` : ""}
            </button>`).join("")}
        </nav>
        <main>${body}</main>
        ${this._dialog ? this._renderDialog() : ""}
        ${this._toast ? `<div class="toast">${esc(this._toast)}</div>` : ""}
      </div>`;

    const menu = root.querySelector("ha-menu-button");
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    if (this._dialog && this._dialog.kind === "picker") this._renderPickList();

    const code = root.querySelector(".code");
    if (code) {
      if (keep) {
        code.value = keep.value;
        code.focus();
        try { code.setSelectionRange(keep.start, keep.start); } catch (e) { /* ignore */ }
      } else if (this._code) {
        code.value = this._code;
      }
      if (!this._dialog && !keep && root.activeElement !== code && !this._codeFocused) {
        this._codeFocused = true;
        requestAnimationFrame(() => code.focus());
      }
    } else {
      this._codeFocused = false;
    }
  }

  _pendingBanner() {
    const pending = this._data.pending;
    if (!pending.length) return "";
    return `
      <div class="banner" data-action="goto-remotes">
        <ha-icon icon="mdi:remote"></ha-icon>
        <div class="text"><b>${esc(pending[0].name)}</b> is waiting to pair. Enter the code shown on it.</div>
        <button class="btn primary">Enter code</button>
      </div>`;
  }

  _entityRow(entity, actions, extraClass) {
    const icon = DOMAIN_ICONS[entity.domain] || "mdi:help-circle-outline";
    const area = entity.area_id ? this._areaName(entity.area_id) : "No room";
    return `
      <div class="row ${extraClass || ""}">
        <div class="icon"><ha-icon icon="${icon}"></ha-icon></div>
        <div class="text">
          <div class="name">${esc(entity.name)}</div>
          <div class="sub">${esc(DOMAIN_NAMES[entity.domain] || entity.domain)} · ${esc(area)}</div>
        </div>
        <div class="actions">${actions}</div>
      </div>`;
  }

  _renderLayout() {
    const layout = this._layout;
    const favs = layout.favourites.map((id) => this._entity(id)).filter(Boolean);
    const sections = this._sections();

    const favRows = favs.length
      ? favs.map((entity, i) => this._entityRow(entity, `
          <button class="ibtn" data-action="fav-up" data-index="${i}" ${i === 0 ? "disabled" : ""} title="Move up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
          <button class="ibtn" data-action="fav-down" data-index="${i}" ${i === favs.length - 1 ? "disabled" : ""} title="Move down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
          <button class="ibtn danger" data-action="fav-remove" data-arg="${esc(entity.entity_id)}" title="Remove from favourites"><ha-icon icon="mdi:close"></ha-icon></button>`)).join("")
      : `<div class="empty">No favourites yet. Add the lights and scenes you use most, and they sit at the top of the remote.</div>`;

    const labelNote = layout.favourites_from_label && this._data.settings.favourites_label
      ? `<p class="note" style="margin:0 20px 12px">Taken from the “${esc(this._data.settings.favourites_label)}” label for now. Changing anything here turns this into your own list.</p>`
      : "";

    const sectionRows = sections.length
      ? sections.map((s, i) => this._sectionRow(s, i, sections.length)).join("")
      : `<div class="empty">No rooms with lights or switches yet. Give your devices an area in Home Assistant, or make a group.</div>`;

    return `
      ${this._pendingBanner()}
      <div class="grid">
        <div class="stack">
          <section class="card">
            <div class="card-head">
              <div class="grow">
                <h2>Favourites</h2>
                <p>First on the remote's home screen. Click to switch, hold for brightness.</p>
              </div>
            </div>
            ${labelNote}
            <div class="card-body">${favRows}</div>
            <div class="card-foot">
              <button class="btn" data-action="fav-add"><ha-icon icon="mdi:star-plus-outline"></ha-icon>Choose favourites</button>
            </div>
          </section>
          <section class="card">
            <div class="card-head">
              <div class="grow">
                <h2>Rooms and groups</h2>
                <p>Rooms come from your Home Assistant areas. Put them in the order you want, hide the ones you don't need, or open a room to hide single items.</p>
              </div>
            </div>
            <div class="card-body">${sectionRows}</div>
            <div class="card-foot">
              <button class="btn" data-action="group-new"><ha-icon icon="mdi:plus"></ha-icon>New group</button>
            </div>
          </section>
        </div>
        <div class="preview-wrap">${this._renderPreview()}</div>
      </div>`;
  }

  _sectionRow(section, index, total) {
    const layout = this._layout;
    const move = `
      <button class="ibtn" data-action="sec-up" data-index="${index}" ${index === 0 ? "disabled" : ""} title="Move up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
      <button class="ibtn" data-action="sec-down" data-index="${index}" ${index === total - 1 ? "disabled" : ""} title="Move down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>`;
    const count = this._sectionVisible(section);

    if (section.kind === "group") {
      const g = section.group;
      const names = g.entities.map((id) => this._entity(id)).filter(Boolean).map((e) => e.name);
      return `
        <div class="row">
          <div class="icon group"><ha-icon icon="mdi:folder-multiple-outline"></ha-icon></div>
          <div class="text">
            <div class="name">${esc(g.name)} <span class="pill">Group</span></div>
            <div class="sub">${names.length ? esc(names.join(", ")) : "Empty, so it won't show"}</div>
          </div>
          <div class="actions">
            ${move}
            <button class="ibtn" data-action="group-edit" data-arg="${esc(g.id)}" title="Edit group"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
            <button class="ibtn danger" data-action="group-delete" data-arg="${esc(g.id)}" title="Delete group"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
          </div>
        </div>`;
    }

    const area = section.area;
    const hidden = layout.hidden_areas.includes(area.id);
    const open = this._open.has(area.id);
    const children = open ? `
      <div class="children">
        ${section.members.map((e) => {
          const off = layout.hidden_entities.includes(e.entity_id);
          return `
            <div class="row ${off ? "hidden" : ""}">
              <div class="icon ${off ? "off" : ""}"><ha-icon icon="${DOMAIN_ICONS[e.domain] || "mdi:help"}"></ha-icon></div>
              <div class="text"><div class="name">${esc(e.short)}</div></div>
              <div class="actions">
                <button class="ibtn" data-action="entity-hide" data-arg="${esc(e.entity_id)}" title="${off ? "Show on the remote" : "Hide from the remote"}">
                  <ha-icon icon="${off ? "mdi:eye-off-outline" : "mdi:eye-outline"}"></ha-icon></button>
              </div>
            </div>`;
        }).join("")}
      </div>` : "";

    return `
      <div class="row click ${hidden ? "hidden" : ""}" data-action="toggle-open" data-arg="${esc(area.id)}">
        <div class="icon ${hidden ? "off" : ""}"><ha-icon icon="${esc(area.icon || "mdi:sofa-outline")}"></ha-icon></div>
        <div class="text">
          <div class="name">${esc(area.name)}</div>
          <div class="sub">${hidden ? "Hidden from the remote" : `${count} of ${section.members.length} shown`}</div>
        </div>
        <ha-icon class="chev ${open ? "open" : ""}" icon="mdi:chevron-right"></ha-icon>
        <div class="actions" data-action="none">
          ${move}
          <button class="ibtn" data-action="area-hide" data-arg="${esc(area.id)}" title="${hidden ? "Show on the remote" : "Hide from the remote"}">
            <ha-icon icon="${hidden ? "mdi:eye-off-outline" : "mdi:eye-outline"}"></ha-icon></button>
        </div>
      </div>
      ${children}`;
  }

  _renderPreview() {
    const p = this._data.preview || { f: [], r: [] };
    const items = [];
    if (p.f.length) items.push(["Favourites", p.f.length]);
    for (const [name, rows] of p.r) items.push([name, rows.length]);
    const shown = items.slice(0, PREVIEW_ROWS);
    const more = items.length - shown.length;
    return `
      <section class="card">
        <div class="card-head"><div class="grow"><h2>On the remote</h2>
          <p>What the home screen looks like with these settings.</p></div></div>
        <div class="device">
          <div class="screen">
            <div class="bar"><span>Home</span><span>${items.length} ${items.length === 1 ? "place" : "places"}</span></div>
            <div class="rule"></div>
            <ul>
              ${shown.length ? shown.map(([name, n], i) => `
                <li class="${i === 0 ? "sel" : ""}"><span class="n">${esc(name)}</span><span class="c">${n}</span></li>`).join("")
                : `<li><span class="n" style="color:#5c6776">Nothing to show yet</span></li>`}
            </ul>
            ${more > 0 ? `<div class="more">+ ${more} more</div>` : ""}
          </div>
          <div class="dial"><span></span></div>
        </div>
        <p class="note" style="margin:4px 20px 18px">Colours on the T-Embed follow your Bruce theme.</p>
      </section>`;
  }

  _renderRemotes() {
    const { pending, devices } = this._data;
    const host = window.location.hostname;
    let pairCard;
    if (pending.length) {
      const p = pending[0];
      const msg = this._pairMsg;
      pairCard = `
        <section class="card pair">
          <h2>Enter the code from your T-Embed</h2>
          <p><b>${esc(p.name)}</b> at ${esc(p.ip)} wants to connect. Type the 6 digits it shows.</p>
          <input class="code ${msg && msg.bad ? "bad" : ""}" inputmode="numeric" autocomplete="one-time-code"
            maxlength="6" placeholder="······" aria-label="Pairing code">
          <div class="msg ${msg ? (msg.bad ? "bad" : "ok") : ""}">${msg ? esc(msg.text) : `The code works for 5 minutes.`}</div>
          <button class="btn primary" data-action="pair" ${this._pairBusy ? "disabled" : ""}><ha-icon icon="mdi:link-variant"></ha-icon>Pair</button>
        </section>`;
    } else {
      const msg = this._pairMsg && !this._pairMsg.bad ? this._pairMsg : null;
      pairCard = `
        <section class="card pair">
          <h2>${devices.length ? "Pair another T-Embed" : "Pair your T-Embed"}</h2>
          ${msg ? `<div class="msg ok">${esc(msg.text)}</div>` : ""}
          <ol class="steps">
            <li><span>Copy <code>ha_remote.js</code> to <code>/BruceJS/Tools/</code> on the T-Embed's SD card, or install HA Remote from the Bruce app store.</span></li>
            <li><span>On the T-Embed, open <b>JS Interpreter → Tools → ha_remote.js</b>. Make sure it's on your WiFi.</span></li>
            <li><span>Pick <b>homeassistant.local</b>, or type <code>${esc(host)}</code> if that doesn't work.</span></li>
            <li><span>A 6-digit code appears on the T-Embed. This page asks for it.</span></li>
          </ol>
          <div class="waiting"><span class="pulse"></span>Waiting for a T-Embed…</div>
        </section>`;
    }

    const deviceCards = devices.length ? `
      <section class="card">
        <div class="card-head"><div class="grow"><h2>Paired remotes</h2></div></div>
        ${devices.map((d) => {
          const fresh = d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 120000;
          return `
          <div class="device-card">
            <div class="devimg"><ha-icon icon="mdi:remote"></ha-icon></div>
            <div class="grow">
              <div class="title">${esc(d.name)}
                ${fresh ? `<span class="pill ok">Online</span>` : `<span class="pill">Last seen ${esc(ago(d.last_seen_at))}</span>`}
              </div>
              <div class="meta">
                ${d.battery != null ? `Battery ${esc(d.battery)}% · ` : ""}${d.last_seen_ip ? `${esc(d.last_seen_ip)} · ` : ""}App ${esc(d.app || "unknown")}
              </div>
            </div>
            <div class="actions">
              <button class="ibtn" data-action="device-rename" data-arg="${esc(d.id)}" title="Rename"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
              <button class="ibtn danger" data-action="device-remove" data-arg="${esc(d.id)}" title="Remove"><ha-icon icon="mdi:link-variant-off"></ha-icon></button>
            </div>
          </div>`;
        }).join("")}
      </section>` : "";

    return `<div class="stack" style="max-width:720px;margin:0 auto">${pairCard}${deviceCards}</div>`;
  }

  _renderSettings() {
    const s = this._data.settings;
    const layout = this._layout;
    return `
      <div class="stack" style="max-width:720px;margin:0 auto">
        <section class="card">
          <div class="setting">
            <div class="grow">
              <div class="label">Allow from outside my network</div>
              <div class="note">Leave this off unless the remote has to reach Home Assistant through a VPN or tunnel. With it on, a key copied off a lost SD card works from anywhere.</div>
            </div>
            <label class="switch"><input type="checkbox" name="allow_remote" ${s.allow_remote ? "checked" : ""}><span></span></label>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><div class="grow"><h2>Labels</h2>
            <p>You can also tag things anywhere in Home Assistant instead of using this page.</p></div></div>
          <div class="setting">
            <div class="grow">
              <div class="label">${esc(s.hide_label || "T-Embed hide")}</div>
              <div class="note">Anything with this label never shows on the remote.</div>
            </div>
          </div>
          <div class="setting">
            <div class="grow">
              <div class="label">${esc(s.favourites_label || "T-Embed favourite")}</div>
              <div class="note">${layout.favourites_from_label
                ? "Your favourites currently come from this label."
                : "Not in use: your favourites are the list on the Home screen tab."}</div>
            </div>
            ${layout.favourites_from_label ? "" : `<button class="btn plain" data-action="use-label">Use label instead</button>`}
          </div>
        </section>
        <p class="note" style="text-align:center">Which labels are used can be changed under Settings → Devices &amp; services → T-Embed Remote → Configure.</p>
      </div>`;
  }

  _renderDialog() {
    const d = this._dialog;
    if (d.kind === "confirm") {
      return `
        <div class="scrim"><div class="dialog" role="dialog" aria-modal="true" style="max-width:420px">
          <h2>${esc(d.title)}</h2>
          <p class="hint" style="padding-bottom:16px;line-height:1.5">${esc(d.text)}</p>
          <div class="foot">
            <button class="btn plain" data-action="dialog-cancel">Cancel</button>
            <button class="btn danger" data-action="dialog-ok">${esc(d.okLabel)}</button>
          </div>
        </div></div>`;
    }
    if (d.kind === "rename") {
      return `
        <div class="scrim"><div class="dialog" role="dialog" aria-modal="true" style="max-width:420px">
          <h2>${esc(d.title)}</h2>
          <input class="field" value="${esc(d.value)}" maxlength="64" aria-label="Name">
          <div class="foot" style="border:0;margin-top:8px">
            <button class="btn plain" data-action="dialog-cancel">Cancel</button>
            <button class="btn primary" data-action="dialog-ok">Save</button>
          </div>
        </div></div>`;
    }
    const domains = Array.from(new Set(this._data.entities.map((e) => e.domain)));
    return `
      <div class="scrim"><div class="dialog" role="dialog" aria-modal="true">
        <h2>${esc(d.title)}</h2>
        <div class="hint">${esc(d.hint)}</div>
        ${d.name !== undefined ? `<input class="field" placeholder="Group name" value="${esc(d.value)}" maxlength="40" aria-label="Group name">` : ""}
        <input class="field search" type="search" placeholder="Search lights, switches, scenes…" value="${esc(d.query)}" aria-label="Search">
        <div class="filters">
          <button class="chip" data-action="filter" data-arg="all" aria-pressed="${d.filter === "all"}">All</button>
          <button class="chip" data-action="filter" data-arg="selected" aria-pressed="${d.filter === "selected"}">Chosen</button>
          ${domains.map((dom) => `<button class="chip" data-action="filter" data-arg="${dom}" aria-pressed="${d.filter === dom}">${esc(DOMAIN_NAMES[dom] || dom)}s</button>`).join("")}
        </div>
        <div class="picklist"></div>
        <div class="foot">
          <span class="count"></span>
          <button class="btn plain" data-action="dialog-cancel">Cancel</button>
          <button class="btn primary" data-action="dialog-ok">Done</button>
        </div>
      </div></div>`;
  }

  _renderPickList() {
    const d = this._dialog;
    const list = this.shadowRoot.querySelector(".picklist");
    if (!d || !list) return;
    this.shadowRoot.querySelectorAll(".chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.arg === d.filter));
    });
    const q = (d.query || "").trim().toLowerCase();
    const matches = this._data.entities.filter((e) => {
      if (d.filter === "selected" && !d.selected.includes(e.entity_id)) return false;
      if (d.filter !== "all" && d.filter !== "selected" && e.domain !== d.filter) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.entity_id.includes(q)
        || (e.area_id && this._areaName(e.area_id).toLowerCase().includes(q));
    });
    const groups = new Map();
    for (const area of this._data.areas) groups.set(area.id, []);
    groups.set(null, []);
    for (const e of matches) {
      const key = groups.has(e.area_id) ? e.area_id : null;
      groups.get(key).push(e);
    }
    let html = "";
    for (const [areaId, entities] of groups) {
      if (!entities.length) continue;
      html += `<div class="area">${esc(areaId ? this._areaName(areaId) : "No room")}</div>`;
      html += entities.map((e) => {
        const on = d.selected.includes(e.entity_id);
        return `
          <div class="row pick ${on ? "on" : ""}" data-action="pick" data-arg="${esc(e.entity_id)}" role="checkbox" aria-checked="${on}">
            <div class="check"><ha-icon icon="mdi:check"></ha-icon></div>
            <div class="icon"><ha-icon icon="${DOMAIN_ICONS[e.domain] || "mdi:help"}"></ha-icon></div>
            <div class="text"><div class="name">${esc(e.short)}</div>
              <div class="sub">${esc(DOMAIN_NAMES[e.domain] || e.domain)}</div></div>
          </div>`;
      }).join("");
    }
    list.innerHTML = html || `<div class="empty">Nothing matches.</div>`;
    const count = this.shadowRoot.querySelector(".dialog .count");
    if (count) count.textContent = `${d.selected.length} chosen`;
  }
}

if (!customElements.get("tembed-remote-panel")) {
  customElements.define("tembed-remote-panel", TEmbedRemotePanel);
}
