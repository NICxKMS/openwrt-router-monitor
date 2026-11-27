"use strict";

const el = (id) => document.getElementById(id);
const categories = {
  network: ["Network & VPN", "↗"],
  dns: ["DNS & privacy", "◈"],
  monitoring: ["Monitoring", "≋"],
  system: ["System & storage", "▤"],
  drivers: ["Drivers & libraries", "◫"],
  other: ["Other packages", "·"],
};
const views = { featured: ["Featured", "✦"], all: ["All packages", "▦"], installed: ["Installed", "✓"] };
const featured = {
  "luci-app-sqm": {
    category: "network", description: "Keep calls and games responsive while your connection is busy.",
    note: "After installation, choose CAKE and enter your measured upload and download speeds in LuCI. Hardware flow offloading bypasses SQM shaping and needs to be disabled.",
    path: "/cgi-bin/luci/admin/network/sqm", label: "Configure SQM",
  },
  "luci-app-adguardhome": {
    category: "dns", description: "Filter ads and trackers across your network with AdGuard Home.",
    note: "Complete AdGuard Home setup after installation. Give it a separate DNS listening port if dnsmasq is also serving DNS. Keep dnsmasq responsible for DHCP.",
    path: "/cgi-bin/luci/admin/services/adguardhome", label: "Open AdGuard Home",
  },
  "luci-app-nlbwmon": {
    category: "monitoring", description: "See which devices use your bandwidth and how much they consume.",
    path: "/cgi-bin/luci/admin/services/nlbw", label: "View bandwidth usage",
  },
  "luci-app-statistics": {
    category: "monitoring", description: "Keep an eye on CPU, memory and network activity with system graphs.",
    path: "/cgi-bin/luci/admin/statistics", label: "Open system statistics",
  },
  "luci-proto-wireguard": {
    category: "network", description: "Add WireGuard tunnel configuration to your network settings.",
    note: "WireGuard needs a peer configuration and keys. This package adds tunnel support. Configure your own peer or a service that provides credentials.",
    path: "/cgi-bin/luci/admin/network/network", label: "Configure network interfaces",
  },
  "luci-app-https-dns-proxy": {
    category: "dns", description: "Send DNS queries to your chosen provider over HTTPS.",
    path: "/cgi-bin/luci/admin/services/https-dns-proxy", label: "Configure encrypted DNS",
  },
  "luci-app-adblock-fast": {
    category: "dns", description: "Lightweight DNS filtering for ads and trackers.",
    note: "Enable a blocklist under Allowed and Blocked Lists URLs, then save and start the service. The gawk, grep, sed and coreutils-sort packages speed up list processing. Choose a single DNS filtering service when setting up AdGuard Home or Adblock Fast.",
    path: "/cgi-bin/luci/admin/services/adblock-fast", label: "Configure Adblock Fast",
  },
  "zram-swap": {
    category: "system", description: "Use compressed RAM as swap space when memory pressure rises.",
    note: "zram exchanges some CPU time for additional usable memory under pressure. Check memory and swap usage after installation.",
  },
  "htop": {
    category: "monitoring", description: "Inspect running processes, CPU load and memory from the terminal.",
    note: "After installation, run htop in your router's SSH session.",
  },
};
const pageSize = 18;
const dialog = el("review-dialog");
const details = el("detail-dialog");
const state = {
  packages: new Map(), selected: new Set(), view: "featured", page: 0,
  online: false, busy: false, closed: false, preview: null, job: null, submittedPreview: null,
  data: null, queueKey: "", restored: false, detail: null, pollTimer: null,
};

