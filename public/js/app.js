// The lobby page: two buttons, two roads, one door. Every call is made by the lobby's server.
import { createDoor, travel } from "./door.js";

const $ = (id) => document.getElementById(id);
const door = createDoor($("vault"));
const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB");

let info = null; // last /api/state
let opened = false;
let busy = false;
const mine = new Set(); // drawers deposited from this page

// ---------- tiny DOM helpers (text only, never HTML) ----------
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(kind) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.classList.add("drawer__icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${kind}`);
  s.append(use);
  return s;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function setPlaque(tone, title, text, lines = []) {
  $("plaque").dataset.tone = tone;
  $("plaqueTitle").textContent = title;
  $("plaqueText").textContent = text;
  const list = $("plaqueList");
  list.replaceChildren(...lines.map((line) => h("li", "", line)));
  list.hidden = lines.length === 0;
}

function setBusy(value) {
  busy = value;
  for (const id of ["breakIn", "tunnel", "closeDoor"]) $(id).disabled = value;
  for (const chip of document.querySelectorAll(".chip")) chip.disabled = value;
}

// ---------- rendering ----------
function renderPlatform(platform) {
  // "Live on Clever Cloud" only when the platform says so (APP_ID is injected by Clever Cloud).
  const live = Boolean(platform.APP_ID);
  $("livePill").classList.toggle("cc-pill--live", live);
  $("livePill").classList.toggle("cc-pill--muted", !live);
  $("livePill").firstElementChild.classList.toggle("cc-dot--muted", !live);
  $("liveText").textContent = live ? "Live on Clever Cloud" : "Running locally";
  const labels = {
    CC_APP_NAME: "Application", APP_ID: "App ID", INSTANCE_NUMBER: "Instance", INSTANCE_TYPE: "Instance type",
    CC_PRETTY_INSTANCE_NAME: "Instance name", CC_COMMIT_ID: "Commit", CC_DEPLOYMENT_ID: "Deployment",
  };
  const list = $("platformVars");
  list.replaceChildren();
  for (const [name, label] of Object.entries(labels)) {
    const row = h("div");
    const dd = h("dd", platform[name] ? "" : "is-empty", platform[name] ?? "not on Clever Cloud");
    row.append(h("dt", "", label), dd);
    list.append(row);
  }
}

function renderNetwork(network, vault) {
  const local = network.mode !== "network-group";
  $("ngId").textContent = network.ngId ?? "none: local mode, the vault is on this machine";
  $("ngCidr").textContent = network.cidr ?? (local ? "loopback (127.0.0.0/8)" : "not found on this instance");

  const list = $("members");
  list.replaceChildren();
  for (const member of network.members) {
    const li = h("li", "member");
    const head = h("div", "member__head");
    head.append(
      h("span", "member__name", member.role === "lobby" ? "The lobby" : "The vault"),
      h("span", "member__tag", member.role === "lobby" ? "this app, public on 8080" : "public port blocked, listens on 9000"),
    );
    li.append(head);
    const line = (label, value) => {
      const p = h("p", "member__line");
      p.append(h("span", "", `${label} `), document.createTextNode(value));
      li.append(p);
    };
    if (member.id) line("id", member.id);
    line("name", member.domain ?? "unknown");
    line("peer", member.peers?.length ? member.peers.join(", ") : "not resolved");
    if (member.interface) line("interface", member.interface);
    list.append(li);
  }

  $("hostname").textContent = vault.url;
  $("tunnelAddr").textContent = `${vault.url}/treasure`;
  $("streetAddr").textContent = vault.publicUrl ? `${vault.publicUrl}/treasure` : "VAULT_PUBLIC_URL is not set";

  const lobbyId = network.members.find((m) => m.role === "lobby")?.id ?? "app_lobby";
  const vaultId = network.members.find((m) => m.role === "vault")?.id ?? "app_vault";
  $("wiring").textContent = [
    "# One Network Group, two members",
    `clever ng create demo-network-groups --link ${lobbyId},${vaultId}`,
    "",
    "# The vault: public port bricked up, private port 9000",
    "clever env set CC_REQUEST_FLOW block --alias vault",
    "clever env set PORT 9000 --alias vault",
    "",
    "# The lobby: the vault's member name, from `clever ng get`",
    `clever env set VAULT_URL ${vault.url} --alias lobby`,
    `clever env set VAULT_PUBLIC_URL ${vault.publicUrl ?? "https://app-….cleverapps.io"} --alias lobby`,
  ].join("\n");
}

function renderLogbook(entries) {
  const list = $("logbook");
  list.replaceChildren();
  if (!entries?.length) {
    list.append(h("li", "logbook__empty", "No attempts yet on this instance."));
    return;
  }
  for (const entry of entries) {
    const li = h("li", entry.ok ? "is-ok" : "is-ko");
    li.append(h("span", "logbook__time", clock(entry.at)), h("span", "logbook__mark", entry.ok ? "✓" : "✕"), h("span", "", `${entry.road}: ${entry.line}`));
    list.append(li);
  }
}

function renderSealed(count) {
  const list = $("drawers");
  list.replaceChildren();
  for (let n = 1; n <= count; n++) {
    const li = h("li", "drawer");
    li.append(h("span", "drawer__no", `No. ${String(n).padStart(2, "0")}`), h("span", "drawer__keyhole"), h("p", "drawer__sealed", "Sealed"));
    list.append(li);
  }
}

function renderInventory(items, total, { slide = false, fresh = null } = {}) {
  const crown = items.filter((item) => !item.deposit);
  const deposits = items.filter((item) => item.deposit).slice(-8).reverse();
  const shown = [...deposits, ...crown];
  const list = $("drawers");
  list.replaceChildren();
  shown.forEach((item, i) => {
    const li = h("li", `drawer is-open${slide ? " is-sliding" : ""}${mine.has(item.drawer) ? " is-yours" : ""}`);
    li.style.setProperty("--i", String(i));
    li.append(h("span", "drawer__no", `No. ${String(item.drawer).padStart(2, "0")}`), icon(item.kind));
    li.append(h("p", "drawer__name", item.name), h("p", "drawer__detail", item.detail));
    const meta = h("p", "drawer__meta");
    meta.append(h("span", "", item.serial), h("b", "", euros.format(item.appraisal)));
    li.append(meta);
    if (item.deposit) {
      const who = mine.has(item.drawer) ? "Yours, deposited" : "Deposited";
      li.append(h("p", "drawer__from", `${who} through the tunnel from ${item.deposit.from} at ${clock(item.deposit.at)}`));
    }
    if (item.drawer === fresh) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    list.append(li);
  });
  const hidden = items.filter((item) => item.deposit).length - deposits.length;
  $("strongSub").textContent =
    `${items.length} drawers, read through the tunnel.` + (hidden > 0 ? ` Showing the 8 latest deposits, ${hidden} older ones stay in the vault.` : "");
  $("total").textContent = `Appraised at ${euros.format(total)}`;
  $("strongroom").dataset.state = "open";
  $("deposit").hidden = false;
}

function renderPath(r) {
  const vaultMs = r.timings.vault ?? 0;
  $("pathDns").textContent = `${r.timings.dns} ms`;
  $("pathDnsDetail").textContent = `${new URL(r.url).hostname} → ${r.resolved.join(", ") || "no answer"}`;
  $("pathTrip").textContent = `${Math.max(0, r.timings.roundTrip - vaultMs).toFixed(1)} ms`;
  $("pathTripDetail").textContent = `${new URL(r.url).pathname} over WireGuard, HTTP ${r.status}, total ${r.timings.total} ms`;
  $("pathVault").textContent = r.timings.vault === null ? "–" : `${vaultMs} ms`;
  $("pathVaultDetail").textContent = r.body?.caller?.verdict ?? "inside the vault app";
  $("hostname").textContent = `${r.url.replace(/\/[a-z]+$/, "")}  →  ${r.resolved.join(", ") || "?"}`;
}

function renderLedger(ledger, vault) {
  const node = $("ledger");
  node.replaceChildren();
  const b = (text) => h("b", "", String(text));
  const sources = Object.entries(ledger.sources).map(([ip, n]) => `${ip} (${n})`).join(", ") || "none";
  node.append(
    b(ledger.received), " requests reached the vault app since it started: ", b(ledger.allowed), " let in, ", b(ledger.refused), " refused. ",
    "Callers let in: ", sources, ". Requests to the public address never show up here: Clever’s block service answers them before they reach the app.",
  );
  if (vault?.peer) node.append(h("br"), `Vault instance ${vault.instance ?? ""} #${vault.instanceNumber ?? "0"}: peer ${vault.peer} on ${vault.interface}, port ${vault.port}.`);
}

// ---------- actions ----------
async function goThroughTunnel() {
  if (busy) return;
  setBusy(true);
  const road = $("roadTunnel");
  road.dataset.state = "busy";
  $("tunnelResult").textContent = "Capsule on its way…";
  setPlaque("neutral", "Sending a capsule…", "The lobby calls the vault at its private member name, inside the Network Group.");
  try {
    const capsule = $("capsule");
    const track = capsule.parentElement;
    const [data] = await Promise.all([api("/api/tunnel", {}), travel(capsule, track, 0, 1, 700)]);
    await travel(capsule, track, 1, 0, 650, "cubic-bezier(.3,0,.2,1)");
    renderLogbook(data.logbook);
    if (!data.ok) throw new Error(`the vault answered HTTP ${data.status}${data.body?.reason ? `: ${data.body.reason}` : ""}`);
    road.dataset.state = "open";
    $("tunnelResult").textContent = `Let in: HTTP ${data.status}, sealed by the vault, ${data.timings.total} ms.`;
    if (data.network) renderNetwork(data.network, info.vault);
    renderPath(data);
    renderLedger(data.body.ledger, data.body.vault);
    const first = !opened;
    if (first) {
      setPlaque("neutral", "Dialling…", `The vault sent its combination through the tunnel: ${data.body.combination.join(", ")}.`);
      await door.open(data.body.combination);
      opened = true;
      $("closeDoor").hidden = false;
    }
    renderInventory(data.body.items, data.body.total, { slide: first });
    setPlaque(
      "open",
      "Open.",
      `Through the Network Group in ${data.timings.total} ms. The vault’s own check: ${data.body.caller.verdict}. Combination ${data.body.combination.join(", ")}.`,
    );
  } catch (err) {
    road.dataset.state = "refused";
    $("tunnelResult").textContent = err.message;
    setPlaque("refused", "The tunnel did not answer.", err.message);
  } finally {
    setBusy(false);
  }
}

function describeTcp(tcp) {
  if (tcp.outcome === "timeout") return `no answer after ${(tcp.ms / 1000).toFixed(1)} s`;
  if (tcp.outcome === "refused") return `connection refused in ${tcp.ms} ms`;
  if (tcp.outcome === "unreachable") return "unreachable";
  return `a connection was accepted in ${tcp.ms} ms`;
}

async function breakIn() {
  if (busy) return;
  setBusy(true);
  const road = $("roadStreet");
  try {
    if (opened) {
      setPlaque("neutral", "Closing the door…", "A break-in starts with the vault locked.");
      await door.close();
      opened = false;
      $("closeDoor").hidden = true;
    }
    road.dataset.state = "busy";
    $("streetResult").textContent = "On the way to the public address…";
    setPlaque("neutral", "Trying the street…", `GET ${info?.vault.publicUrl ?? "?"}/treasure, a knock on port ${info?.vault.privatePort ?? 9000}, and a public DNS lookup of the vault’s private name.`);
    const runner = $("runner");
    const track = runner.parentElement;
    const wallStop = track.clientWidth * 0.72 - 19 - runner.offsetWidth - 2;
    const [data] = await Promise.all([api("/api/break-in", {}), travel(runner, track, 0, 1, 650, "cubic-bezier(.6,0,.9,.6)", wallStop)]);
    door.alarm();
    await travel(runner, track, 1, 0, 700, "cubic-bezier(.15,.9,.3,1)", wallStop);
    renderLogbook(data.logbook);
    const { http, tcp, dns } = data;
    const httpText = http.status === null ? `did not answer (${http.error})` : `answered HTTP ${http.status} with ${http.bytes} bytes${http.preview ? ` (“${http.preview}”)` : ""}`;
    if (data.ok) {
      road.dataset.state = "open";
      $("streetResult").textContent = "The public address returned the vault’s own answer.";
      setPlaque("refused", "The door was open.", `${http.url} ${httpText}, sealed by the vault. Check CC_REQUEST_FLOW on the vault app.`);
      return;
    }
    road.dataset.state = "refused";
    $("streetResult").textContent = `Refused: HTTP ${http.status ?? http.error} without the vault seal, port ${tcp.port} ${tcp.outcome}, private name ${dns.outcome === "resolved" ? "resolved" : "unknown"} on ${dns.resolver}.`;
    setPlaque("refused", "Refused.", "Three tries from the street, three dead ends.", [
      `The public address ${httpText}, without the vault seal: Clever’s block service answered, the vault app never saw the request.`,
      `Port ${tcp.port} on the public host: ${describeTcp(tcp)}.`,
      dns.outcome === "resolved"
        ? `The private name resolved on ${dns.resolver} to ${dns.addresses.join(", ")}, a private address no one outside can reach.`
        : `The private name on the public resolver ${dns.resolver}: ${dns.outcome}.`,
    ]);
  } catch (err) {
    road.dataset.state = "idle";
    $("streetResult").textContent = err.message;
    setPlaque("refused", "The break-in could not run.", err.message);
  } finally {
    setBusy(false);
  }
}

async function closeDoor() {
  if (busy || !opened) return;
  setBusy(true);
  await door.close();
  opened = false;
  $("closeDoor").hidden = true;
  setPlaque("neutral", "Locked.", "The bolts are back in the frame. Pick a way in.");
  setBusy(false);
}

async function deposit(kind) {
  if (busy) return;
  setBusy(true);
  const note = $("depositNote");
  note.textContent = "Sending the deposit through the tunnel…";
  const capsule = $("capsule");
  const track = capsule.parentElement;
  $("roadTunnel").dataset.state = "busy";
  try {
    const [data] = await Promise.all([api("/api/deposit", { kind }), travel(capsule, track, 0, 1, 600)]);
    await travel(capsule, track, 1, 0, 550, "cubic-bezier(.3,0,.2,1)");
    $("roadTunnel").dataset.state = "open";
    renderLogbook(data.logbook);
    const item = data.body.item;
    mine.add(item.drawer);
    renderInventory(data.body.items, data.body.total, { fresh: item.drawer });
    renderPath(data);
    renderLedger(data.body.ledger, data.body.vault);
    note.textContent = `Filed in drawer No. ${item.drawer}: POST ${new URL(data.url).pathname} through the tunnel, HTTP ${data.status} in ${data.timings.total} ms. The vault wrote it, then sent back all ${data.body.items.length} drawers.`;
  } catch (err) {
    note.textContent = err.message;
  } finally {
    setBusy(false);
  }
}

// ---------- start ----------
$("tunnel").addEventListener("click", goThroughTunnel);
$("breakIn").addEventListener("click", breakIn);
$("closeDoor").addEventListener("click", closeDoor);
for (const chip of document.querySelectorAll(".chip")) chip.addEventListener("click", () => deposit(chip.dataset.kind));

try {
  info = await api("/api/state");
  renderPlatform(info.platform);
  renderNetwork(info.network, info.vault);
  renderLogbook(info.logbook);
  const manifest = info.vault.manifest;
  if (manifest.reachable) {
    renderSealed(Math.min(manifest.drawers, 12));
    $("strongSub").textContent = `${manifest.drawers} drawers, sealed. Go through the tunnel to read them.`;
  } else {
    renderSealed(12);
    $("strongSub").textContent = `The vault did not answer through the tunnel: ${manifest.error ?? `HTTP ${manifest.status}`}.`;
  }
} catch (err) {
  setPlaque("refused", "The lobby could not load.", err.message);
}
