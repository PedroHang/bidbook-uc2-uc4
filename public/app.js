/* BidBookSoft bid-intelligence demo — vanilla JS front end. No framework, no build step, no CDN.
   All dashboard and scorecard figures are computed here, in code, from data
   the server returns. The model never totals anything.

   Two pages: Bid Decision (UC#4, live scorecard: evaluation + setup modes)
   and Scope Intelligence (UC#2). One shared document viewer. */

"use strict";

/* ------------------------------------------------------------------ state */

const S = {
  tab: "scope",             // scope | decision
  decisionMode: "eval",     // eval | setup
  persona: "dana",
  chart: "division",
  open: null,
  cite: null,               // {kind:"line"|"rule", id}
  page: 1,
  zoom: 100,
  wide: false,
  viewer: false,            // viewer open inside the scope split
  evalViewer: false,        // viewer open as drawer over the decision page
  search: "",
  fDiv: null, fResp: null, fMatch: null, fReview: false, fStatus: null,
  sortAsc: true,
  server: null,
  draft: null,              // editable scorecard copy; null = clean
  confirmOpen: false,
  auditOpen: false,
  reveal: 999,
  lastDocId: null,
  lastVersion: null,
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
const GROUPS = [
  ["document", "From the document", "AI proposes a score with a quoted passage, or abstains."],
  ["crm", "From your CRM", "Named queries against org data — no AI. SAMPLE records in the demo."],
  ["derived", "Computed", "Deterministic code. The model never does date math or geocoding."],
  ["human", "Needs a human", "The model never sees these rules. Tap a score."],
];

function result() { return S.server && S.server.result; }
function lines() { const r = result(); return (r && r.lines) || []; }
function docInfo() { const r = result(); return r ? r.doc : null; }
function evaluation() { const r = result(); return r ? r.evaluation : null; }
function savedSc() { return S.server ? S.server.scorecard : null; }
function activeSc() { return S.draft || savedSc(); }
function personaName(id) {
  const p = (S.server ? S.server.personas : []).find(p => p.id === id);
  return p ? p.name : id;
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
function csiDisplay(l) { return l.csi || (l.csi_raw ? esc(l.csi_raw) : "&#8212;"); }
function sortKey(l) { return l.csi || "99 99 99"; }
function deep(o) { return JSON.parse(JSON.stringify(o)); }

/* ---------------------------------------------------- scorecard arithmetic */
/* Deterministic mirrors of pipeline/evaluate.reaggregate — used for the
   live what-if only; the server recomputes authoritatively on save. */

function aggFor(sc, scoreMap) {
  const active = sc.rules.filter(r => r.active);
  let total = 0, mx = 0;
  const knockouts = [];
  active.forEach(r => {
    const s = scoreMap[r.id];
    if (s == null) return;
    total += s * r.weight;
    mx += 5 * r.weight;
    if (r.knockout && s <= r.knockout.max_trigger_score) knockouts.push(r.name);
  });
  const normalized = mx ? Math.round(total / mx * 100) : 0;
  let rating = "PASS";
  (sc.bands || []).slice().sort((a, b) => b.min - a.min).some(b => {
    if (normalized >= b.min) { rating = b.label; return true; }
    return false;
  });
  const below = normalized < (sc.threshold || 0);
  return {
    total: Math.round(total * 10) / 10, max: Math.round(mx * 10) / 10,
    normalized, rating, knockouts,
    verdict: (knockouts.length || below) ? "NO-BID" : "BID",
  };
}

function currentBidScores() {
  const ev = evaluation();
  const map = {};
  if (ev) ev.lines.forEach(l => { map[l.rule_id] = l.score; });
  return map;
}

function portfolioFlips(fromSc, toSc) {
  const bids = (S.server && S.server.portfolio) || [];
  let toNo = 0, toBid = 0;
  const dots = [];
  bids.forEach(b => {
    const a = aggFor(fromSc, b.scores), z = aggFor(toSc, b.scores);
    if (a.verdict === "BID" && z.verdict === "NO-BID") toNo += 1;
    if (a.verdict === "NO-BID" && z.verdict === "BID") toBid += 1;
    dots.push({ name: b.name, from: a.normalized, to: z.normalized,
                flipped: a.verdict !== z.verdict, verdict: z.verdict });
  });
  return { toNo, toBid, dots };
}

/* ---------------------------------------------------- pending-change diff */

function pendingChanges() {
  const old = savedSc(), neu = S.draft;
  if (!old || !neu) return [];
  const out = [];
  const add = (label, b, a) => {
    if (JSON.stringify(b) !== JSON.stringify(a))
      out.push({ label, before: b, after: a });
  };
  add("Bid threshold", old.threshold, neu.threshold);
  add("Gate blocks scope analysis", old.gate_enforced, neu.gate_enforced);
  add("Scoring instructions", old.instructions, neu.instructions);
  const oldIdx = {}; old.rules.forEach(r => oldIdx[r.id] = r);
  const neuIdx = {}; neu.rules.forEach(r => neuIdx[r.id] = r);
  old.rules.forEach(r => { if (!neuIdx[r.id]) out.push({ label: `Rule "${r.name}"`, before: "present", after: "removed" }); });
  neu.rules.forEach(r => {
    const o = oldIdx[r.id];
    if (!o) { out.push({ label: `Rule "${r.name}"`, before: "absent", after: "added" }); return; }
    add(`${r.name} — weight`, o.weight, r.weight);
    add(`${r.name} — name`, o.name, r.name);
    add(`${r.name} — source`, o.source, r.source);
    add(`${r.name} — active`, o.active, r.active);
    add(`${r.name} — knockout`, o.knockout, r.knockout);
    add(`${r.name} — anchors`, o.anchors, r.anchors);
  });
  return out;
}

function fmtVal(v) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (v == null) return "none";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 40 ? s.slice(0, 37) + "…" : (s === "" ? "(empty)" : s);
}

/* ------------------------------------------------------------------- boot

   There is no polling. The server holds no session state, so nothing arrives
   unbidden: the browser owns the result, the scorecard and the audit log, and
   drives the pipeline one call at a time. That is what lets this run on
   serverless hosting, and it is also why the page no longer yanks itself back
   to the top — a 5-second poll used to replace #view wholesale mid-scroll. */

const LS_SCORECARD = "siq.scorecard";
const LS_AUDIT = "siq.audit";

/* Every call goes to /api/index with the endpoint in the query string.
   /api/index is the one path a host's filesystem routing always maps to the
   function, and query strings always survive; a rewrite that funnels /api/*
   at the function does NOT reliably carry the original path, which silently
   404s every call. Server-side middleware turns ?ep=x back into /api/x. */
function apiURL(ep, params) {
  const q = new URLSearchParams(Object.assign({ ep }, params || {}));
  return "/api/index?" + q.toString();
}

function setPhase(mode, stage, detail) {
  S.server.mode = mode;
  S.server.stage = stage == null ? -1 : stage;
  S.server.stage_detail = detail || "";
  render();
}

function setFailure(title, message) {
  S.server.mode = "blocked";
  S.server.stage = -1;
  S.server.error_title = title || "The analysis failed.";
  S.server.error = message || "";
  render();
}

async function boot() {
  S.server = {
    mode: "starting", stage: 0, stage_detail: "loading", stages: [],
    error: "", error_title: "", result: null,
    scorecard: null, personas: [], portfolio: [], audit: [], has_key: false, features: {},
  };
  render();
  try {
    const bs = await fetch(apiURL("bootstrap")).then(r => r.json());
    if (!bs || !Array.isArray(bs.personas) || !bs.scorecard_seed) {
      setFailure("The API answered, but not with the app's data.",
                 "GET " + apiURL("bootstrap") + " returned: " + JSON.stringify(bs).slice(0, 300) +
                 " — the request reached the host but not this application's routes.");
      return;
    }
    S.server.stages = bs.stages;
    S.server.personas = bs.personas;
    S.server.portfolio = bs.portfolio;
    S.server.has_key = bs.has_key;
    S.server.features = bs.features || {};
    S.chunkPages = bs.extract_chunk_pages || 12;
    S.seedScorecard = bs.scorecard_seed;

    const stored = localStorage.getItem(LS_SCORECARD);
    S.server.scorecard = stored ? JSON.parse(stored) : bs.scorecard_seed;
    S.server.audit = JSON.parse(localStorage.getItem(LS_AUDIT) || "[]");

    const seed = await fetch(apiURL("seed")).then(r => r.json());
    if (seed && seed.doc) { adoptResult(seed, true); return; }
    setFailure("The sample analysis could not be loaded.",
               "GET " + apiURL("seed") + " returned: " + JSON.stringify(seed).slice(0, 300));
  } catch (e) {
    setFailure("Could not reach the API.", String(e));
  }
}

/* A result comes either from the precomputed seed or from a run we just drove.
   page_texts ride alongside so re-scoring needs nothing held on the server. */
function adoptResult(res, reveal) {
  S.pageTexts = res.page_texts || S.pageTexts || [];
  const clean = Object.assign({}, res);
  delete clean.page_texts;
  S.server.result = clean;
  S.server.mode = "idle";
  S.server.stage = -1;
  S.server.error = ""; S.server.error_title = "";
  S.lastDocId = clean.doc ? clean.doc.id : null;
  S.open = null; S.cite = null; S.viewer = false; S.evalViewer = false;
  S.fDiv = S.fResp = S.fMatch = S.fStatus = null; S.fReview = false; S.search = "";
  S.page = 1;
  if (reveal && clean.lines && clean.lines.length) startReveal();
  else { S.reveal = 999; render(); }
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
    if (l) { S.viewer = true; S.cite = { kind: "line", id: l.id }; S.page = l.page; S.scrollPending = true; render(); }
  }
  else if (a === "open-rule-source") {
    const ev = evaluation();
    const l = ev && ev.lines.find(x => x.rule_id === el.dataset.id);
    if (l && l.page) { S.evalViewer = true; S.cite = { kind: "rule", id: l.rule_id }; S.page = l.page; S.scrollPending = true; render(); }
  }
  else if (a === "close-viewer") { S.viewer = false; S.evalViewer = false; S.cite = null; render(); }
  else if (a === "zoom-in") { S.zoom = Math.min(300, S.zoom + 25); render(); }
  else if (a === "zoom-out") { S.zoom = Math.max(50, S.zoom - 25); render(); }
  else if (a === "fit-width") { fitWidth(); }
  else if (a === "toggle-wide") { S.wide = !S.wide; render(); }
  else if (a === "page-prev") { S.page = Math.max(1, S.page - 1); render(); }
  else if (a === "page-next") { const d = docInfo(); S.page = Math.min(d ? d.pages : 1, S.page + 1); render(); }
  else if (a === "pick-file") { $("#file-input").click(); }
  else if (a === "toggle-warnings") { S.showWarnings = !S.showWarnings; render(); }
  /* ---- UC#4 ---- */
  else if (a === "decision-mode") { S.decisionMode = el.dataset.mode; render(); }
  else if (a === "tap-score") { tapScore(el.dataset.id, parseInt(el.dataset.score, 10)); }
  else if (a === "clear-score") { tapScore(el.dataset.id, null); }
  else if (a === "run-anyway") { runPipeline(null, { forceScope: true }); }
  else if (a === "rerun-eval") { runPipeline(null); }
  else if (a === "goto-setup") { S.tab = "decision"; S.decisionMode = "setup"; render(); }
  else if (a === "toggle-rule-open") { const id = el.dataset.id; S.ruleOpen = (S.ruleOpen === id ? null : id); render(); }
  else if (a === "add-rule") { addRule(); }
  else if (a === "add-suggested") { addSuggested(el.dataset.id); }
  else if (a === "remove-rule") { ensureDraft(); S.draft.rules = S.draft.rules.filter(r => r.id !== el.dataset.id); render(); }
  else if (a === "revert-change") { revertOne(parseInt(el.dataset.idx, 10)); }
  else if (a === "discard-draft") { S.draft = null; render(); }
  else if (a === "open-confirm") { S.confirmOpen = true; render(); }
  else if (a === "close-confirm") { S.confirmOpen = false; render(); }
  else if (a === "save-scorecard") { saveScorecard(); }
  else if (a === "open-audit") { S.auditOpen = true; render(); }
  else if (a === "close-audit") { S.auditOpen = false; render(); }
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) {
    const k = sel.dataset.select, v = sel.value || null;
    if (k === "div") S.fDiv = v;
    else if (k === "resp") S.fResp = v;
    else if (k === "status") { S.fStatus = v; S.fReview = false; }
    else if (k === "match") S.fMatch = v;
    else if (k === "persona") { S.persona = sel.value; return; }
    render();
    return;
  }
  const ed = e.target.closest("[data-edit]");
  if (ed) { applyEdit(ed); render(); }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search-input") { S.search = e.target.value; render(true); return; }
  const ed = e.target.closest("[data-edit]");
  if (ed && (ed.dataset.edit === "weight" || ed.dataset.edit === "threshold")) {
    applyEdit(ed);
    liveConsequenceUpdate(ed);
  }
});

