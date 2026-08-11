/* Scope IQ — vanilla JS front end. No framework, no build step, no CDN.
   All dashboard numbers are computed here, in code, from the extracted lines
   the server returns. The model never totals anything. */

"use strict";

/* ------------------------------------------------------------------ state */

const S = {
  tab: "scope",            // scope | decision
  chart: "division",       // division | resp | coverage
  open: null,              // expanded row id
  citeId: null,            // row whose citation is on screen
  page: 1,
  zoom: 100,
  wide: false,
  viewer: false,
  search: "",
  fDiv: null, fResp: null, fMatch: null, fReview: false, fStatus: null,
  sortAsc: true,
  server: null,            // last /state payload
  reveal: 999,             // rows revealed (cascade after processing)
  lastDocId: null,
  scrollPending: false,
  showWarnings: false,
};

let pollTimer = null;
let revealTimer = null;

/* ------------------------------------------------------------ tiny helpers */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DIVCOLORS = ["#0F4C7C", "#186CAC", "#3C8CC4", "#6BA9D4", "#9CC6E4", "#C7DCEC"];
const RESPCOLORS = { Landlord: "#0F4C7C", Tenant: "#FE9900", Unclear: "#B9C3CC" };
const GROUPCOLORS = { document: "#186CAC", crm: "#3C8CC4", derived: "#9CC6E4", human: "#C9CFD6" };

function lines() {
  const r = S.server && S.server.result;
  return r ? r.lines : [];
}
function docInfo() {
  const r = S.server && S.server.result;
  return r ? r.doc : null;
}
function divLabel(l) { return (l.div || "??") + " " + (l.division || "Unknown"); }
function matchState(l) { return l.match ? l.match.state : "no match"; }
function respChip(r) {
  const cls = r === "Landlord" ? "landlord" : (r === "Tenant" ? "tenant" : "unclear");
  return `<span class="chip ${cls}">${esc(r)}</span>`;
}
function statusChip(st) {
  const cls = st === "VERIFIED" ? "verified" : (st === "NEEDS REVIEW" ? "review" : "excluded");
  return `<span class="chip ${cls}">${esc(st)}</span>`;
}
function csiDisplay(l) { return l.csi || (l.csi_raw ? l.csi_raw : "&#8212;"); }
function sortKey(l) { return l.csi || "99 99 99"; }

/* --------------------------------------------------------------- polling */

async function fetchState() {
  try {
    const res = await fetch("/state");
    const data = await res.json();
    const prevMode = S.server ? S.server.mode : "starting";
    S.server = data;

    const doc = docInfo();
    if (doc && doc.id !== S.lastDocId) {
      S.lastDocId = doc.id;
      S.open = null; S.citeId = null; S.viewer = false;
      S.fDiv = S.fResp = S.fMatch = S.fStatus = null; S.fReview = false; S.search = "";
      S.page = 1;
      if (prevMode === "processing" || prevMode === "starting") startReveal();
      else S.reveal = 999;
    }
    render();
    schedulePoll();
  } catch (e) {
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const mode = S.server ? S.server.mode : "starting";
  const ms = (mode === "processing" || mode === "starting") ? 650 : 5000;
  pollTimer = setTimeout(fetchState, ms);
}

function startReveal() {
  clearInterval(revealTimer);
  S.reveal = 0;
  revealTimer = setInterval(() => {
    S.reveal += 1;
    if (S.reveal >= lines().length) { S.reveal = 999; clearInterval(revealTimer); }
    render();
  }, 34);
}

/* ---------------------------------------------------------------- actions */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;

  if (a === "tab") { S.tab = el.dataset.tab; render(); }
  else if (a === "reset") { doReset(); }
  else if (a === "chart") { S.chart = el.dataset.chart; render(); }
  else if (a === "filter-div") { const v = el.dataset.value; S.fDiv = (S.fDiv === v ? null : v); S.fReview = false; render(); }
  else if (a === "filter-resp") { const v = el.dataset.value; S.fResp = (S.fResp === v ? null : v); S.fReview = false; render(); }
  else if (a === "filter-match") { const v = el.dataset.value; S.fMatch = (S.fMatch === v ? null : v); S.fReview = false; render(); }
  else if (a === "filter-review") { S.fReview = !S.fReview; S.fDiv = S.fResp = S.fMatch = null; render(); }
  else if (a === "clear-filters") { S.fDiv = S.fResp = S.fMatch = S.fStatus = null; S.fReview = false; S.search = ""; render(); }
  else if (a === "clear-one") {
    const k = el.dataset.key;
    if (k === "div") S.fDiv = null; if (k === "resp") S.fResp = null;
    if (k === "match") S.fMatch = null; if (k === "review") S.fReview = false;
    if (k === "status") S.fStatus = null;
    render();
  }
  else if (a === "toggle-sort") { S.sortAsc = !S.sortAsc; render(); }
  else if (a === "toggle-row") { const id = el.dataset.id; S.open = (S.open === id ? null : id); render(); }
  else if (a === "open-source") {
    e.stopPropagation();
    const l = lines().find(x => x.id === el.dataset.id);
    if (l) { S.viewer = true; S.citeId = l.id; S.page = l.page; S.scrollPending = true; render(); }
  }
  else if (a === "close-viewer") { S.viewer = false; S.citeId = null; render(); }
  else if (a === "zoom-in") { S.zoom = Math.min(300, S.zoom + 25); render(); }
  else if (a === "zoom-out") { S.zoom = Math.max(50, S.zoom - 25); render(); }
  else if (a === "fit-width") { fitWidth(); }
  else if (a === "toggle-wide") { S.wide = !S.wide; render(); }
  else if (a === "page-prev") { S.page = Math.max(1, S.page - 1); render(); }
  else if (a === "page-next") { const d = docInfo(); S.page = Math.min(d ? d.pages : 1, S.page + 1); render(); }
  else if (a === "pick-file") { $("#file-input").click(); }
  else if (a === "toggle-warnings") { S.showWarnings = !S.showWarnings; render(); }
});

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-select]");
  if (!el) return;
  const k = el.dataset.select, v = el.value || null;
  if (k === "div") S.fDiv = v;
  if (k === "resp") S.fResp = v;
  if (k === "status") { S.fStatus = v; S.fReview = false; }
  if (k === "match") S.fMatch = v;
  render();
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search-input") { S.search = e.target.value; render(true); }
});

async function doReset() {
  if (!confirm("Clear the cached model responses, drop uploads and re-run the sample live?")) return;
  await fetch("/reset", { method: "POST" });
  S.lastDocId = null;
  fetchState();
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/upload", { method: "POST", body: fd });
  const out = await res.json();
  if (!out.ok) alert(out.error || "upload failed");
  fetchState();
}