function readStorage(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function writeStorage(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); }
  catch { /* Browsing still works when storage is unavailable. */ }
}
const preferences = readStorage(localStorage, "jidu-preferences", {});
const incomingToken = location.hash.slice(1);
if (incomingToken) {
  writeStorage(sessionStorage, "dashboard-token", incomingToken);
  history.replaceState(null, "", "/");
}
const token = incomingToken || readStorage(sessionStorage, "dashboard-token", "");
const initialTheme = preferences.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = initialTheme;
el("sort").value = ["recommended", "name", "size"].includes(preferences.sort) ? preferences.sort : "recommended";
el("packages").dataset.layout = preferences.layout === "list" ? "list" : "grid";
el("layout").setAttribute("aria-pressed", String(preferences.layout === "list"));
el("layout").setAttribute("aria-label", preferences.layout === "list" ? "Use package cards" : "Use compact list");
el("theme").setAttribute("aria-label", "Switch to " + (initialTheme === "dark" ? "light" : "dark") + " theme");

function makeElement(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: power ? 1 : 0 }) + " " + units[power];
}
async function api(action, payload) {
  const headers = { Authorization: "Bearer " + token };
  const options = { headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    options.method = "POST";
    options.body = JSON.stringify(payload);
  }
  let response;
  try { response = await fetch("/api/" + action, options); }
  catch { throw new Error("The dashboard cannot be reached. Check that the installer is still running in WSL."); }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message);
    error.output = data.output;
    error.status = response.status;
    throw error;
  }
  return data;
}
function categoryFor(name) {
  if (Object.hasOwn(featured, name)) return featured[name].category;
  if (/dns|adblock|adguard|unbound/.test(name)) return "dns";
  if (/collectd|rrd|nlbw|statistics|iperf|^htop/.test(name)) return "monitoring";
  if (/^kmod-|^lib/.test(name)) return "drivers";
  if (/vpn|wireguard|^ip-|^tc-|^sqm|^ppp|^firewall|^nft/.test(name)) return "network";
  if (/zram|disk|mount|usb|blkid|fdisk|block/.test(name)) return "system";
  return "other";
}
function running() { return state.job?.state === "running"; }
function routerUrl(path = "/") {
  const router = state.data.router;
  return "https://" + (router.includes(":") ? "[" + router + "]" : router) + path;
}
function showNotice(message, error = false) {
  el("notice").hidden = !message;
  el("notice").textContent = message;
  el("notice").dataset.error = String(error);
}
function setConnection(online, label) {
  state.online = online;
  el("connection").dataset.live = String(online);
  el("connection").lastElementChild.textContent = label;
  el("search").disabled = !state.data;
  el("close-session").disabled = state.closed || running() || state.busy;
  el("refresh").disabled = state.closed || running() || state.busy;
}
function saveQueue() {
  if (state.queueKey) writeStorage(sessionStorage, state.queueKey, [...state.selected]);
}
function renderFilters() {
  const focused = document.activeElement?.dataset.view;
  for (const [id, items] of [["views", views], ["categories", categories]]) {
    const buttons = Object.entries(items).map(([key, [label, symbol]]) => {
      const button = makeElement("button", undefined, "filter");
      button.type = "button";
      button.dataset.view = key;
      button.setAttribute("aria-pressed", String(state.view === key));
      const icon = makeElement("span", symbol, "filter-symbol");
      icon.setAttribute("aria-hidden", "true");
      button.append(icon, label);
      const count = [...state.packages.values()].filter((pkg) => {
        if (key === "all") return pkg.available;
        if (key === "installed") return pkg.installed;
        if (key === "featured") return pkg.available && Object.hasOwn(featured, pkg.name);
        return pkg.available && pkg.category === key;
      }).length;
      button.append(makeElement("small", count));
      button.addEventListener("click", () => {
        state.view = key;
        state.page = 0;
        el("search").value = "";
        renderFilters();
        renderCatalog();
      });
      return button;
    });
    el(id).replaceChildren(...buttons);
  }
  if (focused) document.querySelector('[data-view="' + focused + '"]')?.focus();
}
function toggleSelection(name) {
  if (running() || state.busy || !state.online) return;
  if (state.selected.has(name)) state.selected.delete(name);
  else state.selected.add(name);
  saveQueue();
  renderCatalog();
  renderQueue();
}
function hasUpdateCandidate(pkg) {
  return pkg?.update_available === true;
}
function packageCard(pkg) {
  const card = el("package-card").content.firstElementChild.cloneNode(true);
  const [category, symbol] = categories[pkg.category];
  const selected = state.selected.has(pkg.name);
  card.dataset.category = pkg.category;
  card.dataset.selected = String(selected);
  card.querySelector(".package-icon").textContent = symbol;
  card.querySelector(".package-category").textContent = category;
  card.querySelector(".installed-badge").hidden = !pkg.installed;
  const title = card.querySelector(".package-title");
  title.textContent = pkg.title || pkg.name;
  title.addEventListener("click", () => showDetails(pkg.name));
  card.querySelector(".package-name").textContent = pkg.name;
  card.querySelector(".package-name").hidden = !pkg.title;
  card.querySelector(".package-description").textContent = pkg.description || "Package information is available in Details.";
  card.querySelector(".package-size").textContent = bytes(pkg.size);
  card.querySelector(".package-size").title = "Installed size, excluding dependencies";
  const detailButton = card.querySelector(".package-details");
  detailButton.setAttribute("aria-label", "Details for " + pkg.name);
  detailButton.addEventListener("click", () => showDetails(pkg.name));
  const action = card.querySelector(".package-action");
  const update = hasUpdateCandidate(pkg);
  action.textContent = update ? "Review update" : pkg.installed ? "Installed" : selected ? "✓ Queued" : "+ Add";
  action.disabled = (!!pkg.installed && !update) || !pkg.available || !state.online || state.busy || running();
  action.dataset.package = pkg.name;
  if (!pkg.installed) action.setAttribute("aria-pressed", String(selected));
  action.setAttribute("aria-label", update ? "Review update for " + pkg.name
    : pkg.installed ? pkg.name + " is installed"
    : (selected ? "Remove " : "Add ") + pkg.name + (selected ? " from queue" : " to queue"));
  action.addEventListener("click", () => update ? reviewChanges(pkg.name) : toggleSelection(pkg.name));
  if (pkg.name === "luci-app-adblock-fast") {
    const tools = ["gawk", "grep", "sed", "coreutils-sort"].filter((name) => {
      const tool = state.packages.get(name);
      return tool?.available && !tool.installed && !state.selected.has(name);
    });
    if (tools.length) {
      const addTools = makeElement("button", "Add recommended tools", "button package-recommended");
      addTools.type = "button";
      addTools.disabled = !state.online || state.busy || running();
      addTools.addEventListener("click", () => {
        tools.forEach((name) => state.selected.add(name));
        saveQueue();
        renderCatalog();
        renderQueue();
      });
      card.insertBefore(addTools, card.querySelector(".package-bottom"));
    }
  }
  return card;
}
function renderCatalog() {
  const focus = document.activeElement?.dataset.package;
  const query = el("search").value.toLowerCase().trim();
  const matches = [...state.packages.values()].filter((pkg) => {
    if (state.view !== "installed" && !pkg.available) return false;
    const searchable = [pkg.title, pkg.name, pkg.description, categories[pkg.category][0]].join(" ").toLowerCase();
    if (!query.split(/\s+/).every((part) => searchable.includes(part))) return false;
    if (state.view === "featured") return Object.hasOwn(featured, pkg.name);
    if (state.view === "installed") return !!pkg.installed;
    return state.view === "all" || state.view === pkg.category;
  });
  const order = Object.keys(featured);
  const rank = (pkg) => order.includes(pkg.name) ? order.indexOf(pkg.name) : order.length;
  const sort = el("sort").value;
  matches.sort((a, b) => {
    if (sort === "size") return (a.size ?? Infinity) - (b.size ?? Infinity) || a.name.localeCompare(b.name);
    if (sort === "recommended") return rank(a) - rank(b) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  el("catalog-title").textContent = (views[state.view] || categories[state.view])[0];
  el("mobile-filter").value = state.view;
  el("result-count").textContent = matches.length + (matches.length === 1 ? " package" : " packages");
  const pages = Math.ceil(matches.length / pageSize);
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const cards = matches.slice(state.page * pageSize, (state.page + 1) * pageSize).map(packageCard);
  if (!cards.length) {
    const empty = makeElement("div", undefined, "empty-state");
    empty.append(makeElement("p", "No packages match these filters."));
    const reset = makeElement("button", "Browse all packages", "button secondary");
    reset.type = "button";
    reset.addEventListener("click", () => {
      state.view = "all";
      el("search").value = "";
      renderFilters();
      renderCatalog();
      el("search").focus();
    });
    empty.append(reset);
    cards.push(empty);
  }
  el("packages").replaceChildren(...cards);
  el("packages").setAttribute("aria-busy", "false");
  el("pagination").hidden = pages <= 1;
  el("page-number").textContent = "Page " + (state.page + 1) + " of " + pages;
  el("previous").disabled = state.page === 0;
  el("next").disabled = state.page + 1 >= pages;
  if (focus) document.querySelector('[data-package="' + CSS.escape(focus) + '"]')?.focus();
}
function renderQueue() {
  const list = el("queued");
  list.replaceChildren(...[...state.selected].map((name) => {
    const item = makeElement("li");
    const label = makeElement("span", state.packages.get(name)?.title || name);
    const remove = makeElement("button", "×", "icon-button");
    remove.type = "button";
    remove.disabled = running() || state.busy;
    remove.setAttribute("aria-label", "Remove " + name + " from queue");
    remove.addEventListener("click", () => {
      toggleSelection(name);
      (list.querySelector("button") || el("search")).focus();
    });
    item.append(label, remove);
    return item;
  }));
  const count = state.selected.size;
  list.hidden = !count;
  el("queue-empty").hidden = !!count;
  el("queue-count").textContent = count;
  el("queue-summary").hidden = !count;
  el("queue-size").textContent = bytes([...state.selected].reduce((size, name) => size + (state.packages.get(name)?.size || 0), 0));
  const blocking = running() || state.busy;
  el("review").disabled = !count || !state.online || blocking;
  el("clear").hidden = !count;
  el("clear").disabled = blocking;
  const dnsChosen = ["luci-app-adguardhome", "luci-app-adblock-fast"].filter((name) =>
    state.selected.has(name) || state.packages.get(name)?.installed);
  const note = dnsChosen.length > 1 && count
    ? "AdGuard Home and Adblock Fast both filter DNS. Choose which service will handle filtering when you configure them." : "";
  el("queue-note").textContent = note;
  el("queue-note").hidden = !note;
  document.querySelector(".queue").dataset.empty = String(!count && !state.job);
  document.querySelector(".queue").dataset.selection = String(!!count);
  el("active-job").hidden = !state.job;
  if (state.job) {
    el("job-label").textContent = running() ? "Installation in progress" : state.job.success ? "Packages installed" : "Check installation";
    el("job-status").textContent = state.job.message;
    el("show-job").textContent = running() ? "View progress" : "View result";
  }
}
function updateCatalog(data) {
  state.data = data;
  state.packages = new Map(data.packages.map((pkg) => [pkg.name, {
    ...pkg, category: categoryFor(pkg.name),
    description: featured[pkg.name]?.description || pkg.description,
  }]));
  state.queueKey = "queue:" + data.router + ":" + data.kernel + ":" + data.feed_label;
  if (!state.restored) {
    const saved = readStorage(sessionStorage, state.queueKey, []);
    if (Array.isArray(saved)) state.selected = new Set(saved.filter((name) => typeof name === "string"));
    state.restored = true;
  }
  state.selected.forEach((name) => {
    const pkg = state.packages.get(name);
    if (!pkg?.available || pkg.installed) state.selected.delete(name);
  });
  saveQueue();
  el("feed-total").textContent = data.packages.filter((pkg) => pkg.available).length;
  el("feed-label").textContent = data.feed_label;
  el("installed-total").textContent = data.packages.filter((pkg) => pkg.installed).length;
  const storage = data.resources?.storage;
  el("storage-free").textContent = storage ? bytes(storage.free) : "Unavailable";
  el("storage-label").textContent = storage ? "free writable storage" : "storage reading unavailable";
  el("storage-free").title = storage ? bytes(storage.total) + " total overlay storage" : "";
  el("kernel").textContent = "Linux " + data.kernel.split("~")[0];
  el("kernel").title = data.kernel;
  const memory = data.resources?.memory;
  el("memory-free").textContent = memory?.available
    ? bytes(memory.available) + " RAM available" : "Matched to your firmware";
  el("last-checked").textContent = "Checked " + new Date(data.checked_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el("open-router").href = routerUrl();
  el("open-router").hidden = false;
  if (data.job) state.job = data.job;
  setConnection(data.connected, data.connected ? data.router : "Router disconnected");
  renderFilters();
  renderCatalog();
  renderQueue();
}
function showDetails(name) {
  const pkg = state.packages.get(name);
  state.detail = name;
  el("detail-title").textContent = pkg.title || name;
  el("detail-name").textContent = name;
  el("detail-category").textContent = categories[pkg.category][0];
  el("detail-description").textContent = pkg.description;
  const rows = [
    ["Version", pkg.version], ["Status", pkg.installed ? "Installed · " + pkg.installed : "Available"],
    ["Installed size", bytes(pkg.size)], ["Download size", bytes(pkg.download)],
    ["Architecture", pkg.arch || "—"], ["License", pkg.license || "—"],
  ];
  el("detail-metadata").replaceChildren(...rows.map(([key, value]) => {
    const entry = makeElement("div");
    entry.append(makeElement("dt", key), makeElement("dd", value));
    return entry;
  }));
  const note = featured[name]?.note || "";
  el("detail-note").textContent = note;
  el("detail-note").hidden = !note;
  el("dependencies").replaceChildren(...pkg.depends.map((dependency) => {
    const dependencyName = dependency.split(/[<>=~]/)[0];
    const installed = !!state.packages.get(dependencyName)?.installed;
    const item = makeElement("li", dependency + (installed ? " ✓" : ""));
    item.dataset.installed = String(installed);
    if (installed) item.title = "Already installed";
    return item;
  }));
  el("detail-dependencies").hidden = !pkg.depends.length;
  el("upstream").hidden = true;
  try {
    const link = new URL(pkg.url);
    if (["https:", "http:"].includes(link.protocol)) {
      el("upstream").href = link.href;
      el("upstream").hidden = false;
    }
  } catch { /* Some package recipes provide no website. */ }
  const update = hasUpdateCandidate(pkg);
  el("detail-add").textContent = update ? "Review update" : pkg.installed ? "Installed"
    : state.selected.has(name) ? "Remove from queue" : "Add to queue";
  el("detail-add").disabled = (!!pkg.installed && !update) || !pkg.available || running() || !state.online;
  if (!details.open) details.showModal();
}
function transactionOutput(output, expanded) {
  const log = el("transaction-output");
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 25;
  el("transaction-details").hidden = !output;
  if (expanded !== undefined) el("transaction-details").open = expanded;
  log.textContent = output || "";
  if (atEnd) log.scrollTop = log.scrollHeight;
}
function step(current) {
  for (const name of ["review", "install", "done"]) {
    const element = el("step-" + name);
    if (name === current) element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
  }
}
function setBusy(busy) {
  state.busy = busy;
  el("confirm-install").disabled = busy;
  el("close-review").disabled = busy;
  el("back").disabled = busy;
  setConnection(state.online, el("connection").lastElementChild.textContent);
  renderQueue();
  renderCatalog();
}
function resetReview() {
  el("review-packages").replaceChildren();
  el("planned-changes").replaceChildren();
  for (const id of ["planned-changes", "review-summary", "next-steps", "confirm-install", "install-progress"]) el(id).hidden = true;
  el("back").textContent = "Back to packages";
  transactionOutput("", false);
}
async function reviewChanges(upgradeName) {
  if (state.busy || running()) return;
  state.preview = null;
  resetReview();
  step("review");
  el("review-title").textContent = upgradeName ? "Review package update" : "Review changes";
  el("confirm-install").textContent = upgradeName ? "Update package" : "Install packages";
  el("review-message").textContent = "Checking dependencies and available storage on your router…";
  setBusy(true);
  dialog.showModal();
  try {
    const request = upgradeName ? { names: [upgradeName], upgrade: true } : { names: [...state.selected] };
    state.preview = await api("preview", request);
    updateCatalog(state.preview.catalog);
    el("review-message").textContent = upgradeName
      ? "Review the selected version and any changes to its dependencies."
      : "Your selection and the dependencies APK will install.";
    el("review-packages").replaceChildren(...state.preview.names.map((name) => makeElement("li", name)));
    const changes = state.preview.changes;
    el("planned-changes").replaceChildren(...changes.map((change) => {
      const item = makeElement("li");
      item.append(makeElement("span", change.action), makeElement("code", change.name),
        makeElement("small", change.requested ? "Selected" : "Dependency"));
      return item;
    }));
    el("planned-changes").hidden = !changes.length;
    const storage = state.preview.storage;
    el("review-summary").hidden = false;
    el("review-summary").textContent = changes.length + " package changes · " + bytes(state.preview.size)
      + " estimated added storage" + (storage ? "\n" + bytes(storage.free) + " free on your router" : "");
    if (storage && state.preview.size > storage.free) {
      el("review-summary").textContent += "\nThe estimate exceeds the current free storage.";
    }
    transactionOutput(state.preview.output, !changes.length);
    el("confirm-install").hidden = false;
  } catch (error) {
    el("review-title").textContent = upgradeName ? "Unable to prepare package update" : "Unable to prepare installation";
    el("review-message").textContent = error.message;
    transactionOutput(error.output, true);
    if (error.status === 503) setConnection(false, "Router disconnected");
  } finally {
    setBusy(false);
    el("back").focus();
  }
}
function nextSteps(names) {
  const container = el("next-steps");
  container.replaceChildren();
  const configured = names.filter((name) => featured[name]?.path || featured[name]?.note);
  container.hidden = !configured.length;
  if (!configured.length) return;
  container.append(makeElement("h3", "Set up your new features"));
  for (const name of configured) {
    const feature = featured[name];
    const row = makeElement("p");
    if (feature.note) row.append(feature.note + " ");
    if (feature.path) {
      const link = makeElement("a", feature.label + " ↗");
      link.href = routerUrl(feature.path);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(link);
    }
    container.append(row);
  }
}
function displayJob() {
  if (!state.job) return;
  const job = state.job;
  const active = job.state === "running";
  step(active ? "install" : "done");
  el("review-title").textContent = job.state === "unverified" ? "Check installed package versions" : job.upgrade
    ? active ? "Updating your package" : job.success ? "Package updated" : "Package update needs attention"
    : active ? "Installing your packages" : job.success ? "Installation complete" : "Installation needs attention";
  el("review-message").textContent = active ? "You can keep browsing. Keep the WSL terminal open while installation runs." : job.message;
  el("back").textContent = active ? "Keep browsing" : "Done";
  el("confirm-install").hidden = true;
  el("planned-changes").hidden = true;
  el("review-summary").hidden = true;
  el("review-packages").replaceChildren(...job.names.map((name) => makeElement("li", name)));
  el("install-progress").hidden = !active;
  const progress = [...job.output.matchAll(/\(\s*(\d+)\/\s*(\d+)\) ([^\n]+)/g)].at(-1);
  el("progress").removeAttribute("value");
  if (progress) {
    el("progress").max = Number(progress[2]);
    el("progress").value = Number(progress[1]);
    el("progress-label").textContent = progress[1] + " of " + progress[2] + " · " + progress[3];
  } else {
    el("progress-label").textContent = "Contacting the package manager…";
  }
  transactionOutput(job.output);
  el("next-steps").hidden = true;
  if (!active && job.success) nextSteps(job.names);
  renderQueue();
  setConnection(state.online, el("connection").lastElementChild.textContent);
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (running() && !state.closed) state.pollTimer = setTimeout(pollJob, 700);
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function refreshCatalogAfterJob() {
  const jobId = state.job.id;
  for (const interval of [0, 350, 700]) {
    if (interval) await delay(interval);
    if (state.closed || state.job?.id !== jobId) return;
    try {
      const catalog = await api("catalog");
      if (state.closed || state.job?.id !== jobId) return;
      updateCatalog(catalog);
      showNotice(state.job.message, state.job.success !== true);
      return;
    } catch {
      // A completed job no longer polls, so catalog recovery has its own retries.
    }
  }
  if (!state.closed && state.job?.id === jobId) {
    setConnection(false, "Catalog needs refresh");
    showNotice("Installation status is available. Select Refresh to check the package list.", true);
  }
}
async function pollJob() {
  try {
    const job = await api("job");
    if (job) {
      state.job = job;
      displayJob();
      if (!running()) await refreshCatalogAfterJob();
    }
  } catch (error) {
    showNotice(error.message + " Rechecking installation status…", true);
  }
  schedulePoll();
}
async function findSubmittedJob(previewId) {
  for (const interval of [0, 350, 700, 1400]) {
    if (interval) await delay(interval);
    try {
      const job = await api("job");
      if (job?.preview_id === previewId) return job;
    } catch {
      // Reconcile the submitted preview with read-only status. Never resend it.
    }
  }
  return null;
}
async function installSelection() {
  if (!state.preview || state.busy) return;
  const previewId = state.preview.id;
  state.preview = null;
  setBusy(true);
  el("review-message").textContent = "Checking the reviewed plan before installation…";
  try {
    let job;
    try {
      job = await api("install", { id: previewId });
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        el("review-title").textContent = "Review the queue again";
        el("review-message").textContent = error.message;
        el("confirm-install").hidden = true;
        return;
      }
      state.submittedPreview = previewId;
      el("review-message").textContent = "Checking whether the submitted installation started…";
      job = await findSubmittedJob(previewId);
      if (!job) {
        el("review-title").textContent = "Check installation status";
        el("review-message").textContent = "The response was interrupted. Select Refresh before reviewing another installation.";
        el("confirm-install").hidden = true;
        setConnection(false, "Installation status unknown");
        return;
      }
    }
    state.submittedPreview = null;
    state.job = job;
    displayJob();
    if (running()) schedulePoll();
    else await refreshCatalogAfterJob();
  } finally {
    setBusy(false);
    el("back").focus();
  }
}
el("search").addEventListener("input", () => {
  if (state.view === "featured" && el("search").value.trim()) {
    state.view = "all";
    renderFilters();
  }
  state.page = 0;
  renderCatalog();
});
el("clear").addEventListener("click", () => {
  state.selected.clear();
  saveQueue();
  renderQueue();
  renderCatalog();
  el("search").focus();
});
el("mobile-filter").addEventListener("change", () => {
  state.view = el("mobile-filter").value;
  el("search").value = "";
  state.page = 0;
  renderFilters();
  renderCatalog();
});
const queuePanel = document.querySelector(".queue");
const mainArea = document.querySelector(".main-area");
new ResizeObserver(() => {
  const height = Math.ceil(queuePanel.getBoundingClientRect().height);
  mainArea.style.setProperty("--mobile-queue-height", height + "px");
}).observe(queuePanel, { box: "border-box" });
el("toggle-queue").addEventListener("click", () => {
  const expanded = el("toggle-queue").getAttribute("aria-expanded") !== "true";
  el("toggle-queue").setAttribute("aria-expanded", String(expanded));
  el("toggle-queue").textContent = expanded ? "Hide selection" : "Show selection";
  document.querySelector(".queue").dataset.expanded = String(expanded);
});
el("theme").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  preferences.theme = theme;
  writeStorage(localStorage, "jidu-preferences", preferences);
  el("theme").setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " theme");
});
el("layout").addEventListener("click", () => {
  const compact = el("packages").dataset.layout !== "list";
  el("packages").dataset.layout = compact ? "list" : "grid";
  el("layout").setAttribute("aria-pressed", String(compact));
  el("layout").setAttribute("aria-label", compact ? "Use package cards" : "Use compact list");
  preferences.layout = compact ? "list" : "grid";
  writeStorage(localStorage, "jidu-preferences", preferences);
});
el("sort").addEventListener("change", () => {
  preferences.sort = el("sort").value;
  writeStorage(localStorage, "jidu-preferences", preferences);
  state.page = 0;
  renderCatalog();
});
for (const [id, direction] of [["previous", -1], ["next", 1]]) {
  el(id).addEventListener("click", () => {
    state.page += direction;
    renderCatalog();
    el("catalog-title").scrollIntoView({ block: "nearest" });
    if (el(id).disabled) el(direction === 1 ? "previous" : "next").focus({ preventScroll: true });
  });
}
el("close-detail").addEventListener("click", () => details.close());
el("detail-add").addEventListener("click", () => {
  if (hasUpdateCandidate(state.packages.get(state.detail))) {
    details.close();
    reviewChanges(state.detail);
    return;
  }
  toggleSelection(state.detail);
  showDetails(state.detail);
});
for (const id of ["back", "close-review"]) el(id).addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", (event) => { if (state.busy) event.preventDefault(); });
dialog.addEventListener("close", () => { if (el("review").disabled) el("search").focus(); });
el("review").addEventListener("click", () => reviewChanges());
el("confirm-install").addEventListener("click", installSelection);
el("show-job").addEventListener("click", () => {
  resetReview();
  displayJob();
  dialog.showModal();
});
el("download-log").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([el("transaction-output").textContent], { type: "text/plain" }));
  const link = makeElement("a");
  link.href = url;
  link.download = "jidu6111-installation.log";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el("refresh").addEventListener("click", async () => {
  if (state.busy || running()) return;
  setBusy(true);
  try {
    if (state.submittedPreview) {
      const job = await api("job");
      if (job?.preview_id === state.submittedPreview) {
        state.submittedPreview = null;
        state.job = job;
        displayJob();
        if (running()) {
          schedulePoll();
          return;
        }
      }
    }
    const previous = state.job;
    updateCatalog(await api("refresh", {}));
    state.submittedPreview = null;
    if (state.job && (state.job !== previous || previous?.state === "unverified")) {
      displayJob();
    }
    if (previous?.state === "unverified" && state.job?.state === "finished") {
      showNotice(state.job.message, state.job.success !== true);
    } else {
      showNotice("Router status refreshed.");
    }
  } catch (error) {
    setConnection(false, "Router disconnected");
    showNotice(error.message, true);
  } finally { setBusy(false); }
});
el("close-session").addEventListener("click", async () => {
  el("close-session").disabled = true;
  try {
    await api("close", {});
    state.closed = true;
    writeStorage(sessionStorage, "dashboard-token", "");
    setConnection(false, "Session ended");
    showNotice("Session ended. You can close this tab.");
    renderCatalog();
    renderQueue();
  } catch (error) {
    showNotice(error.message, true);
    el("close-session").disabled = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !dialog.open && !details.open && state.data && !event.target.matches("input, textarea, select")) {
    event.preventDefault();
    el("search").focus();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (running()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
api("catalog").then((data) => {
  updateCatalog(data);
  if (running()) {
    displayJob();
    schedulePoll();
    showNotice("Your installation is still running. Select View progress to follow it.");
  }
}).catch((error) => {
  setConnection(false, "Disconnected");
  showNotice(error.message, true);
  el("packages").firstElementChild.textContent = "Open the dashboard URL from the WSL terminal.";
});