function applyEdit(el) {
  ensureDraft();
  const d = S.draft, kind = el.dataset.edit, id = el.dataset.id;
  const rule = id ? d.rules.find(r => r.id === id) : null;
  if (kind === "weight" && rule) rule.weight = parseFloat(el.value);
  else if (kind === "threshold") d.threshold = parseInt(el.value, 10);
  else if (kind === "gate") d.gate_enforced = el.checked;
  else if (kind === "instructions") d.instructions = el.value;
  else if (kind === "name" && rule) rule.name = el.value;
  else if (kind === "source" && rule) rule.source = el.value;
  else if (kind === "active" && rule) rule.active = el.checked;
  else if (kind === "ko-on" && rule) rule.knockout = el.checked ? { max_trigger_score: 1 } : null;
  else if (kind === "ko-trigger" && rule && rule.knockout) rule.knockout.max_trigger_score = parseInt(el.value, 10);
  else if (kind === "anchor" && rule) {
    const k = el.dataset.anchor;
    if (el.value.trim()) rule.anchors[k] = el.value.trim();
    else delete rule.anchors[k];
  }
}

function ensureDraft() { if (!S.draft) S.draft = deep(savedSc()); }

function addRule() {
  ensureDraft();
  let n = 1;
  while (S.draft.rules.some(r => r.id === `custom_${n}`)) n += 1;
  S.draft.rules.push({
    id: `custom_${n}`, name: `New rule ${n}`, source: "human", weight: 1,
    active: true, knockout: null,
    anchors: { "5": "Best case", "3": "Middle", "1": "Worst case" },
  });
  S.ruleOpen = `custom_${n}`;
  render();
}

function addSuggested(id) {
  ensureDraft();
  const sug = (savedSc().suggested_rules || []).find(r => r.id === id);
  if (!sug || S.draft.rules.some(r => r.id === id)) return;
  S.draft.rules.push({ id: sug.id, name: sug.name, source: sug.source, weight: sug.weight,
                       active: true, knockout: null, anchors: deep(sug.anchors) });
  render();
}

function revertOne(idx) {
  /* revert = rebuild draft with that one change undone: simplest correct way
     is to re-apply all OTHER pending changes onto a fresh copy */
  const changes = pendingChanges();
  const keep = changes.filter((_, i) => i !== idx);
  if (!keep.length) { S.draft = null; render(); return; }
  // targeted revert for the common cases; fall back to full discard on complex ones
  const c = changes[idx];
  const old = savedSc();
  if (c.label === "Bid threshold") S.draft.threshold = old.threshold;
  else if (c.label === "Gate blocks scope analysis") S.draft.gate_enforced = old.gate_enforced;
  else if (c.label === "Scoring instructions") S.draft.instructions = old.instructions;
  else {
    const name = c.label.split(" — ")[0].replace(/^Rule "|"$/g, "");
    const oldRule = old.rules.find(r => r.name === name);
    const i = S.draft.rules.findIndex(r => r.name === name);
    if (c.after === "added") { if (i >= 0) S.draft.rules.splice(i, 1); }
    else if (c.after === "removed") { if (oldRule) S.draft.rules.push(deep(oldRule)); }
    else if (oldRule && i >= 0) {
      const field = c.label.split(" — ")[1];
      const map = { weight: "weight", name: "name", source: "source", active: "active", knockout: "knockout", anchors: "anchors" };
      if (map[field]) S.draft.rules[i][map[field]] = deep(oldRule[map[field]]);
    }
  }
  if (!pendingChanges().length) S.draft = null;
  render();
}

async function postJSON(ep, body) {
  const res = await fetch(apiURL(ep), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }));
}

/* --- deterministic aggregation, mirroring pipeline/evaluate.reaggregate ---
   The weights and knockouts come off the LINE, which is the snapshot the
   evaluation was scored under; the scorecard only supplies bands and the gate. */
function reaggLines(sc, lns) {
  const active = lns.filter(l => l.active !== false);
  const scored = active.filter(l => l.score != null);
  const total = scored.reduce((n, l) => n + l.score * l.weight, 0);
  const mx = scored.reduce((n, l) => n + 5 * l.weight, 0);
  const normalized = mx ? Math.round(total / mx * 100) : 0;
  let rating = "PASS";
  (sc.bands || []).slice().sort((a, b) => b.min - a.min).some(b => {
    if (normalized >= b.min) { rating = b.label; return true; }
    return false;
  });
  const knockouts = scored.filter(l => l.knockout && l.score <= l.knockout.max_trigger_score)
                          .map(l => l.name);
  const below = normalized < (sc.threshold || 0);
  return {
    total: Math.round(total * 10) / 10, max: Math.round(mx * 10) / 10, normalized,
    rating, verdict: (knockouts.length || below) ? "NO-BID" : "BID",
    scored_count: scored.length, rule_count: active.length,
    knockouts_triggered: knockouts,
    gate: { threshold: sc.threshold || 0, enforced: !!sc.gate_enforced,
            below_threshold: below, passed: !(knockouts.length || below) },
  };
}