/* drag & drop: the whole intake bar is a target; window swallows strays */
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const bar = e.target.closest && e.target.closest("#intake-bar");
  if (bar && e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});

function fitWidth() {
  const box = $("#pages-box");
  if (!box) { S.zoom = 100; render(); return; }
  const d = docInfo();
  const size = d && d.page_sizes && d.page_sizes[S.page - 1];
  const aspectW = 640; // display width at 100%
  const target = box.clientWidth - 48;
  S.zoom = Math.max(50, Math.min(300, Math.round(target / aspectW * 100)));
  render();
}

/* ---------------------------------------------------------------- render */

function render(keepFocus) {
  const focusedId = document.activeElement && document.activeElement.id;
  const selStart = focusedId === "search-input" ? document.activeElement.selectionStart : null;

  $("#tab-decision").classList.toggle("active", S.tab === "decision");
  $("#tab-scope").classList.toggle("active", S.tab === "scope");
  $("#pipe-scope").classList.toggle("on", S.tab === "scope");
  const d = docInfo();
  $("#project-chip").textContent = d ? d.name.replace(/^u\d+-/, "") : "loading…";

  $("#view").innerHTML = S.tab === "decision" ? renderDecision() : renderScope();

  if (focusedId === "search-input") {
    const inp = $("#search-input");
    if (inp) { inp.focus(); if (selStart != null) inp.setSelectionRange(selStart, selStart); }
  }
  if (S.viewer && S.scrollPending) scrollToHighlight();
}

/* ------------------------------------------------------------ scope page */

function renderScope() {
  const mode = S.server ? S.server.mode : "starting";
  return `
  <main style="flex:1;min-height:0;display:flex;flex-direction:column;padding:14px 24px 18px;gap:12px;overflow:hidden">
    ${renderIntake(mode)}
    ${mode === "idle" && lines().length ? renderDashboard() : ""}
    ${mode === "idle" && lines().length ? renderTableSection() : ""}
  </main>`;
}