function applyGateToResult() {
  const r = result(), ev = evaluation();
  if (!r || !ev) return;
  const blocked = ev.gate.enforced && !ev.gate.passed && r.lines === null;
  r.scope_blocked = blocked;
  if (blocked) {
    r.scope_block_reason = ev.knockouts_triggered.length
      ? "knockout triggered: " + ev.knockouts_triggered.join(", ")
      : `score ${ev.normalized} is below the bid threshold (${ev.gate.threshold})`;
  } else {
    r.scope_block_reason = "";
  }
}

async function refreshNarrative() {
  const ev = evaluation();
  if (!ev) return;
  const out = await postJSON("narrative", {
    lines: ev.lines.map(l => ({ name: l.name, score: l.score, weight: l.weight,
                                needs_human: l.needs_human, evidence: l.evidence })),
    verdict: ev.verdict, rating: ev.rating,
  });
  if (out.ok && out.narrative) { ev.narrative = out.narrative; render(); }
}

async function tapScore(ruleId, score) {
  const ev = evaluation();
  if (!ev) return;
  const line = ev.lines.find(l => l.rule_id === ruleId);
  if (!line) return;
  const p = (S.server.personas || []).find(x => x.id === S.persona) || { id: S.persona, name: S.persona, role: "" };
  if (score == null) {
    line.score = null; line.needs_human = true; line.scored_by = null;
    line.evidence = "The model never sees this rule. Tap a score.";
  } else {
    line.score = score; line.needs_human = false; line.scored_by = p.id;
    line.evidence = `Scored by ${p.name} (${p.role})`;
  }
  Object.assign(ev, reaggLines(savedSc(), ev.lines));
  applyGateToResult();
  render();
  refreshNarrative();          // a model call; the tap already landed
}

function saveScorecard() {
  const changes = pendingChanges();
  if (!changes.length) { S.draft = null; S.confirmOpen = false; render(); return; }
  const flips = portfolioFlips(savedSc(), S.draft);
  const note = (flips.toNo || flips.toBid)
    ? `${flips.toNo} bid(s) flipped BID→NO-BID, ${flips.toBid} flipped NO-BID→BID across the SAMPLE portfolio at save time`
    : "";
  const from = savedSc().version || 1;
  const next = deep(S.draft);
  next.version = from + 1;
  const p = (S.server.personas || []).find(x => x.id === S.persona) || { id: S.persona, name: S.persona, role: "" };
  const entry = {
    ts: new Date().toISOString().slice(0, 19).replace("T", " "),
    persona: p, version_from: from, version_to: next.version,
    changes: changes.map(c => ({ path: c.label, before: c.before, after: c.after })),
    flips_note: note,
  };
  S.server.scorecard = next;
  S.server.audit = [entry].concat(S.server.audit || []);
  localStorage.setItem(LS_SCORECARD, JSON.stringify(next));
  localStorage.setItem(LS_AUDIT, JSON.stringify(S.server.audit));
  S.draft = null; S.confirmOpen = false;
  // the live evaluation keeps its own weight snapshot; only bands and the gate
  // follow the saved scorecard, exactly as the server does it
  const ev = evaluation();
  if (ev) { Object.assign(ev, reaggLines(next, ev.lines)); applyGateToResult(); }
  render();
}

async function doReset() {
  const live = !!(S.server && S.server.has_key);
  const msg = live
    ? "Restore the seed scorecard, clear the audit log, and RE-RUN the sample against the model for real?\n\nThis bypasses the cache and takes a couple of minutes."
    : "Restore the seed scorecard and clear the audit log, and reload the sample?\n\nNo API key is configured on this host, so the analysis stays the cached one.";
  if (!confirm(msg)) return;

  S.draft = null;
  localStorage.removeItem(LS_SCORECARD);
  localStorage.removeItem(LS_AUDIT);
  const cleared = await postJSON("clear-cache");

  if (!live) {                       // nothing to run live with; reload as-is
    await boot();
    S.server.result.warnings = (S.server.result.warnings || [])
      .concat(["No API key is configured on this host, so this is the cached analysis."]);
    render();
    return;
  }

  // reset the scorecard in memory, then re-run the sample with the cache off
  S.server.scorecard = S.seedScorecard;
  S.server.audit = [];
  await runPipeline(null, { fromSeed: true, useCache: false,
                            note: cleared && cleared.note ? cleared.note : "" });
}

/* ------------------------------------------------ the client-driven pipeline
   Each step is its own request, so no single call runs for minutes and the
   progress strip reports what actually just happened. */

async function runPipeline(file, opts) {
  opts = opts || {};
  const forceScope = !!opts.forceScope;
  const useCache = opts.useCache !== false;
  S.uploadFile = file || S.uploadFile;

  let doc = null, pageTexts = null, warnings = [];
  if (opts.note) warnings.push(opts.note);

  if (opts.fromSeed) {
    setPhase("processing", 1, "sample specification");
    const src = await fetch(apiURL("seed-source")).then(r => r.json())
      .catch(e => ({ ok: false, error: String(e) }));
    if (!src.ok) { setFailure("Could not load the sample document.", src.error); return; }
    doc = src.doc; pageTexts = src.page_texts; S.pageTexts = pageTexts;
  } else if (file) {
    setPhase("processing", 0, file.name);
    const fd = new FormData();
    fd.append("file", file);
    const prep = await fetch(apiURL("prepare"), { method: "POST", body: fd })
      .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
    if (!prep.ok) { setFailure(prep.title, prep.error); return; }
    doc = prep.doc; pageTexts = prep.page_texts; warnings = prep.warnings || [];
    S.pageTexts = pageTexts;
  } else {
    doc = docInfo(); pageTexts = S.pageTexts;
    if (!doc || !pageTexts || !pageTexts.length) { setFailure("Nothing to re-run.", ""); return; }
  }

  setPhase("processing", 3, `${savedSc().name} v${savedSc().version || 1}`);
  const evRes = await postJSON("evaluate", {
    scorecard: savedSc(), page_texts: pageTexts, doc_id: doc.id, use_cache: useCache,
  });
  if (!evRes.ok) { setFailure("Scoring failed.", evRes.error); return; }
  const ev = evRes.evaluation;
  warnings = warnings.concat(evRes.warnings || []);

  setPhase("processing", 4, ev.verdict);
  const blocked = ev.gate.enforced && !ev.gate.passed && !forceScope;

  let lns = null;
  if (!blocked) {
    const chunk = S.chunkPages || 12;
    const raw = [];
    for (let start = 1; start <= pageTexts.length; start += chunk) {
      setPhase("processing", 5, `${Math.min(start + chunk - 1, pageTexts.length)} of ${pageTexts.length} pages · ${raw.length} lines`);
      const out = await postJSON("extract", {
        page_texts: pageTexts, start, count: chunk, doc_id: doc.id, use_cache: useCache,
      });
      if (!out.ok) { setFailure("Extraction failed.", out.error); return; }
      raw.push.apply(raw, out.raw_lines);
      warnings = warnings.concat(out.warnings || []);
    }
    setPhase("processing", 6, `${raw.length} quotes`);
    setPhase("processing", 7, `${raw.length} lines against the SAMPLE catalogue`);
    const fin = await postJSON("finalize", {
      raw_lines: raw, page_texts: pageTexts, doc_id: doc.id, use_cache: useCache,
    });
    if (!fin.ok) { setFailure("Verification failed.", fin.error); return; }
    lns = fin.lines;
    warnings = warnings.concat(fin.warnings || []);
  }

  setPhase("processing", 8, lns ? `${lns.length} lines` : "skipped — gate");
  adoptResult({
    doc, evaluation: ev, lines: lns,
    scope_blocked: blocked,
    scope_block_reason: blocked
      ? (ev.knockouts_triggered.length
          ? "knockout triggered: " + ev.knockouts_triggered.join(", ")
          : `score ${ev.normalized} is below the bid threshold (${ev.gate.threshold})`)
      : "",
    scope_forced: forceScope && ev.gate.enforced && !ev.gate.passed,
    provenance: evRes.provenance || "cached",
    warnings, page_texts: pageTexts,
  }, true);
}

async function uploadFile(file) {
  await runPipeline(file);
}

/* A page image can 404 when a serverless instance never saw this upload.
   Re-post the file we still hold in the browser, then retry once. */
async function pageImageFailed(img) {
  if (img.dataset.retried || !S.uploadFile || !docInfo()) return;
  img.dataset.retried = "1";
  const fd = new FormData();
  fd.append("doc_id", docInfo().id);
  fd.append("file", S.uploadFile);
  const out = await fetch(apiURL("rehydrate"), { method: "POST", body: fd })
    .then(r => r.json()).catch(() => ({ ok: false }));
  if (out.ok) img.src = img.src.split("&_r=")[0] + "&_r=1";
}

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const bar = e.target.closest && e.target.closest("#intake-bar");
  if (bar && e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});