function renderIntake(mode) {
  const d = docInfo();
  const server = S.server || {};
  const warnings = (server.result && server.result.warnings) || [];
  const provenance = server.result ? server.result.provenance : "";

  let inner = "";
  if (mode === "processing" || mode === "starting") {
    const stages = server.stages || [];
    const cur = server.stage != null ? server.stage : -1;
    const pills = stages.map((n, i) => {
      const done = i < cur, act = i === cur;
      const bg = done ? "var(--ok-bg)" : (act ? "#FFF6E8" : "#FBFCFD");
      const bd = done ? "var(--ok-bd)" : (act ? "#F0DCBB" : "var(--border)");
      const fg = done ? "var(--ok)" : (act ? "var(--warn-deep)" : "var(--faint)");
      const mark = done ? "&#10003;" : (act ? "&#9684;" : "&#9675;");
      return `<div style="display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;
        border:1px solid ${bd};background:${bg};color:${fg};font-weight:600">
        <span style="font-size:11px">${mark}</span><span style="font-size:11.5px;white-space:nowrap">${esc(n)}</span></div>`;
    }).join("");
    inner = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="width:9px;height:9px;border-radius:5px;background:var(--accent);animation:siqPulse 1.1s ease-in-out infinite"></span>
          <span style="font-size:13.5px;font-weight:600">${esc(mode === "starting" ? "Analyzing the sample specification" : "Processing upload")}</span>
          <span style="font-size:12px;color:var(--dim)">${esc(server.stage_detail || "")}</span>
          <span style="flex:1"></span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${pills}</div>
      </div>`;
  } else if (mode === "blocked" || mode === "error") {
    const title = mode === "blocked" ? "This PDF has no text layer — it looks scanned."
                                     : "The analysis failed.";
    inner = `
      <div style="display:flex;align-items:flex-start;gap:12px;background:var(--warn-bg);border:1px solid var(--warn-bd);border-radius:10px;padding:13px 15px">
        <span style="font-size:14px;color:var(--warn);line-height:1.3">&#9888;</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--warn-deep);margin-bottom:3px">${esc(title)}</div>
          <div style="font-size:12.5px;color:var(--dim)">${esc(server.error || "")}</div>
        </div>
        <button data-action="reset" style="background:#FFF;border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:12px;color:var(--dim);cursor:pointer">Back to sample</button>
      </div>`;
  } else {
    const nm = d ? d.name.replace(/^u\d+-/, "") : "";
    const meta = d ? `${d.pages} pages${d.converted ? " · converted from Word" : ""}` : "";
    const prov = provenance === "live"
      ? `<span class="chip verified">LIVE RUN</span>`
      : `<span class="chip unclear" title="Served from the response cache; a real call ran earlier">CACHED</span>`;
    inner = `
      <div style="display:flex;align-items:center;gap:16px">
        <button data-action="pick-file" style="display:inline-flex;align-items:center;gap:10px;padding:10px 16px;background:var(--brand);border:1px solid var(--brand);border-radius:9px;color:#fff;font-size:13.5px;font-weight:600;cursor:pointer">
          <span style="font-size:15px;line-height:1">&#8593;</span>Upload specification
        </button>
        <input type="file" id="file-input" accept=".pdf,.docx,.doc" style="display:none"
          onchange="if(this.files.length)uploadFile(this.files[0])">
        <div style="display:flex;flex-direction:column;gap:2px;border-left:1px solid var(--border);padding-left:16px">
          <span style="font-size:11px;color:var(--faint);letter-spacing:.4px">.docx or .pdf &#183; drag anywhere in this bar</span>
          <span style="font-size:13.5px;font-weight:600">${esc(nm)}${d && d.converted ? ` &#8594; ${esc(d.pdf_name)}` : ""}</span>
        </div>
        <span style="font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums">${esc(meta)}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;background:var(--ok-bg);border:1px solid var(--ok-bd);color:var(--ok);border-radius:999px;padding:4px 11px;font-size:11.5px;font-weight:600">Analysis complete</span>
        ${prov}
        ${warnings.length ? `<button data-action="toggle-warnings" style="background:transparent;border:1px solid var(--warn-bd);color:var(--warn-deep);border-radius:999px;padding:4px 11px;font-size:11.5px;font-weight:600;cursor:pointer">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</button>` : ""}
        <span style="flex:1"></span>
        <button data-action="reset" style="background:transparent;border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--dim);font-size:12px;cursor:pointer">Run live</button>
      </div>
      ${S.showWarnings && warnings.length ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px;display:flex;flex-direction:column;gap:3px">${warnings.map(w => `<span style="font-size:11.5px;color:var(--warn-deep)">&#9888; ${esc(w)}</span>`).join("")}</div>` : ""}`;
  }
  return `<section id="intake-bar" class="card" style="flex:none;padding:14px 16px">${inner}</section>`;
}

/* rollups — deterministic, over revealed lines */
function rollups() {
  const all = lines();
  const revealed = S.reveal >= all.length ? all : all.slice(0, S.reveal);
  const divCounts = {}, respCounts = { Landlord: 0, Tenant: 0, Unclear: 0 }, matchCounts = {};
  revealed.forEach(l => {
    const k = divLabel(l);
    divCounts[k] = (divCounts[k] || 0) + 1;
    respCounts[l.resp] = (respCounts[l.resp] || 0) + 1;
    const m = matchState(l);
    matchCounts[m] = (matchCounts[m] || 0) + 1;
  });
  const ranked = Object.keys(divCounts).sort((a, b) => divCounts[b] - divCounts[a] || a.localeCompare(b));
  return { revealed, divCounts, respCounts, matchCounts, ranked,
           reviewCount: revealed.filter(l => l.status === "NEEDS REVIEW").length };
}

function filteredRows(R) {
  const q = S.search.trim().toLowerCase();
  const top6 = R.ranked.slice(0, 6);
  let rows = R.revealed.filter(l => {
    if (S.fDiv === "__other" && top6.indexOf(divLabel(l)) !== -1) return false;
    if (S.fDiv && S.fDiv !== "__other" && divLabel(l) !== S.fDiv) return false;
    if (S.fResp && l.resp !== S.fResp) return false;
    if (S.fMatch && matchState(l) !== S.fMatch) return false;
    if (S.fReview && l.status !== "NEEDS REVIEW") return false;
    if (S.fStatus && l.status !== S.fStatus) return false;
    if (q && ((l.csi || "") + " " + l.summary + " " + l.quote + " " + l.division).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1) * (S.sortAsc ? 1 : -1));
  return rows;
}

function renderDashboard() {
  const R = rollups();
  const total = R.revealed.length;
  const rows = filteredRows(R);
  const filtersOn = !!(S.fDiv || S.fResp || S.fMatch || S.fReview);

  const tile = (active, warn) =>
    `display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:5px;text-align:left;overflow:hidden;min-height:0;` +
    `background:${warn ? "#FDF9F2" : "#FFF"};border:1px solid ${active ? "var(--tint-bd)" : (warn ? "var(--warn-bd)" : "var(--border)")};` +
    `border-radius:12px;padding:12px 14px;cursor:pointer;box-shadow:${active ? "0 0 0 3px var(--tint)" : "none"}`;

  const respTiles = ["Landlord", "Tenant", "Unclear"].map(r => `
    <button data-action="filter-resp" data-value="${r}" style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:5px;
      background:${S.fResp === r ? "var(--tint)" : "#FBFCFD"};border:1px solid ${S.fResp === r ? "var(--tint-bd)" : "#EDF1F5"};border-radius:8px;padding:7px 8px;cursor:pointer">
      <span style="font-size:22px;font-weight:700;line-height:1;letter-spacing:-.5px;font-variant-numeric:tabular-nums">${R.respCounts[r] || 0}</span>
      <span style="display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dim);white-space:nowrap">
        <span style="width:7px;height:7px;border-radius:2px;flex:none;background:${RESPCOLORS[r]}"></span>${r}</span>
    </button>`).join("");

  const chartTabs = [["division", "By division"], ["resp", "Who pays"], ["coverage", "Coverage"]].map(([k, n]) => `
    <button data-action="chart" data-chart="${k}" style="padding:5px 10px;border:none;border-radius:6px;font-size:11.5px;font-weight:600;cursor:pointer;
      background:${S.chart === k ? "#FFF" : "transparent"};color:${S.chart === k ? "var(--brand-deep)" : "var(--dim)"};
      box-shadow:${S.chart === k ? "0 1px 2px rgba(26,37,48,.12)" : "none"}">${n}</button>`).join("");

  const chartTitle = S.chart === "division" ? "Scope by CSI division" : (S.chart === "resp" ? "Who pays, by division" : "Catalogue coverage");
  const chartSub = S.chart === "division"
    ? "Share of scope lines, not of cost — no prices exist at this stage."
    : (S.chart === "resp" ? "Extracted from the &#8220;shall&#8221; subject in each verified sentence, never inferred."
                          : "Outcome of the CSI hard filter, then semantic ranking. Click a bar to filter.");

  return `
  <section style="flex:none;display:grid;grid-template-columns:minmax(330px,1fr) minmax(520px,1.35fr);gap:12px;height:276px">
    <div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px">
      <button data-action="clear-filters" style="${tile(!filtersOn, false)}">
        <span class="klabel">SCOPE LINES</span>
        <span style="font-size:34px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1">${total}</span>
        <span style="font-size:11.5px;color:var(--dim)">${filtersOn ? rows.length + " shown under current filters" : "extracted, each with a quote"}</span>
      </button>
      <button data-action="clear-filters" style="${tile(false, false)}">
        <span class="klabel">DIVISIONS TOUCHED</span>
        <span style="font-size:34px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1">${R.ranked.length}</span>
        <span style="font-size:11.5px;color:var(--dim)">CSI MasterFormat 2020</span>
      </button>
      <div class="card" style="padding:12px 14px;display:flex;flex-direction:column;justify-content:center;gap:8px;overflow:hidden;min-height:0">
        <span class="klabel">WHO PAYS</span>
        <div style="display:flex;gap:6px">${respTiles}</div>
      </div>
      <button data-action="filter-review" style="${tile(S.fReview, true)}">
        <span class="klabel" style="color:var(--warn)">NEEDS REVIEW</span>
        <span style="font-size:34px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1;color:var(--warn)">${R.reviewCount}</span>
        <span style="font-size:11.5px;color:var(--warn-deep)">unverified quote or ambiguous code</span>
      </button>
    </div>
    <div class="card" style="padding:14px 16px 12px;display:flex;flex-direction:column;min-width:0">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700">${chartTitle}</div>
          <div style="font-size:11.5px;color:var(--dim)">${chartSub}</div>
        </div>
        <div style="display:flex;gap:2px;background:#F2F5F8;border:1px solid var(--border);border-radius:8px;padding:2px;flex:none">${chartTabs}</div>
      </div>
      ${S.chart === "division" ? renderDonut(R, total) : (S.chart === "resp" ? renderRespBars(R) : renderCoverage(R))}
    </div>
  </section>
  ${renderTable(R, rows, total)}`;
}

function divisionSegs(R) {
  const top = R.ranked.slice(0, 6);
  const segs = top.map(k => ({ key: k, num: k.slice(0, 2), name: k.slice(3), count: R.divCounts[k] }));
  const rest = R.ranked.slice(6);
  const restCount = rest.reduce((n, k) => n + R.divCounts[k], 0);
  if (restCount) segs.push({ key: "__other", num: "&#183;&#183;", name: `Other divisions (${rest.length})`, count: restCount });
  segs.sort((a, b) => b.count - a.count || String(a.num).localeCompare(String(b.num)));
  return segs;
}

function renderDonut(R, total) {
  const segs = divisionSegs(R);
  const C = 2 * Math.PI * 62;
  let acc = 0;
  const circles = segs.map((g, i) => {
    const frac = total ? g.count / total : 0;
    const len = Math.max(0, frac * C - 2.5);
    const off = -acc * C;
    acc += frac;
    const active = S.fDiv === g.key;
    const dim = S.fDiv && !active;
    return `<circle cx="80" cy="80" r="62" fill="none" stroke="${DIVCOLORS[i % DIVCOLORS.length]}"
      stroke-width="${active ? 24 : 18}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${off}"
      opacity="${dim ? 0.35 : 1}" data-action="filter-div" data-value="${esc(g.key)}"
      style="cursor:pointer;transition:stroke-width .2s ease,opacity .2s ease"></circle>`;
  }).join("");
  const legend = segs.map((g, i) => {
    const active = S.fDiv === g.key;
    return `<button data-action="filter-div" data-value="${esc(g.key)}" style="display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:6px;
      border:1px solid ${active ? "var(--tint-bd)" : "transparent"};background:${active ? "var(--tint)" : "transparent"};cursor:pointer;min-width:0;text-align:left;width:100%">
      <span style="width:8px;height:8px;border-radius:2px;flex:none;background:${DIVCOLORS[i % DIVCOLORS.length]}"></span>
      <span class="mono" style="font-size:11.5px;font-weight:700;color:var(--brand);flex:none">${g.num}</span>
      <span style="color:#C3CCD4;flex:none">&#8211;</span>
      <span style="flex:1;text-align:left;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(g.name)}</span>
      <span style="font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;flex:none">${g.count}</span>
      <span style="font-size:10.5px;color:#B4BEC7;flex:none;width:34px;text-align:right;font-variant-numeric:tabular-nums">${total ? Math.round(g.count / total * 100) : 0}%</span>
    </button>`;
  }).join("");
  return `
  <div style="flex:1;display:flex;align-items:center;gap:22px;min-height:0">
    <div style="position:relative;width:152px;height:152px;flex:none">
      <svg viewBox="0 0 160 160" style="width:152px;height:152px;transform:rotate(-90deg)">${circles}</svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none">
        <span style="font-size:26px;font-weight:700;letter-spacing:-.8px;font-variant-numeric:tabular-nums;line-height:1">${total}</span>
        <span style="font-size:10px;letter-spacing:.7px;color:var(--faint);font-weight:700">LINES</span>
      </div>
    </div>
    <div class="siq-scroll" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;max-height:210px;overflow:auto">${legend}</div>
  </div>`;
}

function renderRespBars(R) {
  const segs = divisionSegs(R);
  const top6 = R.ranked.slice(0, 6);
  const bars = segs.map(g => {
    const ls = g.key === "__other"
      ? R.revealed.filter(l => top6.indexOf(divLabel(l)) === -1)
      : R.revealed.filter(l => divLabel(l) === g.key);
    const parts = ["Landlord", "Tenant", "Unclear"]
      .map(r => ({ r, n: ls.filter(l => l.resp === r).length }))
      .filter(p => p.n > 0);
    const cells = parts.map(p => `
      <button data-action="filter-resp" data-value="${p.r}" title="${p.r}: ${p.n} line${p.n === 1 ? "" : "s"} in ${g.num} &#8211; ${esc(g.name)}"
        style="flex:${p.n};background:${RESPCOLORS[p.r]};border:none;padding:0;cursor:pointer;transition:opacity .2s ease;
        opacity:${S.fResp && S.fResp !== p.r ? ".3" : "1"}"></button>`).join("");
    return `
    <div style="display:flex;align-items:center;gap:10px">
      <span style="width:132px;flex:none;display:flex;align-items:baseline;gap:5px;font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden">
        <span class="mono" style="font-size:11px;font-weight:700;color:var(--brand)">${g.num}</span>
        <span style="color:#C3CCD4">&#8211;</span>
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(g.name)}</span></span>
      <div style="flex:1;display:flex;height:16px;border-radius:4px;overflow:hidden;background:#F2F5F8">${cells}</div>
      <span style="width:22px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dim)">${ls.length}</span>
    </div>`;
  }).join("");
  const legend = ["Landlord", "Tenant", "Unclear"].map(r =>
    `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim)">
      <span style="width:8px;height:8px;border-radius:2px;background:${RESPCOLORS[r]}"></span>${r}</span>`).join("");
  return `
  <div style="flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:6px">${bars}</div>
  <div style="display:flex;gap:14px;padding-top:9px;margin-top:2px;border-top:1px solid #F0F3F6">${legend}</div>`;
}

function renderCoverage(R) {
  const order = [["matched", "Matched", "#2F7D4F"], ["alternates only", "Alternates only", "#B8791C"],
                 ["no match", "No match — gap", "#A93B32"], ["excluded", "Excluded / N/A", "#8B6FC0"]]
    .sort((a, b) => (R.matchCounts[b[0]] || 0) - (R.matchCounts[a[0]] || 0));
  const max = Math.max(1, ...order.map(c => R.matchCounts[c[0]] || 0));
  const bars = order.map(([k, label, color]) => {
    const n = R.matchCounts[k] || 0;
    const active = S.fMatch === k;
    return `
    <button data-action="filter-match" data-value="${k}" style="display:flex;align-items:center;gap:12px;width:100%;
      background:${active ? "var(--tint)" : "transparent"};border:1px solid ${active ? "var(--tint-bd)" : "transparent"};
      border-radius:8px;padding:5px 7px;cursor:pointer;text-align:left">
      <span style="width:150px;flex:none;text-align:left;font-size:12.5px">${label}</span>
      <span style="flex:1;height:14px;border-radius:4px;background:${color};max-width:${n / max * 100}%;min-width:2px;
        transition:max-width .25s ease;opacity:${S.fMatch && !active ? ".35" : "1"}"></span>
      <span style="font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;width:24px;text-align:right">${n}</span>
    </button>`;
  }).join("");
  return `
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:11px">${bars}
    <span style="font-size:11.5px;color:var(--faint)">Matched against a fabricated SAMPLE catalogue — no prices anywhere in this demo.</span>
  </div>`;
}

/* ------------------------------------------------------- table + drawer */

function renderTableSection() {
  return "";  /* table renders inside renderDashboard so both share rollups */
}

function renderTable(R, rows, total) {
  const filtersOn = !!(S.fDiv || S.fResp || S.fMatch || S.fReview);
  const anyFilter = filtersOn || !!S.fStatus || !!S.search.trim();
  const compact = S.viewer, ultra = S.viewer && S.wide;
  const q = S.search.trim();

  const chips = [];
  if (S.fDiv) chips.push({ key: "div", label: "Division: " + (S.fDiv === "__other" ? "Other" : S.fDiv) });
  if (S.fResp) chips.push({ key: "resp", label: "Pays: " + S.fResp });
  if (S.fMatch) chips.push({ key: "match", label: "Catalogue: " + S.fMatch });
  if (S.fReview) chips.push({ key: "review", label: "Needs review" });
  if (S.fStatus) chips.push({ key: "status", label: "Status: " + S.fStatus });
  const chipHtml = chips.map(c => `
    <button data-action="clear-one" data-key="${c.key}" style="display:inline-flex;align-items:center;gap:7px;background:var(--tint);
      border:1px solid var(--tint-bd);color:var(--brand-deep);border-radius:999px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer">
      ${esc(c.label)}<span style="color:#6E93B4;font-size:13px;line-height:1">&#215;</span></button>`).join("");

  const selStyle = on => `padding:5px 7px;background:${on ? "var(--tint)" : "var(--bg)"};border:1px solid ${on ? "var(--tint-bd)" : "var(--border)"};
    border-radius:7px;font-size:12px;color:${on ? "var(--brand-deep)" : "var(--text)"};cursor:pointer;max-width:170px`;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === (cur || "") ? "selected" : ""}>${esc(label)}</option>`;
  const selects = `
    <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.4px;color:var(--faint);font-weight:700">DIVISION
      <select data-select="div" style="${selStyle(!!S.fDiv)}">
        ${opt("", "All divisions", S.fDiv)}
        ${Object.keys(R.divCounts).sort().map(k => opt(k, `${k.slice(0, 2)} – ${k.slice(3)}  (${R.divCounts[k]})`, S.fDiv)).join("")}
      </select></label>
    <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.4px;color:var(--faint);font-weight:700">PAYS
      <select data-select="resp" style="${selStyle(!!S.fResp)}">
        ${opt("", "Landlord & Tenant", S.fResp)}
        ${["Landlord", "Tenant", "Unclear"].map(r => opt(r, `${r}  (${R.respCounts[r] || 0})`, S.fResp)).join("")}
      </select></label>
    <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.4px;color:var(--faint);font-weight:700">STATUS
      <select data-select="status" style="${selStyle(!!S.fStatus)}">
        ${opt("", "Any status", S.fStatus)}
        ${["VERIFIED", "NEEDS REVIEW", "EXCLUDED"].map(v => opt(v, `${v}  (${R.revealed.filter(l => l.status === v).length})`, S.fStatus)).join("")}
      </select></label>
    <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.4px;color:var(--faint);font-weight:700">CATALOGUE
      <select data-select="match" style="${selStyle(!!S.fMatch)}">
        ${opt("", "Any outcome", S.fMatch)}
        ${["matched", "alternates only", "no match", "excluded"].map(v => opt(v, `${v}  (${R.matchCounts[v] || 0})`, S.fMatch)).join("")}
      </select></label>`;

  const thBase = `position:sticky;top:0;z-index:2;background:#FBFCFD;text-align:left;padding:9px 12px;font-size:10.5px;letter-spacing:.7px;color:var(--faint);font-weight:700;border-bottom:1px solid var(--border)`;
  const tdBase = `padding:10px 12px;border-bottom:1px solid #F0F3F6;vertical-align:top`;
  const hide = compact ? "display:none;" : "";
  const hide2 = ultra ? "display:none;" : "";

  const bodyRows = rows.map((l, idx) => renderRow(l, idx, { tdBase, hide, hide2, ultra })).join("");

  return `
  <section style="flex:1;min-height:0;display:flex;gap:12px">
    <div style="flex:${S.viewer ? (S.wide ? "0 0 30%" : "0 0 55%") : "1 1 100%"};min-width:0;display:flex;flex-direction:column;
      background:#FFF;border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:flex-basis .25s ease">
      <div style="flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <span style="font-size:13px;font-weight:700">Scope lines</span>
        <span style="font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums">${anyFilter ? rows.length + " of " + total : total + " lines · sorted by CSI"}</span>
        <span style="flex:1"></span>
        <input id="search-input" value="${esc(S.search)}" placeholder="Search scope, code, quote" aria-label="Search scope lines"
          style="width:200px;padding:7px 11px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--text)">
        <div style="flex-basis:100%;height:0"></div>
        ${selects}
        ${chipHtml}
        ${anyFilter ? `<button data-action="clear-filters" style="background:transparent;border:none;padding:0;color:var(--dim);font-size:11.5px;cursor:pointer;text-decoration:underline;text-underline-offset:3px">Clear all</button>` : ""}
      </div>
      <div class="siq-scroll" style="flex:1;min-height:0;overflow:auto">
        <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px;min-width:${ultra ? 290 : (compact ? 520 : 960)}px">
          <thead><tr>
            <th data-action="toggle-sort" style="${thBase};padding-left:16px;cursor:pointer;white-space:nowrap;width:100px">CSI CODE ${S.sortAsc ? "&#8593;" : "&#8595;"}</th>
            <th style="${thBase};${hide}white-space:nowrap;width:166px">DIVISION</th>
            <th style="${thBase}">SCOPE SUMMARY</th>
            <th style="${thBase};${hide2}white-space:nowrap;width:114px">RESPONSIBILITY</th>
            <th style="${thBase};${hide}white-space:nowrap;width:76px">QTY</th>
            <th style="${thBase};${hide}width:160px">CATALOGUE MATCH</th>
            <th style="${thBase};white-space:nowrap;width:80px">SOURCE</th>
            <th style="${thBase};${hide2}white-space:nowrap;width:120px">STATUS</th>
          </tr></thead>
          ${bodyRows}
        </table>
        ${rows.length === 0 ? `<div style="padding:44px 20px;text-align:center;color:var(--dim);font-size:13px">No scope lines match these filters.
          <button data-action="clear-filters" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;text-decoration:underline">Clear all</button></div>` : ""}
      </div>
    </div>
    ${S.viewer ? renderViewer() : ""}
  </section>`;
}

function renderRow(l, idx, ctx) {
  const { tdBase, hide, hide2, ultra } = ctx;
  const open = S.open === l.id;
  const cited = S.citeId === l.id;
  const m = l.match || { state: "no match", candidates: [], gap_reason: "" };
  const isGap = m.state === "no match", isExcl = m.state === "excluded";
  const best = m.candidates.length ? m.candidates[0] : null;
  const matchCell = isExcl
    ? `<span style="font-size:11px;font-weight:700;letter-spacing:.4px;color:var(--excl)">EXCLUDED / N-A</span>`
    : (isGap ? `<span style="font-size:11px;font-weight:700;letter-spacing:.4px;color:var(--stop)">NO MATCH</span>`
             : `<span style="font-size:12.5px">${esc(best.name)}</span><span style="font-size:11px;color:var(--faint);margin-left:6px">${m.candidates.length > 1 ? "+" + (m.candidates.length - 1) : ""}</span>`);

  const qtyDetail = l.qty ? `Quantity ${esc(l.qty)} — ${esc(l.qty_reason)}.` : `No quantity: ${esc(l.qty_reason)}.`;

  const candidates = m.candidates.map((k, i) => `
    <div style="display:flex;flex-direction:column;gap:4px;background:#FFF;border:1px solid ${i === 0 ? "var(--tint-bd)" : "var(--border)"};border-radius:10px;padding:10px 12px">
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="font-size:12.5px;font-weight:600;flex:1">${esc(k.name)}</span>
        ${i === 0 ? `<span class="tag best">BEST MATCH</span>` : ""}
        <span class="tag sample">SAMPLE</span>
      </div>
      <div class="mono" style="display:flex;gap:10px;font-size:11px;color:var(--dim)">
        <span>${esc(k.code)}</span><span>&#183;</span><span>${esc(k.uom)}</span></div>
      <div style="font-size:12px;color:var(--dim)">${esc(k.why)}</div>
    </div>`).join("");

  const notes = (l.review_notes || []).length
    ? `<div style="margin-top:8px;font-size:12px;color:var(--warn-deep)">&#9888; ${l.review_notes.map(esc).join(" &#183; ")}</div>` : "";

  const drawer = !open ? "" : `
    <tr><td colspan="8" style="padding:0;border-bottom:1px solid var(--border);background:#FBFCFD">
      <div style="display:grid;grid-template-columns:minmax(280px,1fr) minmax(340px,1.25fr);gap:20px;padding:16px 18px 20px 42px">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="klabel" style="margin-bottom:7px">VERBATIM QUOTE &#183; PAGE ${l.page}</div>
            <blockquote style="margin:0;padding:10px 14px;border-left:3px solid ${l.verified ? "var(--brand)" : "var(--warn)"};
              background:#FFF;border-radius:0 8px 8px 0;font-size:13px;line-height:1.55;color:#2B3742${l.verified ? "" : ";font-style:italic"}">${esc(l.quote)}</blockquote>
            ${notes}
            <button data-action="open-source" data-id="${l.id}" style="margin-top:8px;background:transparent;border:none;padding:0;color:var(--brand);font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px">Open in document &#8594;</button>
          </div>
          <div>
            <div class="klabel" style="margin-bottom:5px">QUANTITY</div>
            <div style="font-size:12.5px;color:var(--dim)">${qtyDetail}</div>
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span class="klabel">CATALOGUE CANDIDATES</span>
            <span class="tag sample">SAMPLE CATALOGUE</span>
          </div>
          ${isGap || isExcl ? `
            <div style="background:${isExcl ? "var(--excl-bg)" : "var(--stop-bg)"};border:1px solid ${isExcl ? "var(--excl-bd)" : "var(--stop-bd)"};border-radius:10px;padding:13px 15px">
              <div style="font-size:13px;font-weight:700;color:${isExcl ? "#6F52A8" : "var(--stop)"};margin-bottom:4px">
                ${isExcl ? "Excluded / N-A scope" : "No confident match &#8212; catalogue gap"}</div>
              <div style="font-size:12.5px;color:var(--dim)">${esc(m.gap_reason)}</div>
            </div>`
          : `<div style="display:flex;flex-direction:column;gap:7px">${candidates}</div>`}
        </div>
      </div>
    </td></tr>`;

  const ultraChips = ultra ? `<span style="display:flex;gap:6px;margin-top:7px">${respChip(l.resp)}${statusChip(l.status)}</span>` : "";
  const anim = S.reveal < 999 ? `animation:siqIn .22s ease both;animation-delay:${Math.min(idx * 20, 400)}ms;` : "";

  return `
  <tbody style="border-left:3px solid ${cited ? "var(--brand)" : "transparent"}">
    <tr data-action="toggle-row" data-id="${l.id}" style="cursor:pointer;${anim}background:${cited ? "var(--tint)" : (open ? "#FBFCFD" : "transparent")}">
      <td style="${tdBase};padding-left:16px;white-space:nowrap">
        <span style="display:inline-flex;align-items:center;gap:7px">
          <span style="color:#C3CCD4;font-size:9px;width:8px">${open ? "&#9660;" : "&#9654;"}</span>
          <span class="mono" style="font-size:12.5px;letter-spacing:-.2px">${csiDisplay(l)}</span></span></td>
      <td style="${tdBase};${hide}color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:166px">
        <span class="mono" style="font-weight:700;color:var(--brand)">${esc(l.div || "?")}</span><span style="color:#C3CCD4"> &#8211; </span>${esc(l.division)}</td>
      <td style="${tdBase};overflow-wrap:break-word">
        <span style="${ultra ? "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" : "display:block"}">${esc(l.summary)}</span>
        ${ultraChips}</td>
      <td style="${tdBase};${hide2}">${respChip(l.resp)}</td>
      <td style="${tdBase};${hide}font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap" title="${esc(l.qty_reason)}">${l.qty ? esc(l.qty) : "&#8211;"}</td>
      <td style="${tdBase};${hide}overflow-wrap:break-word">${matchCell}</td>
      <td style="${tdBase};white-space:nowrap">
        <button data-action="open-source" data-id="${l.id}" style="display:inline-flex;align-items:center;gap:5px;
          background:${cited ? "var(--brand)" : "transparent"};color:${cited ? "#fff" : "var(--brand)"};
          border:1px solid ${cited ? "var(--brand)" : "var(--tint-bd)"};border-radius:7px;padding:4px 9px;font-size:11.5px;font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums">
          &#8220; p.${l.page}</button></td>
      <td style="${tdBase};${hide2}">${statusChip(l.status)}</td>
    </tr>
    ${drawer}
  </tbody>`;
}

/* --------------------------------------------------------------- viewer */

function renderViewer() {
  const d = docInfo();
  if (!d) return "";
  const cited = lines().find(l => l.id === S.citeId);
  const citeFailed = cited && !cited.verified;
  const showRects = cited && cited.verified && cited.page === S.page ? cited.rects : [];
  const size = d.page_sizes[S.page - 1] || [612, 792];
  const dispW = Math.round(640 * S.zoom / 100);
  const dispH = Math.round(dispW * size[1] / size[0]);
  const scale = S.zoom >= 175 ? 3 : 2;
  const overlays = showRects.map((r, i) => `
    <div class="hl-rect" style="position:absolute;left:${(r[0] * 100).toFixed(2)}%;top:${(r[1] * 100).toFixed(2)}%;
      width:${((r[2] - r[0]) * 100).toFixed(2)}%;height:${((r[3] - r[1]) * 100).toFixed(2)}%;
      background:rgba(24,108,172,.30);box-shadow:0 0 0 3px rgba(24,108,172,.30);border-radius:3px;pointer-events:none"></div>`).join("");

  return `
  <div style="flex:1 1 ${S.wide ? "70%" : "45%"};min-width:0;display:flex;flex-direction:column;background:#FFF;
    border:1px solid var(--border);border-radius:12px;overflow:hidden;animation:siqIn .25s ease both;transition:flex-basis .25s ease">
    <div style="flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);background:#FBFCFD">
      <span style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px">${esc(d.pdf_name)}</span>
      <span style="font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap">page ${S.page} of ${d.pages}</span>
      <span style="flex:1"></span>
      <div style="display:flex;align-items:center;gap:1px;background:#FFF;border:1px solid var(--border);border-radius:7px;overflow:hidden">
        <button data-action="zoom-out" aria-label="Zoom out" style="width:26px;height:24px;background:transparent;border:none;color:var(--dim);cursor:pointer;font-size:14px;line-height:1">&#8722;</button>
        <span style="min-width:44px;text-align:center;font-size:11.5px;font-variant-numeric:tabular-nums">${S.zoom}%</span>
        <button data-action="zoom-in" aria-label="Zoom in" style="width:26px;height:24px;background:transparent;border:none;color:var(--dim);cursor:pointer;font-size:14px;line-height:1">+</button>
      </div>
      <button data-action="fit-width" style="background:#FFF;border:1px solid var(--border);border-radius:7px;padding:4px 9px;font-size:11.5px;color:var(--dim);cursor:pointer;white-space:nowrap">Fit width</button>
      <button data-action="toggle-wide" style="background:#FFF;border:1px solid var(--border);border-radius:7px;padding:4px 9px;font-size:11.5px;color:var(--dim);cursor:pointer;white-space:nowrap">${S.wide ? "Shrink" : "Expand"}</button>
      <button data-action="close-viewer" aria-label="Close document" style="width:26px;height:24px;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--dim);cursor:pointer;font-size:13px;line-height:1">&#215;</button>
    </div>
    ${citeFailed ? `
    <div style="flex:none;display:flex;align-items:flex-start;gap:10px;margin:10px 12px 0;background:var(--warn-bg);border:1px solid var(--warn-bd);border-radius:9px;padding:11px 13px">
      <span style="color:var(--warn);font-size:13px;line-height:1.3">&#9888;</span>
      <span style="font-size:12.5px;color:var(--warn-deep)">The quoted sentence was not found verbatim in the parsed text. This line needs human review; no highlight is drawn.</span>
    </div>` : ""}
    <div id="pages-box" class="siq-scroll" style="flex:1;min-height:0;overflow:auto;background:#EDF1F5;padding:14px 0 20px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div style="position:relative;width:${dispW}px;height:${dispH}px;flex:none;background:#FFF;box-shadow:0 2px 10px rgba(26,37,48,.13);border-radius:3px">
        <img src="/page?doc=${esc(d.id)}&n=${S.page}&scale=${scale}" alt="page ${S.page}"
          style="width:100%;height:100%;display:block" draggable="false">
        ${overlays}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button data-action="page-prev" style="background:#FFF;border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--dim);cursor:pointer">&#8593; Previous page</button>
        <button data-action="page-next" style="background:#FFF;border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--dim);cursor:pointer">Next page &#8595;</button>
      </div>
    </div>
  </div>`;
}

function scrollToHighlight() {
  S.scrollPending = false;
  requestAnimationFrame(() => {
    const box = $("#pages-box");
    const hl = box && box.querySelector(".hl-rect");
    if (!box) return;
    if (hl) {
      const top = hl.offsetTop + (hl.offsetParent ? hl.offsetParent.offsetTop : 0);
      box.scrollTop = Math.max(0, top - box.clientHeight * 0.28);
    } else {
      box.scrollTop = 0;
    }
  });
}

/* -------------------------------------------------------- decision page */

function renderDecision() {
  const D = (S.server && S.server.decision) || null;
  if (!D) return "";
  const C = 2 * Math.PI * 54;
  const arc = (D.normalized / 100) * C;

  const groups = D.groups.map(g => {
    const color = GROUPCOLORS[g.key] || "#888";
    const rules = g.rules.map(r => {
      const evid = g.key === "document"
        ? `<span style="font-style:italic;color:var(--dim)">&#8220;${esc(r.evidence)}&#8221;</span>${r.tag ? ` <span class="tag sample">${r.tag}</span>` : ""}`
        : `<span class="mono" style="color:var(--dim);font-size:11.5px">${esc(r.evidence)}</span>${r.tag ? ` <span class="tag sample">${r.tag}</span>` : ""}`;
      return `
      <div style="display:flex;align-items:flex-start;gap:14px;padding:11px 16px;border-bottom:1px solid #F0F3F6">
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600">${esc(r.name)}</div>
          <div style="font-size:11px;color:var(--faint);margin:1px 0 4px">${esc(r.anchors)}</div>
          <div style="font-size:12px">${evid}</div>
        </div>
        <div style="flex:none;display:flex;align-items:center;gap:10px">
          <span style="font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums">&#215;${r.weight}</span>
          <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--tint);
            border:1px solid var(--tint-bd);font-size:15px;font-weight:700;color:var(--brand-deep);font-variant-numeric:tabular-nums">${r.score}</span>
          <span style="width:44px;text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums">+${(r.score * r.weight).toFixed(1)}</span>
        </div>
      </div>`;
    }).join("");
    return `
    <div class="card" style="overflow:hidden">
      <div style="display:flex;align-items:center;gap:9px;padding:11px 16px;border-bottom:1px solid var(--border);background:#FBFCFD">
        <span style="width:9px;height:9px;border-radius:3px;background:${color}"></span>
        <span style="font-size:12px;font-weight:700">${esc(g.label)}</span>
        <span style="font-size:11px;color:var(--faint)">${esc(g.note)}</span>
      </div>
      ${rules}
    </div>`;
  }).join("");

  const allRules = D.groups.flatMap(g => g.rules.map(r => ({ ...r, gkey: g.key })));
  const maxW = Math.max(...allRules.map(r => r.score * r.weight));
  const comp = allRules
    .slice().sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map(r => `
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:150px;flex:none;font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</span>
        <span style="flex:1;display:flex"><span style="height:12px;border-radius:3px;background:${GROUPCOLORS[r.gkey]};width:${(r.score * r.weight / maxW * 100).toFixed(0)}%"></span></span>
        <span style="width:36px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dim)">${(r.score * r.weight).toFixed(1)}</span>
      </div>`).join("");

  const legend = Object.entries({ document: "Document", crm: "CRM", derived: "Computed", human: "Human" })
    .map(([k, n]) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dim)">
      <span style="width:8px;height:8px;border-radius:2px;background:${GROUPCOLORS[k]}"></span>${n}</span>`).join("");

  const bullets = (arr, color, mark) => arr.map(t =>
    `<li style="margin:0 0 7px;font-size:12.5px;line-height:1.45"><span style="color:${color};font-weight:700;margin-right:6px">${mark}</span>${esc(t)}</li>`).join("");

  const thresholdPct = D.threshold, scorePct = D.normalized;

  return `
  <main class="siq-scroll" style="flex:1;min-height:0;overflow:auto;padding:26px 24px 60px;display:flex;justify-content:center">
    <div style="width:1080px;max-width:100%;display:flex;flex-direction:column;gap:14px">

      <div class="card" style="display:flex;align-items:center;gap:28px;padding:20px 28px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">
            <span class="klabel">GO / NO-GO SCORECARD</span>
            <span class="tag preview">PREVIEW &#183; static data &#183; interactive scorecard is the next build</span>
          </div>
          <h1 style="margin:0 0 5px;font-size:21px;line-height:1.25;font-weight:700;letter-spacing:-.3px">${esc(D.project)}</h1>
          <div style="font-size:12.5px;color:var(--dim)">${esc(D.scorecard)} &#183; ${esc(D.scored_note)}</div>
          <div style="margin-top:14px;max-width:430px">
            <div style="position:relative;height:10px;border-radius:5px;background:linear-gradient(90deg,#EBCFCC 0 40%,#EBD8B8 40% 60%,#CFE4D7 60% 100%)">
              <span style="position:absolute;left:${thresholdPct}%;top:-3px;width:2px;height:16px;background:var(--text)"></span>
              <span style="position:absolute;left:${scorePct}%;top:-4px;width:14px;height:18px;transform:translateX(-7px);border-radius:4px;background:var(--brand);box-shadow:0 0 0 2px #fff"></span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--faint);margin-top:4px">
              <span>0</span><span>bid threshold ${D.threshold} &#8212; cleared by ${D.normalized - D.threshold}</span><span>100</span>
            </div>
          </div>
        </div>
        <div style="flex:none;position:relative;width:130px;height:130px">
          <svg viewBox="0 0 120 120" style="width:130px;height:130px;transform:rotate(-90deg)">
            <circle cx="60" cy="60" r="54" fill="none" stroke="#EDF1F5" stroke-width="10"></circle>
            <circle cx="60" cy="60" r="54" fill="none" stroke="var(--brand)" stroke-width="10"
              stroke-dasharray="${arc.toFixed(1)} ${(C - arc).toFixed(1)}" stroke-linecap="round"></circle>
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
            <span style="font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums">${D.normalized}</span>
            <span style="font-size:10px;letter-spacing:.7px;color:var(--faint);font-weight:700">/ 100</span>
            <span style="font-size:10.5px;color:var(--dim);margin-top:3px;font-variant-numeric:tabular-nums">${D.total} of ${D.max}</span>
          </div>
        </div>
        <div style="flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <span style="display:inline-flex;background:var(--accent);color:#2B1B00;font-size:15px;font-weight:700;letter-spacing:1.2px;padding:9px 18px;border-radius:8px">${esc(D.verdict)}</span>
          <span style="font-size:12px;font-weight:700;color:var(--ok)">${esc(D.rating)}</span>
          <button data-action="tab" data-tab="scope" style="background:transparent;border:none;padding:0;color:var(--brand);font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px">Open scope analysis &#8594;</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1.45fr 1fr;gap:14px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:14px">${groups}</div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card" style="padding:14px 16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <span class="klabel">SCORE COMPOSITION</span>
              <span style="flex:1"></span>${legend}
            </div>
            <div style="display:flex;flex-direction:column;gap:5px">${comp}</div>
            <div style="font-size:10.5px;color:var(--faint);margin-top:9px">weighted contribution to ${D.total} of ${D.max} &#183; computed in code, never by the model</div>
          </div>
          <div class="card" style="padding:14px 16px">
            <div class="klabel" style="margin-bottom:10px">WHY THIS VERDICT</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div><div style="font-size:11px;font-weight:700;color:var(--ok);margin-bottom:6px">FOR</div>
                <ul style="margin:0;padding:0;list-style:none">${bullets(D.pros, "var(--ok)", "+")}</ul></div>
              <div><div style="font-size:11px;font-weight:700;color:var(--stop);margin-bottom:6px">AGAINST</div>
                <ul style="margin:0;padding:0;list-style:none">${bullets(D.cons, "var(--stop)", "&#8722;")}</ul></div>
            </div>
            <div style="font-size:10.5px;color:var(--faint);margin-top:8px">In the live build this narrative is generated after the total exists, so the story cannot contradict the number.</div>
          </div>
          <div class="card" style="padding:14px 16px;background:#FBFCFD">
            <div class="klabel" style="margin-bottom:8px">NEXT BUILD — THE CUSTOMER OWNS THIS ALGORITHM</div>
            <div style="font-size:12.5px;color:var(--dim);line-height:1.55">
              Editable rules and anchors &#183; draggable weights with a live what-if against your open bids &#183;
              per-rule knockouts and a bid threshold that gates the scope analysis &#183;
              a confirm-with-consequences save &#183; a persona-attributed audit log.
              Weights are owned by the customer; this page is seeded with their real spreadsheet (52.5 / 70 = 75).
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>`;
}

/* ---------------------------------------------------------------- boot */

window.uploadFile = uploadFile;
fetchState();