function fitWidth() {
  const box = $("#pages-box");
  if (!box) { S.zoom = 100; render(); return; }
  const target = box.clientWidth - 48;
  S.zoom = Math.max(50, Math.min(300, Math.round(target / 640 * 100)));
  render();
}

/* live update of the consequence panel while a slider drags (no full render,
   so the slider keeps focus and the drag stays smooth) */
function liveConsequenceUpdate(el) {
  const panel = $("#conseq-panel");
  if (panel) panel.innerHTML = consequencePanelInner();
  if (el.dataset.edit === "weight") {
    const lab = $(`#wlabel-${el.dataset.id}`);
    if (lab) lab.textContent = parseFloat(el.value).toFixed(1);
    el.style.setProperty("--fill", ((parseFloat(el.value) - 0.5) / 2.5 * 100) + "%");
    const mx = $("#draft-max");
    if (mx) {
      const active = S.draft.rules.filter(r => r.active);
      mx.textContent = (active.reduce((n, r) => n + 5 * r.weight, 0)).toFixed(1);
    }
  }
  if (el.dataset.edit === "threshold") {
    const lab = $("#thresh-label");
    if (lab) lab.textContent = el.value;
  }
  const bar = $("#savebar");
  if (bar) bar.style.display = pendingChanges().length ? "flex" : "none";
}

/* ---------------------------------------------------------------- render

   render() rebuilds #view from scratch, which resets the scroll offset of every
   scrollable box inside it. Anything the reader can scroll therefore carries a
   data-scroll-key, and we snapshot and restore those offsets around the swap —
   otherwise tapping a score or dragging a weight would throw the page back to
   the top mid-read. Keys must be stable across renders, never index-based.

   The memory outlives a single swap on purpose: a box that is absent from the
   current view (the other tab, the other decision mode) must still find its
   place when the reader comes back to it. */

const SCROLL_MEM = {};

function snapshotScroll() {
  document.querySelectorAll("[data-scroll-key]").forEach(el => {
    SCROLL_MEM[el.dataset.scrollKey] = [el.scrollTop, el.scrollLeft];
  });
}

function restoreScroll() {
  document.querySelectorAll("[data-scroll-key]").forEach(el => {
    const v = SCROLL_MEM[el.dataset.scrollKey];
    if (!v || (!v[0] && !v[1])) return;
    el.scrollTop = v[0];
    el.scrollLeft = v[1];
  });
}

function render(keepFocus) {
  const focusedId = document.activeElement && document.activeElement.id;
  const selStart = focusedId === "search-input" ? document.activeElement.selectionStart : null;
  snapshotScroll();

  $("#tab-decision").classList.toggle("active", S.tab === "decision");
  $("#tab-scope").classList.toggle("active", S.tab === "scope");

  const d = docInfo();
  $("#project-chip").textContent = d ? d.name.replace(/^u\d+-/, "") : "loading…";

  /* persona switcher */
  const ps = $("#persona-select");
  const personas = (S.server && S.server.personas) || [];
  if (ps.options.length !== personas.length) {
    ps.innerHTML = personas.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.role)}</option>`).join("");
  }
  ps.value = S.persona;

  /* pipeline strip */
  const ev = evaluation();
  const pd = $("#pipe-decision");
  if (ev) {
    pd.innerHTML = `Bid Decision: ${ev.verdict} <span class="pipe-sub">${ev.total} / ${ev.max}</span>`;
    pd.style.background = ev.verdict === "BID" ? "var(--tint)" : "var(--stop-bg)";
    pd.style.borderColor = ev.verdict === "BID" ? "var(--tint-bd)" : "var(--stop-bd)";
    pd.style.color = ev.verdict === "BID" ? "var(--brand-deep)" : "var(--stop)";
  } else {
    pd.textContent = "Bid Decision";
  }
  const psc = $("#pipe-scope");
  const r = result();
  if (r && r.scope_blocked) {
    psc.textContent = "Scope analysis: blocked by gate";
    psc.style.color = "var(--stop)"; psc.style.borderColor = "var(--stop-bd)"; psc.style.background = "var(--stop-bg)";
  } else if (r && r.scope_forced) {
    psc.textContent = "Scope analysis: gate overridden";
    psc.style.color = "var(--warn-deep)"; psc.style.borderColor = "var(--warn-bd)"; psc.style.background = "var(--warn-bg)";
  } else {
    psc.textContent = "Scope analysis";
    psc.style.color = ""; psc.style.borderColor = ""; psc.style.background = "";
    psc.classList.toggle("on", S.tab === "scope");
  }

  $("#view").innerHTML = S.tab === "decision" ? renderDecision() : renderScope();
  $("#overlay").innerHTML = renderOverlays();

  /* slider fills */
  document.querySelectorAll("input[type=range].weight").forEach(el => {
    el.style.setProperty("--fill", ((parseFloat(el.value) - 0.5) / 2.5 * 100) + "%");
  });

  restoreScroll();

  if (focusedId === "search-input") {
    const inp = $("#search-input");
    if (inp) { inp.focus(); if (selStart != null) inp.setSelectionRange(selStart, selStart); }
  }
  if ((S.viewer || S.evalViewer) && S.scrollPending) scrollToHighlight();
}

/* ------------------------------------------------------------ scope page */

function renderScope() {
  const mode = S.server ? S.server.mode : "starting";
  const r = result();
  const blocked = r && r.scope_blocked && mode === "idle";
  return `
  <main style="flex:1;min-height:0;display:flex;flex-direction:column;padding:14px 24px 18px;gap:12px;overflow:hidden">
    ${renderIntake(mode)}
    ${blocked ? renderGateBlocked(r) : ""}
    ${mode === "idle" && !blocked && lines().length ? renderDashboard() : ""}
  </main>`;
}

function renderGateBlocked(r) {
  const ev = evaluation();
  return `
  <section class="card" style="flex:none;display:flex;align-items:flex-start;gap:14px;padding:22px 24px;border-color:var(--stop-bd);background:var(--stop-bg)">
    <span style="font-size:18px;color:var(--stop)">&#9888;</span>
    <div style="flex:1">
      <div style="font-size:15px;font-weight:700;color:var(--stop);margin-bottom:4px">Scope analysis not run — ${esc(r.scope_block_reason)}</div>
      <div style="font-size:13px;color:var(--dim);max-width:720px">The bid gate is enforced, so the expensive step was skipped on purpose: the scorecard
        (${ev ? ev.normalized : "?"}/100, ${ev ? esc(ev.verdict) : ""}) decides whether this document earns estimating hours.
        Override it for this document, adjust the threshold, or turn the gate off to make the score advisory.</div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn primary" data-action="run-anyway">Run scope analysis anyway</button>
        <button class="btn" data-action="goto-setup">Adjust threshold / gate</button>
        <button class="btn quiet" data-action="tab" data-tab="decision">See why it failed</button>
      </div>
    </div>
  </section>`;
}

function renderIntake(mode) {
  const d = docInfo();
  const server = S.server || {};
  const r = result();
  const warnings = (r && r.warnings) || [];
  const provenance = r ? r.provenance : "";

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
          <span style="font-size:13.5px;font-weight:600">${esc(mode === "starting" ? "Analyzing the sample specification" : "Processing document")}</span>
          <span style="font-size:12px;color:var(--dim)">${esc(server.stage_detail || "")}</span>
          <span style="flex:1"></span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${pills}</div>
      </div>`;
  } else if (mode === "blocked" || mode === "error") {
    inner = `
      <div style="display:flex;align-items:flex-start;gap:12px;background:var(--warn-bg);border:1px solid var(--warn-bd);border-radius:10px;padding:13px 15px">
        <span style="font-size:14px;color:var(--warn);line-height:1.3">&#9888;</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--warn-deep);margin-bottom:3px">${esc(server.error_title || "The analysis failed.")}</div>
          <div style="font-size:12.5px;color:var(--dim)">${esc(server.error || "")}</div>
        </div>
        <button class="btn" data-action="pick-file">Upload another file</button>
        <input type="file" id="file-input" accept=".pdf,.docx,.doc" style="display:none"
          onchange="if(this.files.length)uploadFile(this.files[0])">
        <button class="btn quiet" data-action="reset">Back to sample</button>
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
          <span style="font-size:11px;color:var(--faint);letter-spacing:.4px">.docx or .pdf &#183; drag anywhere in this bar &#183; non-scope documents are rejected</span>
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

/* rollups + dashboard + table + viewer for the scope page (unchanged logic) */

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
    <div class="siq-scroll" data-scroll-key="donut-legend" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;max-height:210px;overflow:auto">${legend}</div>
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

function renderTable(R, rows, total) {
  const filtersOn = !!(S.fDiv || S.fResp || S.fMatch || S.fReview);
  const anyFilter = filtersOn || !!S.fStatus || !!S.search.trim();
  const compact = S.viewer, ultra = S.viewer && S.wide;

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

  const bodyRows = rows.map((l, idx) => renderRowHtml(l, idx, { tdBase, hide, hide2, ultra })).join("");

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
      <div class="siq-scroll" data-scroll-key="scope-table" style="flex:1;min-height:0;overflow:auto">
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
    ${S.viewer ? renderViewer(false) : ""}
  </section>`;
}

function renderRowHtml(l, idx, ctx) {
  const { tdBase, hide, hide2, ultra } = ctx;
  const open = S.open === l.id;
  const cited = S.cite && S.cite.kind === "line" && S.cite.id === l.id;
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

function citedThing() {
  if (!S.cite) return null;
  if (S.cite.kind === "line") return lines().find(l => l.id === S.cite.id) || null;
  const ev = evaluation();
  return ev ? (ev.lines.find(l => l.rule_id === S.cite.id) || null) : null;
}

function renderViewer(asDrawer) {
  const d = docInfo();
  if (!d) return "";
  const cited = citedThing();
  const citeFailed = cited && cited.quote && !cited.verified;
  const showRects = cited && cited.verified && cited.page === S.page ? cited.rects : [];
  const size = d.page_sizes[S.page - 1] || [612, 792];
  const dispW = Math.round(640 * S.zoom / 100);
  const dispH = Math.round(dispW * size[1] / size[0]);
  const scale = S.zoom >= 175 ? 3 : 2;
  const overlays = showRects.map(r => `
    <div class="hl-rect" style="position:absolute;left:${(r[0] * 100).toFixed(2)}%;top:${(r[1] * 100).toFixed(2)}%;
      width:${((r[2] - r[0]) * 100).toFixed(2)}%;height:${((r[3] - r[1]) * 100).toFixed(2)}%;
      background:rgba(24,108,172,.30);box-shadow:0 0 0 3px rgba(24,108,172,.30);border-radius:3px;pointer-events:none"></div>`).join("");

  const shell = asDrawer
    ? `position:relative;width:100%;height:100%;display:flex;flex-direction:column;background:#FFF`
    : `flex:1 1 ${S.wide ? "70%" : "45%"};min-width:0;display:flex;flex-direction:column;background:#FFF;
       border:1px solid var(--border);border-radius:12px;overflow:hidden;animation:siqIn .25s ease both;transition:flex-basis .25s ease`;

  return `
  <div style="${shell}">
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
      ${asDrawer ? "" : `<button data-action="toggle-wide" style="background:#FFF;border:1px solid var(--border);border-radius:7px;padding:4px 9px;font-size:11.5px;color:var(--dim);cursor:pointer;white-space:nowrap">${S.wide ? "Shrink" : "Expand"}</button>`}
      <button data-action="close-viewer" aria-label="Close document" style="width:26px;height:24px;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--dim);cursor:pointer;font-size:13px;line-height:1">&#215;</button>
    </div>
    ${citeFailed ? `
    <div style="flex:none;display:flex;align-items:flex-start;gap:10px;margin:10px 12px 0;background:var(--warn-bg);border:1px solid var(--warn-bd);border-radius:9px;padding:11px 13px">
      <span style="color:var(--warn);font-size:13px;line-height:1.3">&#9888;</span>
      <span style="font-size:12.5px;color:var(--warn-deep)">The quoted sentence was not found verbatim in the parsed text. No highlight is drawn.</span>
    </div>` : ""}
    <div id="pages-box" class="siq-scroll" data-scroll-key="pages-box" style="flex:1;min-height:0;overflow:auto;background:#EDF1F5;padding:14px 0 20px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div style="position:relative;width:${dispW}px;height:${dispH}px;flex:none;background:#FFF;box-shadow:0 2px 10px rgba(26,37,48,.13);border-radius:3px">
        <img src="${esc(apiURL("page", { doc: d.id, n: S.page, scale: scale }))}" alt="page ${S.page}"
          onerror="pageImageFailed(this)" style="width:100%;height:100%;display:block" draggable="false">
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
  const ev = evaluation();
  const mode = S.server ? S.server.mode : "starting";
  if (!ev || mode === "processing" || mode === "starting" || mode === "blocked" || mode === "error") {
    return `
    <main style="flex:1;min-height:0;display:flex;flex-direction:column;padding:14px 24px 18px;gap:12px;overflow:hidden">
      ${renderIntake(mode)}
    </main>`;
  }
  return `
  <main class="siq-scroll" data-scroll-key="decision-${S.decisionMode}" style="flex:1;min-height:0;overflow:auto;padding:20px 24px 60px;display:flex;justify-content:center">
    <div style="width:1120px;max-width:100%;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="seg">
          <button class="${S.decisionMode === "eval" ? "on" : ""}" data-action="decision-mode" data-mode="eval">Evaluation</button>
          <button class="${S.decisionMode === "setup" ? "on" : ""}" data-action="decision-mode" data-mode="setup">Scorecard setup</button>
        </div>
        <span style="font-size:12px;color:var(--faint)">${esc(ev.scorecard_name)} · v${ev.scorecard_version}${savedSc() && savedSc().version !== ev.scorecard_version ? ` <span style="color:var(--warn-deep)">(scorecard now v${savedSc().version} — evaluation keeps its snapshot)</span>` : ""}</span>
        ${savedSc() && savedSc().version !== ev.scorecard_version ? `<button class="btn quiet" data-action="rerun-eval">Re-score under v${savedSc().version}</button>` : ""}
        <span style="flex:1"></span>
        <button class="btn quiet" data-action="open-audit">Change history</button>
      </div>
      ${S.decisionMode === "eval" ? renderEvaluation(ev) : renderSetup()}
    </div>
  </main>`;
}

function renderEvaluation(ev) {
  const d = docInfo();
  const C = 2 * Math.PI * 54;
  const arc = Math.max(0, Math.min(1, ev.normalized / 100)) * C;
  const gaugeColor = ev.verdict === "BID" ? "var(--brand)" : "var(--stop)";

  const knockBanner = ev.knockouts_triggered.length ? `
    <div style="display:flex;align-items:center;gap:10px;background:var(--stop-bg);border:1px solid var(--stop-bd);border-radius:10px;padding:12px 16px">
      <span style="color:var(--stop);font-size:15px">&#9888;</span>
      <span style="font-size:13px;color:var(--stop);font-weight:700">KNOCKOUT — ${esc(ev.knockouts_triggered.join(", "))}.</span>
      <span style="font-size:12.5px;color:var(--dim)">Verdict NO-BID regardless of the total score.</span>
    </div>` : "";

  const groups = GROUPS.map(([key, label, note]) => {
    const ls = ev.lines.filter(l => l.source === key);
    if (!ls.length) return "";
    const cards = ls.map(l => renderRuleCard(l)).join("");
    return `
    <div class="card" style="overflow:hidden">
      <div style="display:flex;align-items:center;gap:9px;padding:11px 16px;border-bottom:1px solid var(--border);background:#FBFCFD">
        <span style="width:9px;height:9px;border-radius:3px;background:${GROUPCOLORS[key]}"></span>
        <span style="font-size:12px;font-weight:700">${label}</span>
        <span style="font-size:11px;color:var(--faint)">${note}</span>
      </div>
      ${cards}
    </div>`;
  }).join("");

  const scored = ev.lines.filter(l => l.score != null);
  const maxW = Math.max(1, ...scored.map(l => l.score * l.weight));
  const comp = scored.slice().sort((a, b) => b.score * b.weight - a.score * a.weight).map(l => `
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:150px;flex:none;font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.name)}</span>
      <span style="flex:1;display:flex"><span style="height:12px;border-radius:3px;background:${GROUPCOLORS[l.source]};width:${(l.score * l.weight / maxW * 100).toFixed(0)}%"></span></span>
      <span style="width:36px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dim)">${(l.score * l.weight).toFixed(1)}</span>
    </div>`).join("");

  const legend = Object.entries({ document: "Document", crm: "CRM", derived: "Computed", human: "Human" })
    .map(([k, n]) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dim)">
      <span style="width:8px;height:8px;border-radius:2px;background:${GROUPCOLORS[k]}"></span>${n}</span>`).join("");

  const nb = ev.narrative;
  const bullets = (arr, color, mark) => (arr || []).map(t =>
    `<li style="margin:0 0 7px;font-size:12.5px;line-height:1.45"><span style="color:${color};font-weight:700;margin-right:6px">${mark}</span>${esc(t)}</li>`).join("");

  const gate = ev.gate;
  const r = result();
  const gateCard = `
    <div class="card" style="padding:14px 16px">
      <div class="klabel" style="margin-bottom:10px">THE GATE</div>
      <div style="font-size:12.5px;color:var(--dim);line-height:1.5">
        Threshold <strong style="color:var(--text)">${gate.threshold}</strong> ·
        gate <strong style="color:${gate.enforced ? "var(--text)" : "var(--faint)"}">${gate.enforced ? "blocks scope analysis" : "off — advisory"}</strong><br>
        ${r && r.scope_blocked
          ? `<span style="color:var(--stop);font-weight:600">Scope analysis was skipped for this document.</span>`
          : (r && r.scope_forced
            ? `<span style="color:var(--warn-deep);font-weight:600">Gate overridden — scope analysis ran anyway.</span>`
            : `This document ${gate.passed ? "cleared the gate; the scope analysis ran" : "did not clear the gate"}.`)}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${r && r.scope_blocked ? `<button class="btn primary" data-action="run-anyway">Run scope anyway</button>` : ""}
        <button class="btn quiet" data-action="decision-mode" data-mode="setup">Adjust in setup</button>
      </div>
    </div>`;

  return `
      ${knockBanner}
      <div class="card" style="display:flex;align-items:center;gap:28px;padding:20px 28px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">
            <span class="klabel">GO / NO-GO SCORECARD</span>
            <span class="tag sample" title="The scorecard is real and editable; the CRM records and derived inputs are fabricated samples">CRM + DERIVED INPUTS: SAMPLE</span>
          </div>
          <h1 style="margin:0 0 5px;font-size:21px;line-height:1.25;font-weight:700;letter-spacing:-.3px">${d ? esc(d.name.replace(/^u\d+-/, "")) : ""}</h1>
          <div style="font-size:12.5px;color:var(--dim)">${esc(ev.scorecard_name)} v${ev.scorecard_version} · ${ev.scored_count} of ${ev.rule_count} rules scored${ev.scored_count < ev.rule_count ? " — " + (ev.rule_count - ev.scored_count) + " awaiting human input" : ""}</div>
          <div style="margin-top:14px;max-width:430px">
            <div style="position:relative;height:10px;border-radius:5px;background:linear-gradient(90deg,#EBCFCC 0 40%,#EBD8B8 40% 60%,#CFE4D7 60% 100%)">
              <span style="position:absolute;left:${gate.threshold}%;top:-3px;width:2px;height:16px;background:var(--text)"></span>
              <span style="position:absolute;left:${ev.normalized}%;top:-4px;width:14px;height:18px;transform:translateX(-7px);border-radius:4px;background:${gaugeColor};box-shadow:0 0 0 2px #fff"></span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--faint);margin-top:4px">
              <span>0</span><span>bid threshold ${gate.threshold} — ${ev.normalized >= gate.threshold ? "cleared by " + (ev.normalized - gate.threshold) : "missed by " + (gate.threshold - ev.normalized)}</span><span>100</span>
            </div>
          </div>
        </div>
        <div style="flex:none;position:relative;width:130px;height:130px">
          <svg viewBox="0 0 120 120" style="width:130px;height:130px;transform:rotate(-90deg)">
            <circle cx="60" cy="60" r="54" fill="none" stroke="#EDF1F5" stroke-width="10"></circle>
            <circle cx="60" cy="60" r="54" fill="none" stroke="${gaugeColor}" stroke-width="10"
              stroke-dasharray="${arc.toFixed(1)} ${(C - arc).toFixed(1)}" stroke-linecap="round" style="transition:stroke-dasharray .3s ease"></circle>
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
            <span style="font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums">${ev.normalized}</span>
            <span style="font-size:10px;letter-spacing:.7px;color:var(--faint);font-weight:700">/ 100</span>
            <span style="font-size:10.5px;color:var(--dim);margin-top:3px;font-variant-numeric:tabular-nums">${ev.total} of ${ev.max}</span>
          </div>
        </div>
        <div style="flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <span style="display:inline-flex;background:${ev.verdict === "BID" ? "var(--accent)" : "var(--stop)"};color:${ev.verdict === "BID" ? "#2B1B00" : "#fff"};font-size:15px;font-weight:700;letter-spacing:1.2px;padding:9px 18px;border-radius:8px">${esc(ev.verdict)}</span>
          <span style="font-size:12px;font-weight:700;color:${ev.verdict === "BID" ? "var(--ok)" : "var(--stop)"}">${esc(ev.rating)}</span>
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
            <div style="display:flex;flex-direction:column;gap:5px">${comp || '<span style="font-size:12px;color:var(--faint)">nothing scored yet</span>'}</div>
            <div style="font-size:10.5px;color:var(--faint);margin-top:9px">weighted contribution to ${ev.total} of ${ev.max} · computed in code, never by the model</div>
          </div>
          ${nb ? `
          <div class="card" style="padding:14px 16px">
            <div class="klabel" style="margin-bottom:10px">WHY THIS VERDICT</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div><div style="font-size:11px;font-weight:700;color:var(--ok);margin-bottom:6px">FOR</div>
                <ul style="margin:0;padding:0;list-style:none">${bullets(nb.pros, "var(--ok)", "+")}</ul></div>
              <div><div style="font-size:11px;font-weight:700;color:var(--stop);margin-bottom:6px">AGAINST</div>
                <ul style="margin:0;padding:0;list-style:none">${bullets(nb.cons, "var(--stop)", "&#8722;")}</ul></div>
            </div>
            <div style="font-size:10.5px;color:var(--faint);margin-top:8px">Generated after the score was computed, so the story cannot contradict the number.</div>
          </div>` : ""}
          ${gateCard}
          ${renderAuditPeek()}
        </div>
      </div>`;
}

function renderRuleCard(l) {
  let evid = "";
  if (l.source === "document") {
    if (l.verified) {
      evid = `<blockquote style="margin:6px 0 0;padding:8px 12px;border-left:3px solid var(--brand);background:#FBFCFD;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.5;color:#2B3742">${esc(l.quote)}</blockquote>
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
          <span style="font-size:11.5px;color:var(--dim)">${esc(l.evidence)}</span>
          <button data-action="open-rule-source" data-id="${esc(l.rule_id)}" style="background:transparent;border:none;padding:0;color:var(--brand);font-size:11.5px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px">p. ${l.page} — open in document &#8594;</button>
        </div>`;
    } else {
      evid = `<div style="font-size:12px;color:var(--warn-deep);margin-top:4px">&#9888; ${esc(l.evidence)}</div>`;
    }
  } else if (l.source === "crm") {
    evid = `<div style="display:flex;align-items:center;gap:7px;margin-top:4px;flex-wrap:wrap">
      <span class="mono" style="font-size:11.5px;color:var(--dim)">${esc(l.evidence)}</span><span class="tag sample">SAMPLE</span></div>
      ${(l.records || []).map(r => `<div style="font-size:11px;color:var(--faint);margin-top:3px">&#8627; ${esc(r)}</div>`).join("")}`;
  } else if (l.source === "derived") {
    evid = `<div style="display:flex;align-items:center;gap:7px;margin-top:4px">
      <span class="mono" style="font-size:11.5px;color:var(--dim)">${esc(l.evidence)}</span><span class="tag sample">SAMPLE INPUTS</span></div>`;
  } else {
    const taps = [1, 2, 3, 4, 5].map(n =>
      `<button class="score-tap ${l.score === n ? "on" : ""}" data-action="tap-score" data-id="${esc(l.rule_id)}" data-score="${n}">${n}</button>`).join("");
    evid = `
      <div style="margin-top:6px">
        ${l.score == null
          ? `<div style="font-size:12px;color:var(--warn-deep);margin-bottom:6px">Not scored — needs your judgment. ${esc(l.evidence)}</div>`
          : `<div style="font-size:12px;color:var(--dim);margin-bottom:6px">${esc(l.evidence)} · <button data-action="clear-score" data-id="${esc(l.rule_id)}" style="background:none;border:none;padding:0;color:var(--brand);font-size:11.5px;cursor:pointer;text-decoration:underline">undo</button></div>`}
        <div style="display:flex;gap:6px">${taps}</div>
      </div>`;
  }
  const ko = l.knockout ? `<span class="chip review" title="kills the bid when score &#8804; ${l.knockout.max_trigger_score}">KNOCKOUT</span>` : "";
  const triggered = l.knockout && l.score != null && l.score <= l.knockout.max_trigger_score;
  return `
  <div style="display:flex;align-items:flex-start;gap:14px;padding:11px 16px;border-bottom:1px solid #F0F3F6;${triggered ? "box-shadow:inset 3px 0 0 var(--stop);" : ""}${l.score == null && l.source !== "human" ? "background:#FDFBF7;" : ""}">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13.5px;font-weight:600">${esc(l.name)}</span>${ko}
      </div>
      <div style="font-size:11px;color:var(--faint);margin:1px 0 2px">${esc(l.anchors)}</div>
      ${evid}
    </div>
    <div style="flex:none;display:flex;align-items:center;gap:10px">
      <span style="font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums">&#215;${l.weight}</span>
      <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:9px;
        background:${l.score == null ? "var(--warn-bg)" : "var(--tint)"};
        border:1px solid ${l.score == null ? "var(--warn-bd)" : "var(--tint-bd)"};
        font-size:15px;font-weight:700;color:${l.score == null ? "var(--warn-deep)" : "var(--brand-deep)"};font-variant-numeric:tabular-nums">${l.score == null ? "&#8212;" : l.score}</span>
      <span style="width:44px;text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums">${l.score == null ? "" : "+" + (l.score * l.weight).toFixed(1)}</span>
    </div>
  </div>`;
}

function renderAuditPeek() {
  const log = (S.server && S.server.audit) || [];
  const items = log.slice(0, 3).map(e => `
    <div style="font-size:11.5px;color:var(--dim);line-height:1.45">
      <strong style="color:var(--text)">${esc(e.persona.name)}</strong> — v${e.version_from}&#8594;v${e.version_to},
      ${e.changes.length} change${e.changes.length === 1 ? "" : "s"} · ${esc(e.ts)}
    </div>`).join("");
  return `
  <div class="card" style="padding:14px 16px;background:#FBFCFD">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span class="klabel">RECENT CHANGES</span>
      <span style="flex:1"></span>
      <button data-action="open-audit" style="background:none;border:none;padding:0;color:var(--brand);font-size:11.5px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px">Change history</button>
    </div>
    ${items || '<span style="font-size:12px;color:var(--faint)">No changes this session — the scorecard is as seeded.</span>'}
  </div>`;
}

/* ------------------------------------------------------------ setup mode */

function renderSetup() {
  const sc = activeSc();
  if (!sc) return "";
  const pending = pendingChanges();

  const rows = sc.rules.map(r => renderRuleRow(r)).join("");
  const suggested = (savedSc().suggested_rules || [])
    .filter(sg => !sc.rules.some(r => r.id === sg.id))
    .map(sg => `
    <div style="display:flex;align-items:flex-start;gap:12px;background:#FBFCFD;border:1px solid var(--border);border-radius:10px;padding:11px 14px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12.5px;font-weight:600">${esc(sg.name)}</span>
          <span class="tag sample">FROM PUBLISHED BID/NO-BID RESEARCH</span>
        </div>
        <div style="font-size:11.5px;color:var(--dim);margin-top:2px">${esc(sg.why)}</div>
      </div>
      <button class="btn quiet" data-action="add-suggested" data-id="${esc(sg.id)}">Add to scorecard</button>
    </div>`).join("");

  return `
    <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:14px;align-items:start">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card" style="overflow:hidden">
          <div style="display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border);background:#FBFCFD">
            <span style="font-size:12px;font-weight:700">Rules</span>
            <span style="font-size:11px;color:var(--faint)">max = sum of active weights &#215; 5 = <strong id="draft-max" style="color:var(--text)">${(sc.rules.filter(r => r.active).reduce((n, r) => n + 5 * r.weight, 0)).toFixed(1)}</strong></span>
            <span style="flex:1"></span>
            <button class="btn quiet" data-action="add-rule">+ Add rule</button>
          </div>
          ${rows}
        </div>
        ${suggested ? `<div style="display:flex;flex-direction:column;gap:8px">${suggested}</div>` : ""}
        <div class="card" style="padding:14px 16px">
          <div class="klabel" style="margin-bottom:4px">SCORING INSTRUCTIONS — APPLIED WHEN READING DOCUMENTS</div>
          <div style="font-size:11px;color:var(--faint);margin-bottom:8px">Shown to the AI for document rules only. Recorded with every evaluation, so it is never a hidden influence.</div>
          <textarea data-edit="instructions" rows="3" maxlength="600" placeholder="e.g. We are pulling back from education work this year; treat prevailing-wage language as a negative for project fit."
            style="width:100%;padding:9px 11px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--text);resize:vertical">${esc(sc.instructions || "")}</textarea>
        </div>
        <div class="card" style="padding:14px 16px">
          <div class="klabel" style="margin-bottom:10px">THE GATE</div>
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
            <span style="font-size:12.5px;width:110px">Bid threshold</span>
            <input type="range" class="thresh" data-edit="threshold" min="0" max="100" step="5" value="${sc.threshold}" style="flex:1">
            <span id="thresh-label" style="width:30px;text-align:right;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums">${sc.threshold}</span>
          </div>
          <label style="display:flex;align-items:center;gap:10px;font-size:12.5px;cursor:pointer;margin-top:10px">
            <input type="checkbox" data-edit="gate" ${sc.gate_enforced ? "checked" : ""}>
            <span><strong>Gate blocks scope analysis.</strong>
            <span style="color:var(--dim)">On: a bid below the threshold (or a triggered knockout) never reaches the expensive extraction step. Off: everything flows through and the score is advisory.</span></span>
          </label>
        </div>
      </div>
      <div id="conseq-panel" class="card" style="padding:14px 16px;position:sticky;top:0">${consequencePanelInner()}</div>
    </div>
    <div id="savebar" style="display:${pending.length ? "flex" : "none"};position:sticky;bottom:0;background:#FFF;border:1px solid var(--border);
      border-radius:12px;padding:12px 16px;align-items:center;gap:12px;box-shadow:0 -4px 20px rgba(26,37,48,.08)">
      <span style="font-size:12.5px;color:var(--dim)"><strong style="color:var(--text)">${pending.length}</strong> unsaved change${pending.length === 1 ? "" : "s"} · acting as <strong style="color:var(--text)">${esc(personaName(S.persona))}</strong></span>
      <span style="flex:1"></span>
      <button class="btn quiet" data-action="discard-draft">Discard</button>
      <button class="btn primary" data-action="open-confirm">Save scorecard changes</button>
    </div>`;
}

function renderRuleRow(r) {
  const open = S.ruleOpen === r.id;
  const srcOpt = (v, label) => `<option value="${v}" ${r.source === v ? "selected" : ""}>${label}</option>`;
  const anchors = open ? `
    <div style="padding:12px 16px 14px 42px;background:#FBFCFD;border-top:1px solid #F0F3F6">
      <div class="klabel" style="margin-bottom:8px">ANCHORS — WHAT EACH SCORE MEANS</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${[5, 4, 3, 2, 1].map(n => `
          <label style="display:flex;align-items:center;gap:10px;font-size:12px">
            <span style="width:16px;text-align:right;font-weight:700;color:var(--brand-deep);font-variant-numeric:tabular-nums">${n}</span>
            <input data-edit="anchor" data-anchor="${n}" data-id="${esc(r.id)}" value="${esc(r.anchors[String(n)] || "")}" placeholder="(unused)"
              style="flex:1;padding:6px 10px;background:#FFF;border:1px solid var(--border);border-radius:7px;font-size:12px;color:var(--text)">
          </label>`).join("")}
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:12px">
        <label style="display:inline-flex;align-items:center;gap:7px;font-size:12px;cursor:pointer">
          <input type="checkbox" data-edit="ko-on" data-id="${esc(r.id)}" ${r.knockout ? "checked" : ""}>
          Knockout — kills the bid when score &#8804;
        </label>
        <select data-edit="ko-trigger" data-id="${esc(r.id)}" ${r.knockout ? "" : "disabled"}
          style="padding:4px 7px;background:${r.knockout ? "#FFF" : "var(--bg)"};border:1px solid var(--border);border-radius:7px;font-size:12px">
          <option value="1" ${r.knockout && r.knockout.max_trigger_score === 1 ? "selected" : ""}>1</option>
          <option value="2" ${r.knockout && r.knockout.max_trigger_score === 2 ? "selected" : ""}>2</option>
        </select>
        <span style="flex:1"></span>
        <button class="btn danger" data-action="remove-rule" data-id="${esc(r.id)}">Remove rule</button>
      </div>
    </div>` : "";

  return `
  <div style="border-bottom:1px solid #F0F3F6;${r.active ? "" : "opacity:.5"}">
    <div style="display:flex;align-items:center;gap:12px;padding:10px 16px">
      <button data-action="toggle-rule-open" data-id="${esc(r.id)}" aria-label="Edit anchors" style="background:none;border:none;padding:0;color:#C3CCD4;font-size:10px;cursor:pointer;width:12px">${open ? "&#9660;" : "&#9654;"}</button>
      <input data-edit="name" data-id="${esc(r.id)}" value="${esc(r.name)}"
        style="flex:1;min-width:0;padding:6px 9px;background:transparent;border:1px solid transparent;border-radius:7px;font-size:13px;font-weight:600;color:var(--text)"
        onfocus="this.style.background='#FFF';this.style.borderColor='var(--border)'"
        onblur="this.style.background='transparent';this.style.borderColor='transparent'">
      ${r.knockout ? `<span class="chip review">KO &#8804;${r.knockout.max_trigger_score}</span>` : ""}
      <select data-edit="source" data-id="${esc(r.id)}" title="Who answers this rule"
        style="padding:5px 7px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:11.5px;color:var(--text)">
        ${srcOpt("document", "Document · AI + quote")}${srcOpt("crm", "CRM · named query")}${srcOpt("derived", "Derived · code")}${srcOpt("human", "Human · manual")}
      </select>
      <input type="range" class="weight" data-edit="weight" data-id="${esc(r.id)}" min="0.5" max="3" step="0.5" value="${r.weight}"
        aria-label="Weight for ${esc(r.name)}">
      <span id="wlabel-${esc(r.id)}" style="width:28px;text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums">${r.weight.toFixed(1)}</span>
      <label title="Active" style="display:inline-flex;align-items:center;cursor:pointer">
        <input type="checkbox" data-edit="active" data-id="${esc(r.id)}" ${r.active ? "checked" : ""}>
      </label>
    </div>
    ${anchors}
  </div>`;
}

function consequencePanelInner() {
  const saved = savedSc(), draft = S.draft;
  const sc = draft || saved;
  const scores = currentBidScores();
  const now = aggFor(saved, scores);
  const then = draft ? aggFor(draft, scores) : now;
  const flips = draft ? portfolioFlips(saved, draft) : { toNo: 0, toBid: 0, dots: portfolioFlips(saved, saved).dots };
  const pending = pendingChanges();
  const ev = evaluation();

  const bidLine = draft
    ? (now.verdict !== then.verdict
        ? `<div style="font-size:13px;font-weight:700;color:var(--stop)">This bid: ${now.normalized} &#8594; ${then.normalized}. Verdict flips ${now.verdict} &#8594; ${then.verdict}.</div>`
        : `<div style="font-size:13px;color:var(--text)">This bid: <strong>${now.normalized} &#8594; ${then.normalized}</strong>. Verdict unchanged: ${then.verdict}.</div>`)
    : `<div style="font-size:13px;color:var(--dim)">This bid scores <strong style="color:var(--text)">${now.normalized}/100</strong> under the saved scorecard${ev && ev.scored_count < ev.rule_count ? ` (${ev.rule_count - ev.scored_count} rules unscored)` : ""}.</div>`;

  const dots = flips.dots.map(dt => `
    <span title="${esc(dt.name)}: ${dt.from}${draft ? " → " + dt.to : ""} (${dt.verdict})"
      style="position:absolute;left:${dt.to}%;top:${dt.flipped ? "-3px" : "1px"};width:${dt.flipped ? 10 : 8}px;height:${dt.flipped ? 10 : 8}px;
      border-radius:5px;transform:translateX(-4px);background:${dt.verdict === "BID" ? "var(--brand)" : "var(--stop)"};
      ${dt.flipped ? "box-shadow:0 0 0 2px #fff,0 0 0 4px " + (dt.verdict === "BID" ? "var(--tint-bd)" : "var(--stop-bd)") : "opacity:.75"}"></span>`).join("");

  const pendingHtml = pending.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dim)">
      <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.label)}: <strong style="color:var(--text)">${esc(fmtVal(c.before))}</strong> &#8594; <strong style="color:var(--brand-deep)">${esc(fmtVal(c.after))}</strong></span>
      <button data-action="revert-change" data-idx="${i}" style="background:none;border:none;padding:0;color:var(--faint);font-size:11px;cursor:pointer;text-decoration:underline">revert</button>
    </div>`).join("");

  return `
    <div class="klabel" style="margin-bottom:10px">LIVE CONSEQUENCES</div>
    ${bidLine}
    <div style="margin:14px 0 4px;font-size:11.5px;color:var(--dim)">Across your <strong style="color:var(--text)">${flips.dots.length} open bids</strong> <span class="tag sample">SAMPLE</span>${draft ? `:
      <strong style="color:${flips.toNo ? "var(--stop)" : "var(--text)"}">${flips.toNo} flip BID&#8594;NO-BID</strong>,
      <strong style="color:${flips.toBid ? "var(--ok)" : "var(--text)"}">${flips.toBid} flip NO-BID&#8594;BID</strong>` : ""}</div>
    <div style="position:relative;height:10px;border-radius:5px;background:#F2F5F8;margin:10px 2px 2px">
      <span style="position:absolute;left:${sc.threshold}%;top:-4px;width:2px;height:18px;background:var(--text)"></span>
      ${dots}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--faint);margin-top:3px">
      <span>0</span><span>threshold ${sc.threshold}</span><span>100</span>
    </div>
    ${pending.length ? `
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:10px">
      <div class="klabel" style="margin-bottom:8px">PENDING CHANGES (${pending.length})</div>
      <div class="siq-scroll" data-scroll-key="pending" style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto">${pendingHtml}</div>
    </div>` : `
    <div style="margin-top:16px;font-size:11.5px;color:var(--faint)">Drag a weight or edit a rule — the effect on this bid and the portfolio shows here before anything is saved. Past evaluations always keep the weights they were scored under.</div>`}`;
}

/* -------------------------------------------------------------- overlays */

function renderOverlays() {
  let html = "";
  if (S.evalViewer) {
    html += `<div class="drawer-veil" data-action="close-viewer"></div>
      <div class="drawer" style="width:620px">${renderViewer(true)}</div>`;
  }
  if (S.auditOpen) {
    const log = (S.server && S.server.audit) || [];
    const entries = log.map(e => `
      <div style="padding:14px 18px;border-bottom:1px solid #F0F3F6">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="width:26px;height:26px;border-radius:13px;background:var(--tint);border:1px solid var(--tint-bd);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--brand-deep)">${esc(e.persona.name.split(" ").map(w => w[0]).join(""))}</span>
          <span style="font-size:12.5px;font-weight:600">${esc(e.persona.name)}</span>
          <span style="font-size:11px;color:var(--faint)">${esc(e.persona.role)}</span>
          <span style="flex:1"></span>
          <span style="font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums">${esc(e.ts)} · v${e.version_from}&#8594;v${e.version_to}</span>
        </div>
        ${e.changes.map(c => `<div style="font-size:11.5px;color:var(--dim);margin:3px 0 0 34px">${esc(c.path)}: <strong style="color:var(--text)">${esc(fmtVal(c.before))}</strong> &#8594; <strong style="color:var(--brand-deep)">${esc(fmtVal(c.after))}</strong></div>`).join("")}
        ${e.flips_note ? `<div style="font-size:11px;color:var(--warn-deep);margin:6px 0 0 34px">&#9888; ${esc(e.flips_note)}</div>` : ""}
      </div>`).join("");
    html += `<div class="drawer-veil" data-action="close-audit"></div>
      <div class="drawer">
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)">
          <span style="font-size:14px;font-weight:700">Change history</span>
          <span style="font-size:11px;color:var(--faint)">read-only — that is the point of an audit log</span>
          <span style="flex:1"></span>
          <button class="btn quiet" data-action="close-audit">Close</button>
        </div>
        <div class="siq-scroll" data-scroll-key="audit" style="flex:1;overflow:auto">
          ${entries || '<div style="padding:30px;text-align:center;font-size:12.5px;color:var(--faint)">No changes this session — the scorecard is as seeded.</div>'}
        </div>
      </div>`;
  }
  if (S.confirmOpen && S.draft) {
    const pending = pendingChanges();
    const flips = portfolioFlips(savedSc(), S.draft);
    const scores = currentBidScores();
    const now = aggFor(savedSc(), scores), then = aggFor(S.draft, scores);
    html += `<div class="modal-veil">
      <div class="modal">
        <div style="font-size:16px;font-weight:700;margin-bottom:4px">Are you sure you want to change the scoring?</div>
        <div style="font-size:12.5px;color:var(--dim);margin-bottom:14px">You are changing <strong style="color:var(--text)">${pending.length}</strong> thing${pending.length === 1 ? "" : "s"}, as <strong style="color:var(--text)">${esc(personaName(S.persona))}</strong>. This will be logged.</div>
        <div style="display:flex;flex-direction:column;gap:5px;max-height:200px;overflow:auto;margin-bottom:14px;padding:10px 12px;background:#FBFCFD;border:1px solid var(--border);border-radius:9px" class="siq-scroll">
          ${pending.map(c => `<div style="font-size:11.5px;color:var(--dim)">${esc(c.label)}: <strong style="color:var(--text)">${esc(fmtVal(c.before))}</strong> &#8594; <strong style="color:var(--brand-deep)">${esc(fmtVal(c.after))}</strong></div>`).join("")}
        </div>
        <div style="font-size:12.5px;line-height:1.6;margin-bottom:6px">
          This bid: <strong>${now.normalized} &#8594; ${then.normalized}</strong>${now.verdict !== then.verdict ? ` — <strong style="color:var(--stop)">verdict flips ${now.verdict} &#8594; ${then.verdict}</strong>` : " (verdict unchanged)"}.<br>
          Across the 14 SAMPLE open bids: <strong style="color:${flips.toNo ? "var(--stop)" : "var(--text)"}">${flips.toNo} would flip BID &#8594; NO-BID</strong>, <strong style="color:${flips.toBid ? "var(--ok)" : "var(--text)"}">${flips.toBid} NO-BID &#8594; BID</strong>.
        </div>
        <div style="font-size:11.5px;color:var(--faint);margin-bottom:18px">Past evaluations keep the weights they were scored under; nothing is silently re-scored.</div>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <button class="btn quiet" data-action="close-confirm">Cancel</button>
          <button class="btn primary" data-action="save-scorecard">Save — I understand the consequences</button>
        </div>
      </div>
    </div>`;
  }
  return html;
}

/* ---------------------------------------------------------------- boot */

window.uploadFile = uploadFile;
window.pageImageFailed = pageImageFailed;
boot();
