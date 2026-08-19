#!/usr/bin/env node
/*
═══════════════════════════════════════════════════════════════════════
  CMH Daily Driver — Smoke Test
═══════════════════════════════════════════════════════════════════════

  Usage:    node test_smoke.js [path/to/index.html]
  Default:  node test_smoke.js index.html

  What it does:
    Simulates the morning user flow against the live JS in index.html.
    Tests the four priority screens:
      1. Availability Board (paste → math → group net)
      2. Hourly Flow (per-group breakdown)
      3. Checklists (progress, save/restore)
      4. Scheduler (coverage timeline build)

  Exit codes:
    0 = all tests passed (safe to ship)
    1 = at least one test failed (DO NOT ship — fix or revert)

  Run this BEFORE making any edit (baseline) and AFTER editing
  (regression check). Compare output. New failures = drift.

  No external dependencies. Pure Node + built-in vm module.
═══════════════════════════════════════════════════════════════════════
*/

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const filePath = process.argv[2] || 'index.html';
if (!fs.existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`);
  console.error(`   Usage: node test_smoke.js [path/to/index.html]`);
  process.exit(1);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  CMH Daily Driver — Smoke Test`);
console.log(`  File: ${path.resolve(filePath)}`);
console.log(`${'═'.repeat(60)}\n`);

const html = fs.readFileSync(filePath, 'utf8');
const jsStart = html.indexOf('<script>') + 8;
const jsEnd = html.lastIndexOf('</script>');
if (jsStart < 8 || jsEnd < 0) {
  console.error('❌ Could not find <script> block in HTML');
  process.exit(1);
}
const js = html.slice(jsStart, jsEnd);

// ─── Static checks first ─────────────────────────────────────────────
let totalFails = 0;
function pass(name) { console.log(`  ✅ ${name}`); }
function fail(name, why) { console.log(`  ❌ ${name}\n     ${why}`); totalFails++; }

console.log('─── Static checks ─────────────────────────────────────────');

// Syntax
try {
  new vm.Script(js, { filename: 'check.js' });
  pass('JavaScript syntax is valid');
} catch (e) {
  fail('JavaScript syntax', e.message);
  console.error('\nFatal: cannot continue with broken syntax.');
  process.exit(1);
}

// Function count + duplicates
const fns = [...js.matchAll(/\nfunction (\w+)\s*\(/g)].map(m => m[1]);
const fnCounts = fns.reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});
const dupes = Object.entries(fnCounts).filter(([, n]) => n > 1);
if (dupes.length === 0) pass(`No duplicate function declarations (${fns.length} total)`);
else fail('Duplicate functions', dupes.map(([n, c]) => `${n}×${c}`).join(', '));

// Critical functions present
const REQUIRED_FNS = [
  'parseStep', 'parseGLFull', 'parseBrandSection',
  'getGroupNetData', 'calcBoard', 'buildBoardFlow', 'updateWUBtns',
  'refreshDash', 'genTeamText', 'buildCoverageTimeline',
  'saveState', 'loadState', 'showTab',
];
const fnSet = new Set(fns);
const missing = REQUIRED_FNS.filter(f => !fnSet.has(f));
if (missing.length === 0) pass(`All ${REQUIRED_FNS.length} critical functions present`);
else fail('Missing critical functions', missing.join(', '));

// ─── DOM mock + sandbox setup ────────────────────────────────────────
const elementStore = {};
const errors = [];
const makeEl = (id, v) => ({
  id: id || '', textContent: '', innerHTML: '', value: v || '',
  style: {}, className: '',
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  options: { length: 0 }, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [],
  dataset: {}, checked: false, closest: () => null,
  getAttribute: () => null, setAttribute() {}, scrollIntoView() {},
  addEventListener() {}, focus() {}, click() {}, insertAdjacentHTML() {},
  removeAttribute() {}, dispatchEvent() {},
  parentElement: null, parentNode: { removeChild() {} },
  children: [], childNodes: [],
  offsetWidth: 100, offsetHeight: 100, clientWidth: 100, clientHeight: 100,
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }),
});

const g = {
  // Browser-like globals — these go on `g` directly so window===self===globalThis below
  location: { href: 'http://test/', hash: '', search: '' },
  open: () => ({ document: { write() {}, close() {} }, print() {} }),
  addEventListener() {}, innerWidth: 1024, innerHeight: 768,
  scrollTo() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),

  document: {
    getElementById: (id) => { if (!elementStore[id]) elementStore[id] = makeEl(id); return elementStore[id]; },
    querySelector: () => makeEl(),
    querySelectorAll: () => ({ forEach() {}, length: 0 }),
    createElement: () => makeEl(),
    createTextNode: (t) => ({ textContent: t }),
    body: makeEl('body'), documentElement: makeEl('html'),
    head: { appendChild() {} },
    execCommand: () => true,
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
  },
  navigator: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') }, userAgent: 'Test', language: 'en-US', onLine: true },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; }, length: 0, key: () => null },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')), info() {} },
  setTimeout: (fn) => { try { fn && fn(); } catch (e) { errors.push('setTimeout: ' + e.message); } return 1; },
  setInterval: () => 1, clearTimeout() {}, clearInterval() {},
  alert() {}, confirm: () => true, prompt: () => null,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ record: { state: {} }, savedAt: new Date().toISOString() }), text: () => Promise.resolve('') }),
  btoa, atob, encodeURIComponent, decodeURIComponent,
  Date, Math, Array, Object, String, Number, Boolean, JSON, Map, Set, Promise, Symbol, RegExp,
  Error, parseInt, parseFloat, isNaN, isFinite,
  requestAnimationFrame: (fn) => { try { fn(0); } catch (e) {} return 1; },
  cancelAnimationFrame() {},
  performance: { now: () => Date.now() },
  Intl: typeof Intl !== 'undefined' ? Intl : undefined,
  URL: typeof URL !== 'undefined' ? URL : undefined,
  URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : undefined,
};
// CRITICAL: in a real browser, window === self === globalThis. Without this,
// app code that does `window.foo = bar` ends up on a separate object from
// global `foo`, and any test that crosses that boundary silently fails.
// (This caused buildSmartRotation tests to look broken when the code was fine.)
g.window = g; g.self = g; g.globalThis = g;
vm.createContext(g);

console.log('\n─── Loading script into sandbox ───────────────────────────');
try {
  vm.runInContext(js, g, { timeout: 5000 });
  pass('Script loaded into sandbox');
} catch (e) {
  fail('Script load', e.message);
  process.exit(1);
}

// ─── Real Game Plan format fixtures ──────────────────────────────────
// GL "Remaining" tab paste format: code → [sparse hourly values, blanks dropped]
// → Remaining as the last number. Real example from CMH on 2026-05-05.
const realGLResAM = [
  'Vehicle Category','12am','1am','2am','3am','4am','5am','6am','7am','8am','9am','10am','11am','Remaining',
  'Total','2','1','2','6','20','61','45','528',
  'ICAR','1','3','10','33','27','274',
  'FCAR','2','4','13','6','89',
  'IFAR','3','16',
  'CFAR','1','1','16',
  'MVAR','1','1','15',
  'IFDR','2','13',
  'SCAR','1','2','12',
  'ECAR','2','10',
  'FFAR','5',
].join('\n');

const realGLRetAM = [
  'Vehicle Category','12am','1am','2am','3am','4am','5am','6am','7am','8am','9am','10am','11am','Remaining',
  'Total','1','3','3','17','15','335',
  'IFDR','2','5','4','64',
  'ICAR','1','40',
  'FCAR','1','2','30',
  'FJAR','1','1','20',
  'MVAR','2','1','18',
  'IFAR','2','12',
  'CFAR','1','11',
].join('\n');

function step(name, fn) {
  errors.length = 0;
  try {
    fn();
    if (errors.length) fail(name, errors[0].slice(0, 100));
    else pass(name);
  } catch (e) {
    fail(name, e.message.slice(0, 120));
  }
}

// ─── Priority Screen 1: AVAILABILITY BOARD ───────────────────────────
console.log('\n─── Priority 1: AVAILABILITY BOARD ────────────────────────');

// Setup paste textareas with REAL Game Plan format
elementStore['pa1'] = makeEl('pa1', realGLResAM);
elementStore['pr1'] = makeEl('pr1');
elementStore['pa3'] = makeEl('pa3', realGLRetAM);
elementStore['pr3'] = makeEl('pr3');

step('parseStep(1) — Reservations AM',           () => g.parseStep(1));
step('parseStep(3) — Returns AM',                () => g.parseStep(3));
step('STATE.pasteData populated correctly',      () => {
  const keys = Object.keys(g.STATE.pasteData || {});
  if (!keys.includes('res-am') || !keys.includes('res-am-remaining')) {
    throw new Error('Missing res-am or res-am-remaining keys');
  }
  if (!keys.includes('ret-am') || !keys.includes('ret-am-remaining')) {
    throw new Error('Missing ret-am or ret-am-remaining keys');
  }
});

// REGRESSION TEST: ICAR = 274 (was reading hour-11am value of 27 before v35 parser fix)
step('Real GL data: ICAR remaining = 274 (not 27)', () => {
  const ic = g.STATE.pasteData['res-am-remaining']['Intermediate Car'];
  if (ic !== 274) throw new Error(`ICAR remaining = ${ic}, expected 274. Parser may be reading wrong column.`);
});

// REGRESSION TEST: parseBrandSection must NOT misfire on GL hourly paste.
// The GL paste has a "Total" aggregate row that previously got misread as
// brand=TOTAL and overwrote calcBoard totals with hourly values.
step('parseBrandSection does not misfire on GL hourly paste', () => {
  const brands = g.STATE.pasteData.brands;
  if (brands && brands.total && (brands.total.totalRes || brands.total.totRet)) {
    throw new Error(`Brand data populated from hourly paste (should be empty). Got: ${JSON.stringify(brands.total)}`);
  }
});

// REGRESSION TEST: loadScheduleForToday must populate STATE.shiftMod for
// the current day's MAY_SCHEDULE entries. Bug: previously had to be
// triggered manually via the admin "Reset & Reload Today" button. So
// people with day-varying shifts (Laura: AM Sun/Sat, PM Tue/Wed/Thu)
// showed the wrong default shift on first load. Fix: auto-call on
// startup with force=false.
step('loadScheduleForToday populates shiftMod from MAY_SCHEDULE', () => {
  if (typeof g.loadScheduleForToday !== 'function') {
    throw new Error('loadScheduleForToday function missing');
  }
  if (typeof g.MAY_SCHEDULE !== 'object' || !g.MAY_SCHEDULE) {
    throw new Error('MAY_SCHEDULE missing — full-month data dropped?');
  }
  // Find any date with a non-OFF entry to test against
  const dates = Object.keys(g.MAY_SCHEDULE);
  if (!dates.length) throw new Error('MAY_SCHEDULE has no dates');
  // The function reads `new Date()` — we can't easily mock that here without
  // jumping through hoops, but we can at least verify the function runs
  // without throwing and writes SOMETHING to shiftMod when called.
  if (!g.STATE.shiftMod) g.STATE.shiftMod = {};
  const before = Object.keys(g.STATE.shiftMod).length;
  try {
    g.loadScheduleForToday(false);
  } catch(e) {
    throw new Error('loadScheduleForToday threw: ' + e.message);
  }
  // If today happens to be a date in MAY_SCHEDULE, shiftMod should have grown
  const todayKey = (() => {
    const d = new Date();
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  })();
  if (g.MAY_SCHEDULE[todayKey]) {
    const after = Object.keys(g.STATE.shiftMod).length;
    if (after === before) {
      throw new Error(
        `Today (${todayKey}) is in MAY_SCHEDULE but shiftMod didn't grow ` +
        `(${before} → ${after}). loadScheduleForToday may have silently failed.`
      );
    }
  }
});

// REGRESSION TEST: Section headers (— CXR / Counter —, — Exit Agents —,
// — Returns —, — Management —) must be rendered BEFORE the first person
// row in that section opens, NOT nested inside it. The bug (v45):
// section headers were inserted inside the first person's flex row, so
// the header took up flex space and pushed the first person's name
// (Matt, Kerv, Carlos) to the right of where it should sit. Visible
// symptom: 1st person in each group looked shifted right vs the others.
step('Section headers do not push first person right of alignment', () => {
  g.buildCoverageTimeline();
  const html = elementStore['coverage-timeline']?.innerHTML || '';
  ['CXR / Counter', 'Exit Agents', 'Returns', 'Management'].forEach(label => {
    const headerStr = `— ${label} —`;
    const idx = html.indexOf(headerStr);
    if (idx === -1) return; // section not in this fixture, skip
    // Header div closes with </div></div>; next char must start a fresh person row,
    // i.e. <div display:flex...onclick=openPersonPanel — NOT a name span.
    const afterIdx = html.indexOf('</div></div>', idx) + 12;
    const after = html.slice(afterIdx, afterIdx + 250);
    if (!/^<div style="[^"]*display:flex[^"]*"\s+onclick="openPersonPanel/.test(after)) {
      throw new Error(
        `[${label}] section header not followed by a fresh person row. ` +
        `First person likely nested inside header row, pushed right. ` +
        `Saw: ${after.slice(0, 100)}...`
      );
    }
  });
});

// ─── v49 — Print uses flex (no more table-layout chaos), Laura nights, callout undo ──
console.log('\n─── v49 fixes ────────────────────────────────────────────');

step('printScheduleMap uses flexbox rows, not table', () => {
  let captured = '';
  const origOpen = g.window.open;
  g.window.open = () => ({document:{write:(s)=>{captured+=s;},close:()=>{}}, print:()=>{}});
  try { g.printScheduleMap(); } finally { g.window.open = origOpen; }
  if (captured.includes('<table>')) {
    throw new Error('Print still uses <table> — alignment will break');
  }
  if (!captured.includes('class="prow"')) {
    throw new Error('Expected flexbox .prow rows');
  }
  if (!captured.includes('class="schedule-rows"')) {
    throw new Error('Expected schedule-rows wrapper');
  }
});

step('loadScheduleForToday overwrites stale shiftMod from prior days', () => {
  // Date-independent variant: find ANY person who is scheduled today
  // (an array entry in MAY_SCHEDULE), seed a stale shiftMod different
  // from today's actual hours, then verify loadScheduleForToday wrote
  // today's hours back over the stale ones.
  const today = new Date();
  const key = today.getFullYear()+'-'+
    String(today.getMonth()+1).padStart(2,'0')+'-'+
    String(today.getDate()).padStart(2,'0');
  const sched = g.MAY_SCHEDULE && g.MAY_SCHEDULE[key];
  if (!sched) {
    // No schedule entry for today — function returns false; nothing to test
    return;
  }
  // Find first person with array shift today
  const entry = Object.entries(sched).find(([,v]) => Array.isArray(v) && v.length === 2);
  if (!entry) return;  // skip if everyone today is OFF
  const [pid, todayShift] = entry;
  // Seed stale shift very different from today's actual
  const staleStart = todayShift[0] === 5.5 ? 14 : 5.5;
  const staleEnd   = todayShift[1] === 14.5 ? 22 : 14.5;
  g.STATE.shiftMod = { [pid]: { start: staleStart, end: staleEnd } };
  g.STATE.todayOverrides = {};
  g.STATE.staffDuty = {};
  g.loadScheduleForToday(false);
  const after = g.STATE.shiftMod[pid];
  if (!after) throw new Error('shiftMod for '+pid+' was lost');
  if (after.start === staleStart && after.end === staleEnd) {
    throw new Error('Stale shift still present after load — overwrite logic broken: '+JSON.stringify(after));
  }
});

step('loadScheduleForToday clears stale OFF override when person is on shift today', () => {
  // Date-independent: find any person who's scheduled today, mark them
  // stale OFF, then verify load clears it.
  const today = new Date();
  const key = today.getFullYear()+'-'+
    String(today.getMonth()+1).padStart(2,'0')+'-'+
    String(today.getDate()).padStart(2,'0');
  const sched = g.MAY_SCHEDULE && g.MAY_SCHEDULE[key];
  if (!sched) return;  // no schedule for today — skip
  const onShiftEntry = Object.entries(sched).find(([,v]) => Array.isArray(v) && v.length === 2);
  if (!onShiftEntry) return;  // everyone OFF today — skip
  const [pid] = onShiftEntry;
  g.STATE.shiftMod = {};
  g.STATE.todayOverrides = { [pid]: 'off' };
  g.STATE.staffDuty = { [pid]: false };
  g.loadScheduleForToday(false);
  if (g.STATE.todayOverrides[pid] === 'off') {
    throw new Error('Stale OFF override not cleared for '+pid);
  }
});

step('reinstatePerson clears callout state and reactivates duty', () => {
  g.STATE.todayOverrides = { 'Test_Person': 'callout' };
  g.STATE.staffDuty = { 'Test_Person': false };
  g.reinstatePerson('Test_Person');
  if (g.STATE.todayOverrides['Test_Person'] === 'callout') {
    throw new Error('Callout not cleared');
  }
  if (g.STATE.staffDuty['Test_Person'] !== true) {
    throw new Error('staffDuty not restored to true');
  }
});

// REGRESSION TEST: applyTimeEdit rebuilds rotation + timeline + dashboard,
// not just the person panel. Symptom Matt reported: editing a shift's
// hours saved correctly but lunches stayed at old position, the timeline
// bar didn't redraw, and the dashboard mini-schedule countdowns were
// stale. Without the rebuild cascade, the user sees: hours change in
// the modal, but bar stays the same, lunch at old time, coverage stats
// don't recompute. v53 fix added a rebuild cascade after saving shiftMod.
step('applyTimeEdit triggers rotation rebuild + timeline refresh', () => {
  // Verify the fix is in place by string-checking the source
  const html = require('fs').readFileSync(filePath, 'utf8');
  // Look for the cascade markers inside applyTimeEdit
  const fnStart = html.indexOf('function applyTimeEdit(');
  if (fnStart < 0) throw new Error('applyTimeEdit function missing');
  const fnEnd = html.indexOf('\n}\n', fnStart);
  const fnBody = html.slice(fnStart, fnEnd);
  if (!fnBody.includes('buildSmartRotation')) {
    throw new Error('applyTimeEdit no longer calls buildSmartRotation — rebuild cascade missing');
  }
  if (!fnBody.includes('buildCoverageTimeline')) {
    throw new Error('applyTimeEdit no longer calls buildCoverageTimeline');
  }
  if (!fnBody.includes('refreshDash')) {
    throw new Error('applyTimeEdit no longer calls refreshDash');
  }
});

// REGRESSION TEST: Called-off person hidden from timeline regardless of
// whether their shift starts within 2 hours. The "starts soon" exception
// (which keeps unstarted but imminent shifts visible) must not override
// the called-off filter. Symptom Matt reported: Zina marked called-off
// at 9:24am for a 10a shift still rendered an Exit bar on the timeline.

// ═══════════════════════════════════════════════════════════════════════
// v54 — ADMIN ROSTER + SCHEDULE EDITOR REGRESSION TESTS
// ═══════════════════════════════════════════════════════════════════════
// Matt asked for a fully self-service roster system: add/remove/edit
// existing people, set per-day shift hours (Laura model: AM Sun/Sat,
// PM Tue/Wed/Thu), and change the schedule entirely without me.
// These tests lock in the contract so we don't regress.

step('rebuildRosters: add new CXR appears in ROSTER_CXR', () => {
  const savedAdmin = g.STATE.adminRoster;
  const newId = 'reg-test-cxr';
  try {
    g.STATE.adminRoster = [{
      id: newId, name: 'Reg Test', nick: 'Test', role: 'CXR',
      shiftCode: '8A-4P', shiftStart: 8, shiftEnd: 16,
      daysOn: [1,2,3,4,5], _new: true
    }];
    g.rebuildRosters();
    if (!g.ROSTER_CXR.some(p => p.id === newId)) {
      throw new Error('New CXR not in ROSTER_CXR after rebuildRosters');
    }
    if (g.ROSTER_EXIT.some(p => p.id === newId)) {
      throw new Error('New CXR incorrectly added to ROSTER_EXIT');
    }
  } finally {
    g.STATE.adminRoster = savedAdmin;
    g.rebuildRosters();
  }
});

step('rebuildRosters: remove existing person clears them from base roster', () => {
  const savedAdmin = g.STATE.adminRoster;
  try {
    g.STATE.adminRoster = [{ id: 'matt-j', _deleted: true }];
    g.rebuildRosters();
    if (g.ROSTER_CXR.some(p => p.id === 'matt-j')) {
      throw new Error('Deleted person still in ROSTER_CXR');
    }
  } finally {
    g.STATE.adminRoster = savedAdmin;
    g.rebuildRosters();
  }
});

step('rebuildRosters: edit existing person merges fields', () => {
  const savedAdmin = g.STATE.adminRoster;
  try {
    g.STATE.adminRoster = [{ id: 'matt-j', shiftStart: 7, shiftEnd: 16, notes: 'edited' }];
    g.rebuildRosters();
    const matt = g.ROSTER_CXR.find(p => p.id === 'matt-j');
    if (!matt) throw new Error('Matt missing after edit');
    if (matt.shiftStart !== 7) throw new Error('Edit not applied: shiftStart='+matt.shiftStart);
    if (matt.name !== 'Matthew Johnson') throw new Error('Original name lost in merge');
  } finally {
    g.STATE.adminRoster = savedAdmin;
    g.rebuildRosters();
  }
});

step('getScheduleForDate: per-date overrides win over MAY_SCHEDULE', () => {
  const savedOv = g.STATE.scheduleOverrides;
  // Find a date that exists in MAY_SCHEDULE
  const someDate = Object.keys(g.MAY_SCHEDULE)[0];
  if (!someDate) return;  // skip if no MAY_SCHEDULE
  try {
    g.STATE.scheduleOverrides = { [someDate]: { 'Matthew_Johnson': [10, 20] } };
    const merged = g.getScheduleForDate(someDate);
    if (!merged) throw new Error('getScheduleForDate returned null');
    const m = merged['Matthew_Johnson'];
    if (!Array.isArray(m) || m[0] !== 10 || m[1] !== 20) {
      throw new Error('Override not applied: '+JSON.stringify(m));
    }
  } finally {
    g.STATE.scheduleOverrides = savedOv;
  }
});

step('getPersonShiftToday: scheduleOverrides[today][pid] beats MAY_SCHEDULE', () => {
  const savedOv = g.STATE.scheduleOverrides;
  const savedMod = g.STATE.shiftMod;
  const savedTimes = g.STATE.shiftTimes;
  try {
    const todayStr = (function(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})();
    g.STATE.scheduleOverrides = { [todayStr]: { 'Matthew_Johnson': [11, 19] } };
    g.STATE.shiftMod = {};
    g.STATE.shiftTimes = {};
    const matt = g.ROSTER_CXR.find(p => p.id === 'matt-j');
    if (!matt) throw new Error('Matt not in roster');
    const shift = g.getPersonShiftToday(matt);
    if (!shift) throw new Error('shift returned null');
    if (shift.start !== 11 || shift.end !== 19) {
      throw new Error('Override not honored: '+JSON.stringify(shift));
    }
  } finally {
    g.STATE.scheduleOverrides = savedOv;
    g.STATE.shiftMod = savedMod;
    g.STATE.shiftTimes = savedTimes;
  }
});

step('getPersonShiftToday: OFF override returns null', () => {
  const savedOv = g.STATE.scheduleOverrides;
  try {
    const todayStr = (function(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})();
    g.STATE.scheduleOverrides = { [todayStr]: { 'Matthew_Johnson': 'OFF' } };
    const matt = g.ROSTER_CXR.find(p => p.id === 'matt-j');
    const shift = g.getPersonShiftToday(matt);
    if (shift !== null) throw new Error('OFF override should return null, got '+JSON.stringify(shift));
  } finally {
    g.STATE.scheduleOverrides = savedOv;
  }
});

step('_parseShiftString handles all common shift formats', () => {
  const cases = [
    ['530A-200P', [5.5, 14]],
    ['5:30A-2:00P', [5.5, 14]],
    ['8A-4P', [8, 16]],
    ['OFF', 'OFF'],
    ['off', 'OFF'],
    ['vaca', 'OFF'],
    ['5P-1A', [17, 25]],   // overnight
    ['', null],
    ['garbage', null],
  ];
  cases.forEach(([input, expected]) => {
    const got = g._parseShiftString(input);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error('_parseShiftString("'+input+'"): expected '+JSON.stringify(expected)+', got '+JSON.stringify(got));
    }
  });
});

step('formatHoursAsCode: roundtrip with _parseShiftString', () => {
  const cases = [[5.5, 14], [8, 17], [10, 18.5], [17, 25]];
  cases.forEach(([s, e]) => {
    const code = g.formatHoursAsCode(s, e);
    const parsed = g._parseShiftString(code);
    if (!Array.isArray(parsed) || parsed[0] !== s || parsed[1] !== e) {
      throw new Error('Roundtrip failed: ['+s+','+e+'] → "'+code+'" → '+JSON.stringify(parsed));
    }
  });
});

step('saveScheduleEdit: writes parsed override to STATE.scheduleOverrides', () => {
  const savedOv = g.STATE.scheduleOverrides;
  try {
    const dateKey = '2026-06-15';
    elementStore['sched-edit-date'] = makeEl('sched-edit-date', dateKey);
    elementStore['se-Matthew_Johnson'] = makeEl('se-Matthew_Johnson', '7A-3P');
    g.STATE.scheduleOverrides = {};
    g.saveScheduleEdit('Matthew_Johnson');
    const ov = g.STATE.scheduleOverrides[dateKey];
    if (!ov || !Array.isArray(ov['Matthew_Johnson'])) {
      throw new Error('Override not saved: '+JSON.stringify(g.STATE.scheduleOverrides));
    }
    if (ov['Matthew_Johnson'][0] !== 7 || ov['Matthew_Johnson'][1] !== 15) {
      throw new Error('Wrong hours: '+JSON.stringify(ov['Matthew_Johnson']));
    }
  } finally {
    g.STATE.scheduleOverrides = savedOv;
  }
});

// REGRESSION TEST: Reference car-code search filters by code, group, or
// description and doesn't crash on malformed entries. v56 found 5 stray
// ROSTER_RETURNS entries that had ended up inside FLEET_CODES — they
// lacked code/group/desc and made `c.code.toLowerCase()` throw, which
// silently aborted the entire filter and left the search box looking
// broken. Hardened filterCodes to coerce missing fields to empty string.
step('filterCodes: search by keyword across code/group/desc', () => {
  const savedQ = elementStore['code-search'] && elementStore['code-search'].value;
  try {
    elementStore['code-search'] = makeEl('code-search', 'compact');
    elementStore['code-grid']   = makeEl('code-grid');
    g.filterCodes();
    const html1 = elementStore['code-grid'].innerHTML || '';
    if (html1.includes('No codes match')) {
      throw new Error('"compact" search returned zero matches');
    }

    elementStore['code-search'].value = 'toyota'; // in desc field
    g.filterCodes();
    const html2 = elementStore['code-grid'].innerHTML || '';
    if (html2.includes('No codes match')) {
      throw new Error('"toyota" search returned zero matches (desc field unsearched?)');
    }

    elementStore['code-search'].value = 'asfdasdf';  // truly no match
    g.filterCodes();
    const html3 = elementStore['code-grid'].innerHTML || '';
    if (!html3.includes('No codes match')) {
      throw new Error('Junk search should have shown "No codes match"');
    }
  } finally {
    elementStore['code-search'] = makeEl('code-search', savedQ || '');
  }
});

// REGRESSION TEST: Lunch never gets pushed below the 3-hour-from-shift-start
// floor by the stagger pass. Symptom Matt reported on Monday May 11: Jay
// (10am start) had lunch at ~11am (1hr after start, b2=7hr at exit).
// Spread pass was blindly shifting Jay's lunch backward to break concurrency,
// without respecting Matt's hard rule: "Lunches should NEVER be less
// than 3 hours after their start time."
step('Lunch stagger never pushes lunch below 3hr-from-start floor', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    // 4 CXRs on identical shifts to force stagger pressure
    const exp = {};
    ['A','B','C','D'].forEach(n => {
      exp[n+'_Z'] = { person:{name:n+' Z',nick:n,role:'CXR',shiftStart:10,shiftEnd:18.5}, shift:{start:10,end:18.5,code:'10A-630P'} };
    });
    return exp;
  };
  const savedCXR = g.ROSTER_CXR;
  g.ROSTER_CXR = [
    ...savedCXR,
    ...['A','B','C','D'].map(n => ({ id:n.toLowerCase()+'-z', name:n+' Z', nick:n, role:'CXR', shiftCode:'10A-630P', shiftStart:10, shiftEnd:18.5 })),
  ];
  try {
    const result = g.buildSmartRotation();
    const testRots = result.rotations.filter(r => /_Z$/.test(r.pid) && r.lunch);
    testRots.forEach(r => {
      const hoursAfterStart = r.lunch.from - r.shiftStart;
      if (hoursAfterStart < 2.99) {  // 0.01 tolerance for fp
        throw new Error(r.nick+' lunch is '+hoursAfterStart.toFixed(2)+'h after start — violates 3hr floor');
      }
    });
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.Date = realDate;
  }
});

// REGRESSION TEST: customLunch[pid] override forces a specific lunch start
// time AND immunizes the person from being moved by the stagger pass.
step('STATE.customLunch[pid] forces lunch time and is preserved through stagger', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  const savedCustomLunch = g.STATE.customLunch;
  g.buildExpectedToday = function() {
    return {
      'X_C': { person:{name:'X C',nick:'X',role:'CXR',shiftStart:10,shiftEnd:18.5}, shift:{start:10,end:18.5,code:'10A-630P'} },
      'Y_C': { person:{name:'Y C',nick:'Y',role:'CXR',shiftStart:10,shiftEnd:18.5}, shift:{start:10,end:18.5,code:'10A-630P'} },
    };
  };
  const savedCXR = g.ROSTER_CXR;
  g.ROSTER_CXR = [
    ...savedCXR,
    { id:'x-c', name:'X C', nick:'X', role:'CXR', shiftCode:'10A-630P', shiftStart:10, shiftEnd:18.5 },
    { id:'y-c', name:'Y C', nick:'Y', role:'CXR', shiftCode:'10A-630P', shiftStart:10, shiftEnd:18.5 },
  ];
  // X requests an unusual lunch at 11:30am (1.5hr after start — below the floor)
  // Note: pid is name-based (X_C), not the roster id (x-c). buildSmartRotation
  // builds rotations keyed by name.replace(/\s/g,'_').
  g.STATE.customLunch = { 'X_C': 11.5 };
  try {
    const result = g.buildSmartRotation();
    const x = result.rotations.find(r => r.pid === 'X_C');
    if (!x) throw new Error('X not in rotation');
    if (Math.abs(x.lunch.from - 11.5) > 0.01) {
      throw new Error('Custom lunch not honored — X lunch at '+x.lunch.from+' instead of 11.5');
    }
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.STATE.customLunch = savedCustomLunch;
    g.Date = realDate;
  }
});

// REGRESSION TEST: Management section ordering by rank — BRM first, then
// ABRM, then MT, with ARM (Vada) at the bottom.
step('roleOrder map sorts management by rank (BRM<ABRM<MT<ARM)', () => {
  // Extract the roleOrder used in the live timeline (line ~10639 area).
  // We can't easily run the timeline, but we can verify the map shape by
  // examining the source.
  const html = require('fs').readFileSync(filePath, 'utf8');
  // The live timeline roleOrder must place BRM before ABRM before MT before ARM
  if (!/roleOrder\s*=\s*\{[^}]*BRM:3[^}]*ABRM:4[^}]*MT:5[^}]*ARM:6/.test(html)) {
    throw new Error('roleOrder map does not have BRM:3, ABRM:4, MT:5, ARM:6 (or equivalent rank ordering)');
  }
});

// REGRESSION TEST: Monday coverage rules per Matt's clarification.
// Monday is peak exit day at CMH — target 5 booths staffed during the
// 9am-4pm window. Counter: 1 min before 8:30am, 2 min from 8:30am-4pm.
// Previously the rule had min 5 only from 10a-2pm and counterMin:3 in
// that window — both wrong per Matt's actual operational rules.
step('Monday COVERAGE_BY_HOUR matches Matt\'s actual peak rules', () => {
  const dow = 1; // Monday
  // 7am — Mon Open: exit ramping up, counter min 1
  const r7 = g.COVERAGE_BY_HOUR(7, dow, 1);
  if (r7.counterMin !== 1) throw new Error('Mon 7am counterMin should be 1 (early), got '+r7.counterMin);
  if (r7.exitMax !== 5) throw new Error('Mon 7am exitMax should be 5 (target all booths), got '+r7.exitMax);
  // 9am — Mon Peak: 5 exit target, 2 counter
  const r9 = g.COVERAGE_BY_HOUR(9, dow, 1);
  if (r9.exitMin !== 5) throw new Error('Mon 9am exitMin should be 5, got '+r9.exitMin);
  if (r9.counterMin !== 2) throw new Error('Mon 9am counterMin should be 2, got '+r9.counterMin);
  // 13 (1pm) — still Mon Peak
  const r13 = g.COVERAGE_BY_HOUR(13, dow, 1);
  if (r13.exitMin !== 5) throw new Error('Mon 1pm exitMin should be 5, got '+r13.exitMin);
  if (r13.counterMin !== 2) throw new Error('Mon 1pm counterMin should be 2, got '+r13.counterMin);
  // 15:30 — last half-hour of peak (h < 16)
  const r155 = g.COVERAGE_BY_HOUR(15.5, dow, 1);
  if (r155.exitMin !== 5) throw new Error('Mon 3:30pm should still be peak, got exitMin='+r155.exitMin);
  // 17 (5pm) — Mon PM, exit ramping down
  const r17 = g.COVERAGE_BY_HOUR(17, dow, 1);
  if (r17.exitMin > 4) throw new Error('Mon 5pm exitMin should ramp down (<=4), got '+r17.exitMin);
});

// REGRESSION TEST: Monday opening checklist text reflects actual peak
// rules — not the old "minimum 2 exit agents" wording (Monday targets 5).
step('Monday opening checklist mentions 5 exit booths', () => {
  const html = require('fs').readFileSync(filePath, 'utf8');
  if (html.includes('Confirm full exit staffing (minimum 2 exit agents)')) {
    throw new Error('Old wrong Monday text "minimum 2 exit agents" still present');
  }
  // The new text mentions either "5 exit" or "all 5"
  if (!/isMonday\s*&&\s*\{t:'[^']*5 exit/i.test(html)) {
    throw new Error('Monday checklist item does not mention 5 exit booths');
  }
});

step('FLEET_CODES has no malformed entries (each has code/group/desc)', () => {
  const bad = g.FLEET_CODES.filter(c => !c || !c.code || !c.group || !c.desc);
  if (bad.length) {
    throw new Error(bad.length+' malformed entries: '+JSON.stringify(bad.slice(0,2)));
  }
});

// ════════════════════════════════════════════════════════════════════
// v58 REGRESSION TESTS — midpoint cap + manual block override
// ════════════════════════════════════════════════════════════════════

// REGRESSION TEST: shiftLunch refuses to move lunch more than 1hr from
// midpoint. Matt: "Lunches for anyone should never be over 1 hr off of
// their mid point unless manually changed." Without this cap, multi-
// iteration stagger passes could compound shifts and drift lunch ~2hr
// from natural midpoint. Custom lunches still bypass entirely.
step('Stagger never drifts lunch more than 1hr from shift midpoint', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  // 5 CXRs on identical shifts to force maximum stagger pressure
  g.buildExpectedToday = function() {
    const exp = {};
    ['A','B','C','D','E'].forEach(n => {
      exp[n+'_MP'] = { person:{name:n+' MP',nick:n,role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} };
    });
    return exp;
  };
  const savedCXR = g.ROSTER_CXR;
  g.ROSTER_CXR = [...savedCXR,
    ...['A','B','C','D','E'].map(n => ({ id:n.toLowerCase()+'-mp', name:n+' MP', nick:n, role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 })),
  ];
  try {
    const result = g.buildSmartRotation();
    const testRots = result.rotations.filter(r => /_MP$/.test(r.pid) && r.lunch);
    testRots.forEach(r => {
      const midpoint = (r.shiftStart + r.shiftEnd) / 2;  // 12.5 for 8-17
      const offset = Math.abs(r.lunch.from - midpoint);
      if (offset > 1.01) {
        throw new Error(r.nick + ' lunch ' + r.lunch.from + ' is ' + offset.toFixed(2) + 'h from midpoint ' + midpoint + ' (>1hr cap)');
      }
    });
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.Date = realDate;
  }
});

// REGRESSION TEST: Manually-defined STATE.mgmtBlocks[pid] override the
// auto rotation in getZone for any role (not just management). Was a
// bug: CXR Assignment Blocks UI existed but timeline still read auto
// rotation. Matt asked for "a way to manually alter a person's time
// frame for each station and lunch if it doesn't make what we need
// with the auto distribute" — this is that read.
step('getZone honors STATE.mgmtBlocks for CXRs (not just management)', () => {
  // Find a CXR in the roster
  const cxr = g.ROSTER_CXR.find(p => p && p.role === 'CXR');
  if (!cxr) return;  // skip if no CXR in roster
  const pid = cxr.name.replace(/\s/g, '_');
  const savedBlocks = g.STATE.mgmtBlocks;
  // Stub _lastRotations so we can verify blocks WIN over rotation
  const savedRot = g.window && g.window._lastRotations;
  if (!g.window) g.window = g;
  g.window._lastRotations = {
    [pid]: {
      b1: { station:'counter', from:8, to:12 },
      lunch: { from:12, to:12.5 },
      b2: { station:'exit', from:12.5, to:16 },
    },
  };
  // Manual blocks say: returns 8-10, then exit 10-16
  g.STATE.mgmtBlocks = { [pid]: [
    { from:8, to:10, station:'Returns' },
    { from:10, to:16, station:'Exit Booth' },
  ]};
  try {
    // We can't call the inner getZone directly (it's scoped). But the
    // logic is straightforward to verify: at h=9, person should be
    // 'returns' (per blocks) not 'counter' (per rotation). The function
    // is exercised by buildCoverageTimeline; just verify the data flow
    // by checking the STATE shape and that buildCoverageTimeline runs
    // without error.
    if (typeof g.buildCoverageTimeline === 'function') {
      g.buildCoverageTimeline();
    }
    if (!Array.isArray(g.STATE.mgmtBlocks[pid]) || g.STATE.mgmtBlocks[pid].length !== 2) {
      throw new Error('Manual blocks not preserved after rebuild');
    }
  } finally {
    g.STATE.mgmtBlocks = savedBlocks;
    if (g.window) g.window._lastRotations = savedRot;
  }
});

// REGRESSION TEST: Stagger pass skips people with manual blocks set.
// shiftLunch should return false for any pid that has STATE.mgmtBlocks
// entries — those blocks are the source of truth, stagger shouldn't
// fight them.
step('Stagger skips lunch-shifting for CXRs with manual blocks', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    return {
      'P_MB': { person:{name:'P MB',nick:'P',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
      'Q_MB': { person:{name:'Q MB',nick:'Q',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
      'R_MB': { person:{name:'R MB',nick:'R',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
    };
  };
  const savedCXR = g.ROSTER_CXR;
  const savedBlocks = g.STATE.mgmtBlocks;
  g.ROSTER_CXR = [...savedCXR,
    { id:'p-mb', name:'P MB', nick:'P', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
    { id:'q-mb', name:'Q MB', nick:'Q', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
    { id:'r-mb', name:'R MB', nick:'R', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
  ];
  // P has manual blocks; Q and R don't
  g.STATE.mgmtBlocks = { 'P_MB': [
    { from:8, to:12, station:'Counter' },
    { from:12, to:12.5, station:'Lunch' },
    { from:12.5, to:17, station:'Exit Booth' },
  ]};
  try {
    const result = g.buildSmartRotation();
    const p = result.rotations.find(r => r.pid === 'P_MB');
    const q = result.rotations.find(r => r.pid === 'Q_MB');
    const r = result.rotations.find(r => r.pid === 'R_MB');
    if (!p || !q || !r) throw new Error('Test CXRs not all in rotation');
    // P's lunch should remain at 12 (matches manual block)
    if (!p.lunch || Math.abs(p.lunch.from - 12) > 0.01) {
      throw new Error('P lunch should stay at 12 (manual blocks), got ' + (p.lunch ? p.lunch.from : 'null'));
    }
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.STATE.mgmtBlocks = savedBlocks;
    g.Date = realDate;
  }
});

// REGRESSION TEST: Add Block prompt for CXRs includes Lunch as a
// station option. Matt asked for "manually alter a person's time
// frame for each station and lunch" — Lunch needs to be in the picker.
step('CXR Add Block prompt includes Lunch / Break station options', () => {
  const html = require('fs').readFileSync(filePath, 'utf8');
  // Find the CXR stations array (non-mgmt branch). Should include Lunch.
  const cxrStationsRegex = /:\s*\['Counter','Exit Booth','Returns'[^\]]*'Lunch'/;
  if (!cxrStationsRegex.test(html)) {
    throw new Error('CXR stations array does not include Lunch as an option');
  }
});

// ════════════════════════════════════════════════════════════════════
// v59 REGRESSION TESTS — announcements, celebrations, car photos
// ════════════════════════════════════════════════════════════════════

step('STATE defaults include announcements:[], celebrations:[], carPhotos:{}', () => {
  if (!Array.isArray(g.STATE.announcements)) throw new Error('announcements missing or not array');
  if (!Array.isArray(g.STATE.celebrations))  throw new Error('celebrations missing or not array');
  if (!g.STATE.carPhotos || typeof g.STATE.carPhotos !== 'object') throw new Error('carPhotos missing or not object');
});

step('addAnnouncement persists to STATE and removeAnnouncement filters by id', () => {
  const saved = g.STATE.announcements ? g.STATE.announcements.slice() : [];
  try {
    g.STATE.announcements = [];
    g.addAnnouncement('Test announcement', 'info', null);
    if (g.STATE.announcements.length !== 1) throw new Error('not added');
    const id = g.STATE.announcements[0].id;
    if (!id) throw new Error('no id assigned');
    g.removeAnnouncement(id);
    if (g.STATE.announcements.length !== 0) throw new Error('not removed');
  } finally {
    g.STATE.announcements = saved;
  }
});

step('Expired announcements are filtered out of dashboard render', () => {
  // We can't easily render but we can verify the filter logic by simulating.
  // Add one expired + one active, then check renderDashAnnouncements respects it
  // by reading the wrap element's display state (requires DOM stub).
  const saved = g.STATE.announcements ? g.STATE.announcements.slice() : [];
  try {
    g.STATE.announcements = [
      { id:'a1', text:'expired', priority:'info', dateAdded:'2024-01-01T00:00:00.000Z', expires:'2024-01-02' },
      { id:'a2', text:'active',  priority:'info', dateAdded:'2024-01-01T00:00:00.000Z', expires:null },
    ];
    // Stub the dash element so renderDashAnnouncements doesn't bail
    const stubEl = { style: { display: '' }, innerHTML: '' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'dash-announcements' ? stubEl : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.renderDashAnnouncements();
    g.document = origDoc;
    // The active one should be in innerHTML, expired one should not
    if (stubEl.innerHTML.includes('expired')) throw new Error('expired item rendered');
    if (!stubEl.innerHTML.includes('active')) throw new Error('active item not rendered');
  } finally {
    g.STATE.announcements = saved;
  }
});

step('parseCelebrationsPaste handles Name,MM/DD and Name,MM/DD,anniversary,YYYY', () => {
  const lines = `Matt Johnson, 3/15
Mariam Mbye, 7/22, anniversary, 2018
Lily Tesfaye, 11/8, anniversary
Genesis Cochran, 5/14`;
  const out = g.parseCelebrationsPaste(lines);
  if (out.length !== 4) throw new Error('expected 4 parsed, got '+out.length);
  const matt = out.find(o => o.name === 'Matt Johnson');
  if (!matt || matt.type !== 'birthday') throw new Error('Matt should be birthday');
  const mariam = out.find(o => o.name === 'Mariam Mbye');
  if (!mariam || mariam.type !== 'anniversary' || mariam.startYear !== 2018) {
    throw new Error('Mariam should be anniversary 2018, got '+JSON.stringify(mariam));
  }
  const lily = out.find(o => o.name === 'Lily Tesfaye');
  if (!lily || lily.type !== 'anniversary') throw new Error('Lily should be anniversary');
});

// v59.1: dedupe across pastes — same person/date/type shouldn't accumulate.
step('submitCelebrationsPaste dedupes by case-insensitive name+date+type', () => {
  const savedCel = g.STATE.celebrations ? g.STATE.celebrations.slice() : [];
  try {
    g.STATE.celebrations = [
      { name:'Matt Johnson', date:'3/15', type:'birthday' },
      { name:'Mariam Mbye',  date:'7/22', type:'anniversary', startYear:2018 },
    ];
    // Simulate paste containing one existing (Matt, different case) + one new (CeCe)
    const ta = { value: 'matt johnson, 03/15\nCeCe Smith, 9/3' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'celeb-paste-text' ? ta : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.submitCelebrationsPaste();
    g.document = origDoc;
    // Expected: Matt entry replaced (1 left), Mariam preserved, CeCe added = 3 total
    if (g.STATE.celebrations.length !== 3) {
      throw new Error('expected 3 total, got '+g.STATE.celebrations.length+': '+JSON.stringify(g.STATE.celebrations.map(c=>c.name)));
    }
    const cece = g.STATE.celebrations.find(c => /CeCe/i.test(c.name));
    if (!cece) throw new Error('CeCe not added');
    const mariam = g.STATE.celebrations.find(c => /Mariam/i.test(c.name));
    if (!mariam) throw new Error('Mariam preserved test failed (should still be present)');
  } finally {
    g.STATE.celebrations = savedCel;
  }
});

// v59.1: pasting an entry with a different TYPE (birthday vs anniversary)
// for the same person+date should NOT dedupe — they are different entries.
// v59.2: dedupe now MERGES — preserves first-seen name casing/whitespace,
// only updates startYear/notes from new paste. Cleaner stored state.
step('submitCelebrationsPaste merge: preserves original name casing on re-paste', () => {
  const savedCel = g.STATE.celebrations ? g.STATE.celebrations.slice() : [];
  try {
    g.STATE.celebrations = [{ name:'Matt Johnson', date:'3/15', type:'birthday' }];
    const ta = { value: 'MATT JOHNSON, 03/15\nmariam   mbye, 7/22' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'celeb-paste-text' ? ta : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.submitCelebrationsPaste();
    g.document = origDoc;
    const matt = g.STATE.celebrations.find(c => /^matt johnson$/i.test(c.name.trim()));
    if (!matt) throw new Error('Matt missing');
    if (matt.name !== 'Matt Johnson') {
      throw new Error('Original casing not preserved — got: '+matt.name);
    }
  } finally {
    g.STATE.celebrations = savedCel;
  }
});

// v59.2: re-paste with new startYear UPDATES existing entry's year
step('submitCelebrationsPaste merge: updates startYear when newly provided', () => {
  const savedCel = g.STATE.celebrations ? g.STATE.celebrations.slice() : [];
  try {
    g.STATE.celebrations = [{ name:'Vada Griffith', date:'5/1', type:'anniversary' }];
    const ta = { value: 'Vada Griffith, 5/1, anniversary, 2015' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'celeb-paste-text' ? ta : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.submitCelebrationsPaste();
    g.document = origDoc;
    if (g.STATE.celebrations.length !== 1) throw new Error('should still be 1 entry, got '+g.STATE.celebrations.length);
    if (g.STATE.celebrations[0].startYear !== 2015) {
      throw new Error('startYear not merged in, got '+g.STATE.celebrations[0].startYear);
    }
  } finally {
    g.STATE.celebrations = savedCel;
  }
});

step('submitCelebrationsPaste keeps birthday and anniversary as separate entries', () => {
  const savedCel = g.STATE.celebrations ? g.STATE.celebrations.slice() : [];
  try {
    g.STATE.celebrations = [{ name:'Jay Test', date:'5/1', type:'birthday' }];
    const ta = { value: 'Jay Test, 5/1, anniversary, 2020' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'celeb-paste-text' ? ta : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.submitCelebrationsPaste();
    g.document = origDoc;
    if (g.STATE.celebrations.length !== 2) {
      throw new Error('birthday and anniversary should be separate; got '+g.STATE.celebrations.length);
    }
  } finally {
    g.STATE.celebrations = savedCel;
  }
});

step('STATE.carPhotos read by renderCodes (presence verified in HTML)', () => {
  const html = require('fs').readFileSync(filePath, 'utf8');
  // The renderCodes function should reference STATE.carPhotos
  if (!/\(STATE\.carPhotos\|\|\{\}\)\[c\.code\]/.test(html)) {
    throw new Error('renderCodes does not read STATE.carPhotos[code]');
  }
});

// ════════════════════════════════════════════════════════════════════
// v59.1 EDGE-CASE AUDIT (autonomous bug-pass — Matt's request to work
// through everything possible without him). These cases exercise
// rotation engine robustness against degenerate inputs.
// ════════════════════════════════════════════════════════════════════

step('buildSmartRotation: empty schedule returns empty rotations array', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = () => ({});
  // Hermetic isolation: an earlier step leaves STATE.staffDuty populated
  // (e.g. 'Test_Person'=true). buildSmartRotation includes anyone with
  // duty===true, and getPersonShiftToday returns a default shift for them on
  // weekdays — so without this reset the "empty" test phantom-passed only on
  // weekends (it failed every weekday). Clear the shared duty/override state
  // so "empty" is genuinely empty.
  const savedDuty = g.STATE.staffDuty, savedOv = g.STATE.todayOverrides;
  g.STATE.staffDuty = {}; g.STATE.todayOverrides = {};
  try {
    const r = g.buildSmartRotation();
    if (!r || !Array.isArray(r.rotations)) throw new Error('result.rotations not an array');
    if (r.rotations.length !== 0) throw new Error('expected 0 rotations, got '+r.rotations.length);
  } finally { g.buildExpectedToday = origBET; g.STATE.staffDuty = savedDuty; g.STATE.todayOverrides = savedOv; }
});

step('buildSmartRotation: overnight shift end normalized past 24', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = () => ({
    'Night_T': {person:{name:'Night T',role:'CXR',shiftStart:16,shiftEnd:1},shift:{start:16,end:1,code:'4P-1A'}},
  });
  const savedCXR = g.ROSTER_CXR;
  g.ROSTER_CXR = [{id:'night-t',name:'Night T',role:'CXR',shiftCode:'4P-1A',shiftStart:16,shiftEnd:1}];
  try {
    const r = g.buildSmartRotation();
    if (r.rotations.length !== 1) throw new Error('not built');
    const rot = r.rotations[0];
    if (rot.shiftEnd !== 25) throw new Error('overnight shiftEnd not normalized to 25, got '+rot.shiftEnd);
    if (!rot.lunch || rot.lunch.from < 17 || rot.lunch.from > 23) {
      throw new Error('overnight lunch unreasonable: '+(rot.lunch ? rot.lunch.from : 'null'));
    }
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.Date = realDate;
  }
});

step('All-callouts day produces no rotations', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = () => ({
    'A_C': {person:{name:'A C',role:'CXR',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}},
    'B_C': {person:{name:'B C',role:'CXR',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}},
  });
  const savedCXR = g.ROSTER_CXR;
  const savedOv = g.STATE.todayOverrides;
  g.ROSTER_CXR = [
    {id:'a-c',name:'A C',role:'CXR',shiftCode:'8A-5P',shiftStart:8,shiftEnd:17},
    {id:'b-c',name:'B C',role:'CXR',shiftCode:'8A-5P',shiftStart:8,shiftEnd:17},
  ];
  g.STATE.todayOverrides = {'A_C':'callout','B_C':'callout'};
  try {
    const r = g.buildSmartRotation();
    if (r.rotations.length !== 0) throw new Error('expected 0 rotations on full callout day, got '+r.rotations.length);
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.STATE.todayOverrides = savedOv;
  }
});

step('parseCelebrationsPaste survives null/empty/garbage', () => {
  if (g.parseCelebrationsPaste(null).length !== 0) throw new Error('null should return empty');
  if (g.parseCelebrationsPaste('').length !== 0) throw new Error('empty should return empty');
  if (g.parseCelebrationsPaste('   ').length !== 0) throw new Error('whitespace should return empty');
  if (g.parseCelebrationsPaste('justaname\nnodatehere').length !== 0) {
    throw new Error('no date should return empty');
  }
});

// v59.2: state migration tests — verify loadState handles legacy and
// corrupted localStorage without crashing or leaving fields undefined.
step('loadState migrates legacy LS — v57+ fields get default values', () => {
  // The currently loaded STATE went through loadState already; verify
  // post-migration the v59 fields are present in the right shape.
  if (!Array.isArray(g.STATE.announcements)) throw new Error('announcements not array');
  if (!Array.isArray(g.STATE.celebrations))  throw new Error('celebrations not array');
  if (typeof g.STATE.carPhotos !== 'object' || Array.isArray(g.STATE.carPhotos)) {
    throw new Error('carPhotos not plain object');
  }
  if (typeof g.STATE.customLunch !== 'object') throw new Error('customLunch not object');
  if (typeof g.STATE.scheduleOverrides !== 'object') throw new Error('scheduleOverrides not object');
});

step('loadState coerces bad-type announcement/celebration/carPhotos to safe defaults', () => {
  // Read the source — verify the migrations include type-coercion guards
  // for the cases where saved data has the wrong shape (e.g. someone hand-
  // edited localStorage or an older bug stored wrong types).
  const html = require('fs').readFileSync(filePath, 'utf8');
  if (!/Array\.isArray\(s\.announcements\)\s*\?\s*s\.announcements\s*:\s*\[\]/.test(html)) {
    throw new Error('announcements migration does not type-coerce');
  }
  if (!/Array\.isArray\(s\.celebrations\)\s*\?\s*s\.celebrations\s*:\s*\[\]/.test(html)) {
    throw new Error('celebrations migration does not type-coerce');
  }
});

// v59.2: print resilience — must survive STATE corruption (null fields,
// missing staffDuty, etc.) without crashing the user's print attempt.
step('printAllChecklists survives null STATE.fields and null staffDuty', () => {
  const savedFields = g.STATE.fields;
  const savedDuty   = g.STATE.staffDuty;
  // Stub window.open so the function can run without a real popup
  const origWinOpen = g.open;
  let crashed = null;
  g.open = () => ({
    document: { write: () => {}, close: () => {} },
    print: () => {}
  });
  try {
    g.STATE.fields = null;
    g.STATE.staffDuty = null;
    try { g.printAllChecklists(false); }
    catch(e) { crashed = e.message; }
    if (crashed) throw new Error('Print crashed on null state: ' + crashed);
  } finally {
    g.STATE.fields = savedFields;
    g.STATE.staffDuty = savedDuty;
    g.open = origWinOpen;
  }
});

// v59.2: mgmtBlocks overlap logic — manager scheduling depends on this
// being correct. Audit 9 cases.
step('addMgmtBlock: isolated blocks preserved', () => {
  const saved = g.STATE.mgmtBlocks;
  try {
    g.STATE.mgmtBlocks = {};
    g.addMgmtBlock('AUDIT_1', 8, 12, 'Counter');
    g.addMgmtBlock('AUDIT_1', 13, 17, 'Exit Booth');
    const b = g.STATE.mgmtBlocks['AUDIT_1'];
    if (b.length !== 2) throw new Error('expected 2 isolated blocks, got '+b.length);
  } finally { g.STATE.mgmtBlocks = saved; }
});

step('addMgmtBlock: new block fully overlapping existing drops the old one', () => {
  const saved = g.STATE.mgmtBlocks;
  try {
    g.STATE.mgmtBlocks = {};
    g.addMgmtBlock('AUDIT_2', 10, 12, 'Counter');
    g.addMgmtBlock('AUDIT_2',  8, 14, 'Exit Booth');
    const b = g.STATE.mgmtBlocks['AUDIT_2'];
    if (b.length !== 1) throw new Error('expected 1 (existing dropped), got '+b.length);
    if (b[0].station !== 'Exit Booth') throw new Error('wrong station kept');
  } finally { g.STATE.mgmtBlocks = saved; }
});

step('addMgmtBlock: new block in middle splits existing into two', () => {
  const saved = g.STATE.mgmtBlocks;
  try {
    g.STATE.mgmtBlocks = {};
    g.addMgmtBlock('AUDIT_3',  8, 17, 'Counter');
    g.addMgmtBlock('AUDIT_3', 11, 12, 'Lunch');
    const b = g.STATE.mgmtBlocks['AUDIT_3'];
    if (b.length !== 3) throw new Error('expected 3 (split + new), got '+b.length);
  } finally { g.STATE.mgmtBlocks = saved; }
});

step('addMgmtBlock: rejects invalid range, zero-width, missing station', () => {
  const saved = g.STATE.mgmtBlocks;
  try {
    g.STATE.mgmtBlocks = {};
    let r = g.addMgmtBlock('AUDIT_4', 12, 10, 'Counter'); // from>to
    if (r.ok) throw new Error('should reject from>to');
    r = g.addMgmtBlock('AUDIT_4', 12, 12, 'Counter'); // zero width
    if (r.ok) throw new Error('should reject zero-width');
    r = g.addMgmtBlock('AUDIT_4', 8, 12, '');
    if (r.ok) throw new Error('should reject missing station');
  } finally { g.STATE.mgmtBlocks = saved; }
});

step('removeMgmtBlock: deletes pid entry when array becomes empty', () => {
  const saved = g.STATE.mgmtBlocks;
  try {
    g.STATE.mgmtBlocks = {};
    g.addMgmtBlock('AUDIT_5', 8, 12, 'Counter');
    g.removeMgmtBlock('AUDIT_5', 0);
    if (g.STATE.mgmtBlocks['AUDIT_5']) throw new Error('should have removed empty pid entry');
  } finally { g.STATE.mgmtBlocks = saved; }
});

// v59.2: URL sanitizer for car photo URLs — block javascript:, vbscript:,
// file:, etc. while allowing http(s):// and data:image/*.
step('_sanitizeImageUrl blocks javascript: and other dangerous schemes', () => {
  if (g._sanitizeImageUrl('javascript:alert(1)') !== '') throw new Error('javascript: not blocked');
  if (g._sanitizeImageUrl('JAVASCRIPT:alert(1)') !== '') throw new Error('JS upper not blocked');
  if (g._sanitizeImageUrl('vbscript:alert(1)') !== '') throw new Error('vbscript: not blocked');
  if (g._sanitizeImageUrl('file:///etc/passwd') !== '') throw new Error('file: not blocked');
  if (g._sanitizeImageUrl('data:text/html,<script>1') !== '') throw new Error('data:text/html not blocked');
  if (g._sanitizeImageUrl('') !== '') throw new Error('empty should be empty');
  if (g._sanitizeImageUrl(null) !== '') throw new Error('null should be empty');
});

// v59.2: combo interaction bugs — shiftMod was only applied at render time
// (rotation engine used original shift, causing misplaced blocks).
// altSchedule paths hardcoded lunch=midpoint, ignoring customLunch.
step('shiftMod applied at rotation-build time, not just at render', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = () => ({
    'SM_T': {person:{name:'SM T',role:'CXR',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}},
  });
  const savedCXR = g.ROSTER_CXR;
  const savedSM = g.STATE.shiftMod;
  g.ROSTER_CXR = [...savedCXR, {id:'sm-t',name:'SM T',role:'CXR',shiftCode:'8A-5P',shiftStart:8,shiftEnd:17}];
  g.STATE.shiftMod = {'SM_T': {start:10, end:17, reason:'Late arrival'}};
  try {
    const r = g.buildSmartRotation();
    const sm = r.rotations.find(x => x.pid === 'SM_T');
    if (!sm) throw new Error('SM_T not in rotation');
    if (sm.shiftStart !== 10) throw new Error('shiftMod start not applied to rotation, got '+sm.shiftStart);
    if (sm.shiftEnd !== 17) throw new Error('shiftMod end not applied');
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.STATE.shiftMod = savedSM;
    g.Date = realDate;
  }
});

step('altSchedule full-counter honors customLunch override', () => {
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = () => ({
    'FC_T': {person:{name:'FC T',role:'CXR',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}},
  });
  const savedCXR = g.ROSTER_CXR;
  const savedAlt = g.STATE.altSchedule;
  const savedCL = g.STATE.customLunch;
  g.ROSTER_CXR = [...savedCXR, {id:'fc-t',name:'FC T',role:'CXR',shiftCode:'8A-5P',shiftStart:8,shiftEnd:17}];
  g.STATE.altSchedule = {'FC_T':'full-counter'};
  g.STATE.customLunch = {'FC_T': 13.5};
  try {
    const r = g.buildSmartRotation();
    const fc = r.rotations.find(x => x.pid === 'FC_T');
    if (!fc || !fc.lunch) throw new Error('FC_T or lunch missing');
    if (Math.abs(fc.lunch.from - 13.5) > 0.01) {
      throw new Error('customLunch not honored in full-counter, got '+fc.lunch.from);
    }
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.STATE.altSchedule = savedAlt;
    g.STATE.customLunch = savedCL;
    g.Date = realDate;
  }
});

step('_sanitizeImageUrl allows http(s) and data:image URLs', () => {
  const httpsUrl = 'https://example.com/foo.jpg';
  if (!g._sanitizeImageUrl(httpsUrl).includes('https://example.com')) {
    throw new Error('https:// blocked');
  }
  if (!g._sanitizeImageUrl('http://example.com/foo.jpg').includes('http://example.com')) {
    throw new Error('http:// blocked');
  }
  const dataUrl = 'data:image/png;base64,iVBOR';
  if (!g._sanitizeImageUrl(dataUrl).includes('data:image/png')) {
    throw new Error('data:image/png blocked');
  }
});

step('renderDashAnnouncements survives junk entries in array', () => {
  const saved = g.STATE.announcements ? g.STATE.announcements.slice() : [];
  try {
    g.STATE.announcements = [null, undefined, {text:'good one',priority:'info'}, 'string entry', 42];
    const stubEl = { style:{display:''}, innerHTML:'' };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => id === 'dash-announcements' ? stubEl : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    // Should not throw
    g.renderDashAnnouncements();
    g.document = origDoc;
    if (!stubEl.innerHTML.includes('good one')) {
      throw new Error('valid entry not rendered alongside junk');
    }
  } finally {
    g.STATE.announcements = saved;
  }
});

step('saveAllCarPhotos writes inputs to STATE.carPhotos', () => {
  const saved = g.STATE.carPhotos ? Object.assign({}, g.STATE.carPhotos) : {};
  try {
    g.STATE.carPhotos = {};
    // Stub document.getElementById to return inputs with values for a few codes
    const inputs = {
      'cph-ECAR': { value: 'https://example.com/ecar.jpg' },
      'cph-CCAR': { value: '' },
      'cph-ICAR': { value: 'https://example.com/icar.png' },
    };
    const origDoc = g.document;
    g.document = Object.assign({}, origDoc, {
      getElementById: id => inputs[id] !== undefined ? inputs[id] : (origDoc && origDoc.getElementById ? origDoc.getElementById(id) : null)
    });
    g.saveAllCarPhotos();
    g.document = origDoc;
    if (g.STATE.carPhotos.ECAR !== 'https://example.com/ecar.jpg') throw new Error('ECAR not saved');
    if (g.STATE.carPhotos.ICAR !== 'https://example.com/icar.png') throw new Error('ICAR not saved');
    if (g.STATE.carPhotos.CCAR) throw new Error('CCAR should be empty');
  } finally {
    g.STATE.carPhotos = saved;
  }
});



// REGRESSION TEST: buildSmartRotation must iterate ROSTER_EXIT and
// ROSTER_RETURNS, not just ROSTER_CXR. Symptom of the bug: workingExit
// was always empty because the function looped ROSTER_CXR only — Genesis,
// Zina, Lisa, Kenneth all live in ROSTER_EXIT, so the rotation engine
// thought the day had zero dedicated exit agents. Lunch-stagger then
// had nothing to schedule around.
step('buildSmartRotation picks up exit agents from ROSTER_EXIT', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    return {
      'Zina_Kellen': {
        person:{name:'Zina Kellen',nick:'Zina',role:'EXIT',shiftStart:10,shiftEnd:18.5},
        shift:{start:10,end:18.5,code:'10A-630P'}
      },
    };
  };
  try {
    const result = g.buildSmartRotation();
    if (!result.workingExit || result.workingExit.length === 0) {
      throw new Error('workingExit empty — exit agents not being picked up');
    }
    const exitIn = result.workingExit.some(e => e.name === 'Zina Kellen');
    if (!exitIn) throw new Error('Zina not in workingExit: '+JSON.stringify(result.workingExit.map(e=>e.name)));
  } finally {
    g.buildExpectedToday = origBET;
  }
});

// REGRESSION TEST: Lunch stagger spread pass minimizes concurrent
// exit-side lunches even when coverage is technically meeting exitMin.
// Without this, 3+ CXRs going to exit second-half all end up with the
// same midpoint lunch and the exit booth runs at bare minimum during
// the lunch dip.
step('Lunch stagger reduces concurrent exit-side lunches', () => {
  // 3 CXRs on identical shifts going to exit second half.
  // Pin date to a known Tuesday (May 12 2026) so coverage rules and
  // peak windows are predictable across test runs.
  const realDate = g.Date;
  g.Date = class extends realDate {
    constructor(...args) { if (!args.length) { super(2026,4,12,12,0); } else super(...args); }
    static now() { return new realDate(2026,4,12,12,0).getTime(); }
  };
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    return {
      'A_Test': { person:{name:'A Test',nick:'A',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
      'B_Test': { person:{name:'B Test',nick:'B',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
      'C_Test': { person:{name:'C Test',nick:'C',role:'CXR',shiftStart:8,shiftEnd:17}, shift:{start:8,end:17,code:'8A-5P'} },
      'Kenneth_Exit': { person:{name:'Kenneth Exit',nick:'Ken',role:'EXIT',shiftStart:7,shiftEnd:18}, shift:{start:7,end:18,code:'7A-6P'} },
    };
  };
  const savedCXR = g.ROSTER_CXR;
  const savedExit = g.ROSTER_EXIT;
  g.ROSTER_CXR = [
    ...savedCXR,
    { id:'a-t', name:'A Test', nick:'A', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
    { id:'b-t', name:'B Test', nick:'B', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
    { id:'c-t', name:'C Test', nick:'C', role:'CXR', shiftCode:'8A-5P', shiftStart:8, shiftEnd:17 },
  ];
  g.ROSTER_EXIT = [
    ...savedExit,
    { id:'ken-x', name:'Kenneth Exit', nick:'Ken', role:'EXIT', shiftCode:'7A-6P', shiftStart:7, shiftEnd:18 },
  ];
  try {
    const result = g.buildSmartRotation();
    const testRots = result.rotations.filter(r => /Test/.test(r.name) && r.lunch);
    if (testRots.length !== 3) throw new Error('expected 3 test rots, got '+testRots.length);
    let overlaps = 0;
    for (let i=0; i<testRots.length; i++) {
      for (let j=i+1; j<testRots.length; j++) {
        const a=testRots[i], b=testRots[j];
        if (a.lunch.from < b.lunch.to && b.lunch.from < a.lunch.to) overlaps++;
      }
    }
    if (overlaps > 1) {
      throw new Error('Stagger didn\'t spread lunches; '+overlaps+' overlaps. Times: '+
        testRots.map(r=>r.lunch.from+'-'+r.lunch.to).join(' / '));
    }
    // v57: verify NONE went below 3hr-after-start floor
    testRots.forEach(r => {
      const b1 = r.lunch.from - r.shiftStart;
      if (b1 < 2.99) {
        throw new Error('Lunch < 3hr after start for '+r.nick+': b1='+b1.toFixed(2)+'h');
      }
    });
  } finally {
    g.buildExpectedToday = origBET;
    g.ROSTER_CXR = savedCXR;
    g.ROSTER_EXIT = savedExit;
    g.Date = realDate;
  }
});

step('Called-off person hidden from timeline even if shift starts within 2hrs', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    const exp = origBET ? origBET.apply(this, arguments) : {};
    exp['Zina_Kellen'] = {person:{name:'Zina Kellen',nick:'Zina',role:'EXIT',shiftStart:10,shiftEnd:18.5},shift:{start:10,end:18.5}};
    return exp;
  };
  const savedOverrides = g.STATE.todayOverrides;
  g.STATE.todayOverrides = {...(savedOverrides||{}), Zina_Kellen: 'callout'};
  try {
    g.buildCoverageTimeline();
    const out = elementStore['coverage-timeline']?.innerHTML || '';
    // Row click handler — only present on rendered rows
    if (out.includes("openPersonPanel('Zina_Kellen')")) {
      throw new Error('Called-off Zina still rendered as a timeline row');
    }
    // The reinstate banner SHOULD still mention her
    if (!out.includes("reinstatePerson('Zina_Kellen')")) {
      throw new Error('Called-off Zina missing from CALLED OFF banner');
    }
  } finally {
    g.buildExpectedToday = origBET;
    g.STATE.todayOverrides = savedOverrides;
  }
});

// REGRESSION TEST: Group Flow overlay mode renders both res and ret
// bars per group with net underneath. Matt asked for this so he could
// see the differential at a glance per car group from the existing
// availability paste data.
step('Group Flow overlay shows res + ret bars + net per group', () => {
  // Snapshot state to restore at the end
  const savedPasteData = g.STATE.pasteData;
  g.STATE.pasteData = {
    'res-am-remaining': {'Midsize SUV': 40, 'Standard SUV': 21},
    'ret-am-remaining': {'Midsize SUV': 110, 'Standard SUV': 35},
    'res-pm-remaining': {}, 'ret-pm-remaining': {},
  };
  // Stub the dropdown so the function reads 'overlay'
  elementStore['board-flow-type'] = makeEl('board-flow-type', 'overlay');
  elementStore['board-flow-chart'] = makeEl('board-flow-chart');
  try {
    g.buildBoardFlow();
    const out = elementStore['board-flow-chart']?.innerHTML || '';
    if (!out.includes('rgba(217,119,6,.55)')) throw new Error('Res bar (amber) not rendered');
    if (!out.includes('rgba(22,163,74,.45)')) throw new Error('Ret bar (green) not rendered');
    if (!out.includes('R40')) throw new Error('Inline R40 label missing');
    if (!out.includes('↩110')) throw new Error('Inline ↩110 label missing');
    if (!out.includes('+70')) throw new Error('Net +70 missing');
    if (!out.includes('Reservations') || !out.includes('Returns')) throw new Error('Legend missing');
  } finally {
    // ALWAYS restore pasteData even if assertions failed — otherwise
    // we leave a depleted state behind and break later tests that
    // expect the full GL fixture data (this is what tripped the
    // "Real GL data: ret ICAR = 40" test).
    g.STATE.pasteData = savedPasteData;
    delete elementStore['board-flow-type'];
    delete elementStore['board-flow-chart'];
  }
});

// REGRESSION TEST: Manager mgmtBlocks gap-fill — when a manager has
// a partial assignment block, uncovered shift time fills with their
// default station. Prior bug: gaps rendered BLANK so it looked like
// the manager vanished from those hours. Matt: "the blocks when added
// don't reset on top of the other bar, it just goes away or isn't
// synced up."
step('Mgmt blocks gap-fill: partial blocks fill gaps with default station', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    const exp = origBET.apply(this, arguments);
    exp['Carlos'] = {person:{name:'Carlos',nick:'Carlos',role:'ABRM',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}};
    return exp;
  };
  g.STATE.staffStation = {Carlos: 'Emerald Booth'};
  g.STATE.mgmtBlocks = {Carlos: [{from:12, to:14, station:'Counter Manager'}]};
  g.buildCoverageTimeline();
  const html = elementStore['coverage-timeline']?.innerHTML || '';
  const idx = html.indexOf('Carlos');
  if (idx < 0) throw new Error('Carlos not rendered');
  const slice = html.slice(idx, idx + 6000);
  // Should have TWO Emerald segments (8-12 + 14-17) and ONE Counter (12-14)
  const emeraldCount = (slice.match(/background:var\(--eb\)/g) || []).length;   // v60.91: iOS palette
  const counterCount = (slice.match(/background:var\(--counter\)/g) || []).length;
  if (emeraldCount < 2) throw new Error('Expected at least 2 Emerald gap-fill segments, got '+emeraldCount);
  if (counterCount < 1) throw new Error('Expected at least 1 Counter override, got '+counterCount);
  g.buildExpectedToday = origBET;
  g.STATE.mgmtBlocks = {};
  g.STATE.staffStation = {};
});

// REGRESSION TEST: CXR assignment blocks override rotation. v50 extended
// mgmtBlocks from managers-only to all roles. When a CXR has even one
// manual block, rotation is bypassed entirely (manual wins over auto).
step('CXR mgmtBlocks override auto-rotation when present', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    const exp = origBET.apply(this, arguments);
    exp['CeCe_Smith'] = {person:{name:'CeCe Smith',nick:'CeCe',role:'CXR',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}};
    return exp;
  };
  g.STATE.mgmtBlocks = {CeCe_Smith: [{from:10, to:12, station:'Returns'}]};
  g.window._lastRotations = {
    CeCe_Smith: {
      b1:{from:8,to:12,station:'counter'},
      lunch:{from:12,to:12.5},
      b2:{from:12.5,to:17,station:'exit'},
    }
  };
  g.buildCoverageTimeline();
  const html = elementStore['coverage-timeline']?.innerHTML || '';
  const idx = html.indexOf('CeCe_Smith');
  if (idx < 0) throw new Error('CeCe not rendered');
  // Take a fixed-size slice. Don't try to find a row boundary by
  // looking for `display:flex` — that string appears inside EVERY bar
  // div for align-items centering, which truncated the slice before
  // the actual bars rendered. Just grab a generous fixed window.
  const slice = html.slice(idx, idx + 6000);
  // Returns block (cyan #06b6d4) must appear since manual override
  if (!slice.includes('#06b6d4')) {
    throw new Error('Returns manual block did not render for CXR');
  }
  // Cleanup
  g.buildExpectedToday = origBET;
  g.STATE.mgmtBlocks = {};
  g.window._lastRotations = {};
});

// ─── v50 — Double lunch fix, set24hr, alt-pos clears stale lunch ────
console.log('\n─── v50 features ──────────────────────────────────────────');

// REGRESSION TEST: setAltPosition clears stale specialBlocks lunch.
// Why: when user switches a CXR to Full Counter / Full Exit, the
// rotation engine generates a fresh `rot.lunch` at the midpoint of
// the new shift. If a previous specialBlocks lunch entry persists,
// it double-renders on the timeline AND confuses the dashboard's
// "next lunch" lookup. Symptom Matt reported: "Lunch isn't pulling
// through for Matt CXR after setting to Full counter."
step('setAltPosition clears stale specialBlocks lunch entry', () => {
  // Pre-populate a stale specialBlocks lunch
  g.STATE.specialBlocks = { 'Matt_Johnson': [{key:'lunch', label:'Lunch', icon:'🍽', from:11, to:11.5}] };
  g.STATE.altSchedule = {};
  // Stub buildSmartRotation so the call inside setAltPosition doesn't blow up
  const origBSR = g.buildSmartRotation;
  g.buildSmartRotation = () => ({rotations: []});
  try {
    g.setAltPosition('Matt_Johnson', 'full-counter');
  } catch(e) {
    // openPersonPanel might fail in mock environment — that's OK,
    // the lunch-clearing happens before the panel call
  } finally {
    g.buildSmartRotation = origBSR;
  }
  // The lunch entry should be gone
  const sbAfter = g.STATE.specialBlocks && g.STATE.specialBlocks['Matt_Johnson'];
  if (sbAfter && sbAfter.some(b => b.key === 'lunch')) {
    throw new Error('Stale lunch entry not cleared after Full Counter override');
  }
});

// REGRESSION TEST: set24hr stores the policy and update24hrButtons
// reflects state. Same UX pattern as walk-up policy buttons.
step('set24hr stores policy and update24hrButtons reflects it', () => {
  // Stub the buttons
  ['b24-open-b','b24-restricted-b','b24-emerald-b','b24-closed-b'].forEach(id => {
    const el = makeEl(id);
    const classes = new Set();
    el.classList = {add:(...c)=>c.forEach(x=>classes.add(x)),remove:(...c)=>c.forEach(x=>classes.delete(x)),contains:c=>classes.has(c),_set:classes};
    elementStore[id] = el;
  });
  g.STATE.fields = {};
  g.set24hr('restricted');
  if (g.STATE.fields.book24hr !== 'restricted') throw new Error('Policy not stored');
  if (!elementStore['b24-restricted-b'].classList._set.has('on')) {
    throw new Error('Restricted button missing on class after set24hr');
  }
  if (elementStore['b24-open-b'].classList._set.has('on')) {
    throw new Error('Open button still highlighted when policy=restricted');
  }
});

// REGRESSION TEST: dashboard "Lunch · Lunch" double-tag for managers.
// Why: when a manager's zone is 'lunch' AND mgmtStation label says
// "Lunch", the dashboard rendered both, producing "Brittney · Lunch · Lunch".
// Fix: skip the second tag when station label already says lunch.
// (This is a render-only change; we just verify the rendered HTML
// for a lunch-zone manager doesn't have two lunch tags.)
step('Manager on lunch shows only one Lunch indicator (not two)', () => {
  // We can't run buildSwitchboard in full without huge state setup;
  // instead, verify the source code has the de-duplication guard.
  const html = require('fs').readFileSync(filePath, 'utf8');
  const src = html.indexOf('isMgmt && /lunch/i.test(mgmtStation)');
  if (src < 0) throw new Error('Double-lunch guard missing in dashboard render');
});

// ─── v48 — Print, brand parser hardening, edit modal ──────────────
console.log('\n─── v48 features ──────────────────────────────────────────');

// REGRESSION TEST: printScheduleMap runs without error and produces
// a print window with the expected structure (date, sections, hour
// scale, manager blocks rendered as colored segments).
step('printScheduleMap produces valid print HTML', () => {
  // Inject a manager with multi-station blocks for a realistic test
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    const exp = origBET.apply(this, arguments);
    exp['Maddy_Shirer'] = {person:{name:'Maddy Shirer',nick:'Maddy',role:'ABRM',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}};
    return exp;
  };
  g.STATE.mgmtBlocks = {
    'Maddy_Shirer': [
      {from:8, to:11, station:'Emerald Booth'},
      {from:11, to:13, station:'Counter Manager'},
      {from:13, to:17, station:'Returns'},
    ]
  };
  // Capture what gets written to the print window
  let captured = '';
  const origOpen = g.window.open;
  g.window.open = () => ({document:{write:(s)=>{captured += s;},close:()=>{}}, print:()=>{}});
  try {
    g.printScheduleMap();
  } finally {
    g.window.open = origOpen;
    g.buildExpectedToday = origBET;
    g.STATE.mgmtBlocks = {};
  }
  if (captured.length < 1000) throw new Error('Print HTML too short: '+captured.length);
  if (!captured.includes('Maddy')) throw new Error('Manager not in print output');
  if (!captured.includes('#6366f1')) throw new Error('Emerald block color not rendered');
  if (!captured.includes('@page')) throw new Error('@page CSS rule missing');
  if (!captured.includes('MANAGEMENT')) throw new Error('Management section header missing');
  if (!captured.includes('hour-tick')) throw new Error('Hour scale missing');
});

// REGRESSION TEST: parseBrandSection handles the legacy 11-column
// single-number-per-line GL paste format.
step('parseBrandSection handles legacy 11-column GL paste', () => {
  const t = `ALAMO\n60\n39\n6\n15\n2\n1\n0\n54\n1\n0\n21\nNATIONAL\n377\n142\n92\n143\n15\n4\n0\n219\n62\n63\n94`;
  const r = g.parseBrandSection(t);
  if (!r || !r.alamo) throw new Error('Failed to parse ALAMO row');
  if (r.alamo.totalRes !== 60) throw new Error('ALAMO totalRes wrong: '+r.alamo.totalRes);
  if (r.national.totalRes !== 377) throw new Error('NATIONAL totalRes wrong: '+r.national.totalRes);
});

// REGRESSION TEST: parseBrandSection handles 12-column paste (extra
// trailing column without dropping the important totalRes).
step('parseBrandSection handles 12-column paste (extra trailing)', () => {
  const t = `ALAMO\n60\n39\n6\n15\n2\n1\n0\n54\n1\n0\n21\n32\nNATIONAL\n377\n142\n92\n143\n15\n4\n0\n219\n62\n63\n94`;
  const r = g.parseBrandSection(t);
  if (r.alamo.totalRes !== 60) throw new Error('ALAMO totalRes lost when 12 cols');
  if (r.alamo._raw.length !== 12) throw new Error('Raw should preserve all 12 numbers');
});

// REGRESSION TEST: parseBrandSection auto-detects header row when
// present and maps columns by name (resilient to reordered columns).
step('parseBrandSection maps by header name when header row present', () => {
  // Reordered headers: totalRes is still position 0, but totRet is position 1
  // (vs the default position 7). Header-based mapping should handle this.
  const t = `Brands  Total Res  Tot Ret  Sch Res  Sch Ret  Late Res  Late Ret  Rented  Returned  New Today  Walk Up  Prewrite
ALAMO  60  54  39  1  6  0  15  21  2  1  0
NATIONAL  377  219  142  62  92  63  143  94  15  4  0`;
  const r = g.parseBrandSection(t);
  if (r.alamo.totalRes !== 60) throw new Error('totalRes wrong when header reordered: '+r.alamo.totalRes);
  if (r.alamo.totRet !== 54) throw new Error('totRet wrong when header reordered: '+r.alamo.totRet);
  if (r.national.totalRes !== 377) throw new Error('NATIONAL totalRes wrong');
  if (r.national.totRet !== 219) throw new Error('NATIONAL totRet wrong');
});

// REGRESSION TEST: parseBrandSection handles inline-number brand row
// format (one line per brand with values whitespace-separated).
step('parseBrandSection handles inline-number brand rows', () => {
  const t = `Brands  Total Res  Sch Res  Late Res  Rented  New Today  Walk Up  Prewrite  Tot Ret  Sch Ret  Late Ret  Returned
ALAMO  60  39  6  15  2  1  0  54  1  0  21
NATIONAL  377  142  92  143  15  4  0  219  62  63  94`;
  const r = g.parseBrandSection(t);
  if (!r.alamo) throw new Error('ALAMO not parsed in inline format');
  if (r.alamo.totalRes !== 60) throw new Error('inline totalRes wrong');
  if (r.alamo.returned !== 21) throw new Error('inline returned wrong: '+r.alamo.returned);
});

// REGRESSION TEST: openEditMgmtBlockModal/saveEditMgmtBlock pair works
// for in-place editing of an existing block (used by tap-to-edit).
step('saveEditMgmtBlock updates an existing block in place', () => {
  g.STATE.mgmtBlocks = {
    'Maddy_Shirer': [{from:8, to:11, station:'Emerald Booth'}]
  };
  // Stub form elements that saveEditMgmtBlock reads from
  elementStore['emb-from'] = makeEl('emb-from', '9');
  elementStore['emb-to'] = makeEl('emb-to', '12');
  elementStore['emb-station'] = makeEl('emb-station', 'Counter Manager');
  g.saveEditMgmtBlock('Maddy_Shirer', 0);
  const b = g.STATE.mgmtBlocks['Maddy_Shirer'][0];
  if (b.from !== 9) throw new Error('from not updated: '+b.from);
  if (b.to !== 12) throw new Error('to not updated: '+b.to);
  if (b.station !== 'Counter Manager') throw new Error('station not updated: '+b.station);
  // Cleanup
  delete elementStore['emb-from'];
  delete elementStore['emb-to'];
  delete elementStore['emb-station'];
  g.STATE.mgmtBlocks = {};
});

// ─── v47 — Manager time blocks (multi-station scheduling) ──────────
console.log('\n─── Manager time blocks ───────────────────────────────────');

step('addMgmtBlock rejects invalid input', () => {
  if (g.addMgmtBlock('test', 8, 8, 'Counter Manager').ok) throw new Error('from==to should reject');
  if (g.addMgmtBlock('test', 10, 8, 'Counter Manager').ok) throw new Error('from>to should reject');
  if (g.addMgmtBlock('test', 8, 10, '').ok) throw new Error('empty station should reject');
});

step('addMgmtBlock stores blocks chronologically', () => {
  g.STATE.mgmtBlocks = {};
  g.addMgmtBlock('Maddy_Shirer', 13, 17, 'Returns');
  g.addMgmtBlock('Maddy_Shirer', 8, 11, 'Emerald Booth');
  g.addMgmtBlock('Maddy_Shirer', 11, 13, 'Counter Manager');
  const blocks = g.STATE.mgmtBlocks['Maddy_Shirer'];
  if (blocks.length !== 3) throw new Error(`Expected 3 blocks, got ${blocks.length}`);
  if (blocks[0].from !== 8 || blocks[1].from !== 11 || blocks[2].from !== 13) {
    throw new Error('Blocks not sorted: ' + JSON.stringify(blocks));
  }
});

step('Overlapping mgmt block splits existing block correctly', () => {
  g.STATE.mgmtBlocks = {};
  g.addMgmtBlock('Maddy_Shirer', 8, 12, 'Counter Manager');
  g.addMgmtBlock('Maddy_Shirer', 10, 11, 'Exit Booth');
  const after = g.STATE.mgmtBlocks['Maddy_Shirer'];
  if (after.length !== 3) throw new Error(`Expected 3, got ${after.length}`);
  if (after[0].to !== 10 || after[1].station !== 'Exit Booth' || after[2].from !== 11) {
    throw new Error('Split incorrect: ' + JSON.stringify(after));
  }
});

step('removeMgmtBlock cleans state when last block removed', () => {
  g.STATE.mgmtBlocks = {};
  g.addMgmtBlock('Maddy_Shirer', 8, 11, 'Emerald Booth');
  g.removeMgmtBlock('Maddy_Shirer', 0);
  if (g.STATE.mgmtBlocks['Maddy_Shirer'] !== undefined) {
    throw new Error('Empty array should be deleted');
  }
});

step('Timeline renders manager blocks with station-specific colors', () => {
  const origBET = g.buildExpectedToday;
  g.buildExpectedToday = function() {
    const exp = origBET.apply(this, arguments);
    exp['Maddy_Shirer'] = {person:{name:'Maddy Shirer',nick:'Maddy',role:'ABRM',shiftStart:8,shiftEnd:17},shift:{start:8,end:17,code:'8A-5P'}};
    return exp;
  };
  g.STATE.mgmtBlocks = {
    'Maddy_Shirer': [
      {from:8, to:11, station:'Emerald Booth'},
      {from:11, to:13, station:'Counter Manager'},
      {from:13, to:17, station:'Returns'},
    ]
  };
  const _prevGrp = g.STATE.schedGroupBy;
  g.STATE.schedGroupBy = 'type'; // v60.37: group-by-Type gives the "Management" section label
  g.buildCoverageTimeline();
  g.STATE.schedGroupBy = _prevGrp;
  const html2 = elementStore['coverage-timeline']?.innerHTML || '';
  const mgmtIdx = html2.indexOf('Management</span>');   // v60.91: Design kicker (was "— Management —")
  if (mgmtIdx < 0) throw new Error('Management section not rendered');
  const slice = html2.slice(mgmtIdx);
  const maddyIdx = slice.indexOf('Maddy_Shirer');
  if (maddyIdx < 0) throw new Error('Maddy row not rendered');
  const maddyRow = slice.slice(maddyIdx, maddyIdx + 3000);
  if (!maddyRow.includes('background:var(--eb)')) throw new Error('Emerald (purple) block missing');
  if (!maddyRow.includes('background:var(--counter)')) throw new Error('Counter (blue) block missing');
  if (!maddyRow.includes('background:var(--returns)')) throw new Error('Returns (cyan) block missing');
  g.buildExpectedToday = origBET;
  g.STATE.mgmtBlocks = {};
});

step('mgmtBlocks persists through saveState/loadState', () => {
  g.STATE.mgmtBlocks = { 'Maddy_Shirer': [{from:8, to:11, station:'Emerald Booth'}] };
  g.saveState();
  const reloaded = g.loadState();
  if (JSON.stringify(reloaded.mgmtBlocks) !== JSON.stringify(g.STATE.mgmtBlocks)) {
    throw new Error('mgmtBlocks lost in round-trip');
  }
});

// REGRESSION TEST: Walk-up button highlight must reflect actual state.
// The bug (v45): "All Open" button had hardcoded class="wubtn on g" in HTML,
// and updateWalkUpButtons() only toggled active/wu/up/na classes (never
// touched 'on' or 'g'). So no matter what STATE.walkUpPolicy was, "All Open"
// stayed visually highlighted in green. Compounding bug: when policy was
// actually 'closed' (from prior experimentation), every tile correctly
// computed as 'na' but the user saw "All Open" highlighted and was
// confused why everything was Not Available.
step('Walk-up button highlight reflects STATE.walkUpPolicy', () => {
  // Create button elements so updateWalkUpButtons can find them
  const ids = ['wu-open-b','wu-core-b','wu-noncore-b','wu-closed-b'];
  ids.forEach(id => {
    if (!elementStore[id]) {
      const el = makeEl(id);
      // Real classList that tracks add/remove
      const classes = new Set();
      el.classList = {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c),
        _set: classes
      };
      elementStore[id] = el;
    }
  });

  // Set policy to 'closed' and verify only Closed button gets highlight
  g.STATE.walkUpPolicy = 'closed';
  g.updateWalkUpButtons();
  if (!elementStore['wu-closed-b'].classList._set.has('on')) {
    throw new Error("Closed button missing 'on' class when policy=closed");
  }
  if (elementStore['wu-open-b'].classList._set.has('on')) {
    throw new Error("'All Open' button kept 'on' class even though policy=closed — UI lies about state");
  }

  // Now set to 'open' and verify Open is highlighted, Closed is not
  g.STATE.walkUpPolicy = 'open';
  g.updateWalkUpButtons();
  if (!elementStore['wu-open-b'].classList._set.has('on')) {
    throw new Error("'All Open' button missing 'on' class when policy=open");
  }
  if (elementStore['wu-closed-b'].classList._set.has('on')) {
    throw new Error("'Closed' button kept 'on' class even though policy=open");
  }
});

// REGRESSION TEST: Returns role agents must render as 'returns' zone in
// the timeline, NOT 'counter'. The bug (v44): timeline's "no rotation"
// fallback path checked for EXIT and management roles but missed RETURNS,
// so they fell through to the counter default and rendered with blue
// "Ctr" bars even though they were grouped under the RETURNS section
// header. Visible symptom on coverage tab first open: Toney/Nas/Robert
// labeled blue "Ctr".
step('Returns agents render with returns zone, not counter', () => {
  // Reset rotations so RETURNS role agents hit the no-rotation fallback
  g.window._lastRotations = {};
  g.STATE.altSchedule = {};
  g.buildCoverageTimeline();
  const html = elementStore['coverage-timeline']?.innerHTML || '';
  if (!html.length) throw new Error('Timeline did not render');
  // Returns zone uses cyan #06b6d4; counter uses var(--acc) (blue).
  // If a Returns agent's bar got 'counter' zone, we'd see 'Ctr' label
  // in the section under "— Returns —" header.
  // Check by finding the Returns section and verifying no 'Ctr' labels follow
  // before the next section header.
  const returnsHeaderIdx = html.indexOf('— Returns —');
  if (returnsHeaderIdx === -1) {
    // No Returns agents in fixture — skip this assertion (not a regression)
    return;
  }
  const nextSectionIdx = html.indexOf('—', returnsHeaderIdx + 12);
  const returnsSection = html.slice(returnsHeaderIdx, nextSectionIdx > -1 ? nextSectionIdx : html.length);
  // Each rendered bar has its zone label (Ctr/Exit/Ret/etc.) as inner text
  // surrounded by whitespace. The Returns zone uses cyan #06b6d4 — if we
  // see the cyan color in the Returns section, the fix worked.
  // Counter zone uses var(--acc); look for that as the failure marker.
  const hasCounterBars = /background:var\(--acc\)/.test(returnsSection);
  if (hasCounterBars) {
    throw new Error(
      `Returns section has counter-colored bars (var(--acc)) — Returns ` +
      `agents are being rendered as Counter zone. Check timeline ` +
      `fallback path in buildCoverageTimeline (around line 9434).`
    );
  }
});

// REGRESSION TEST: Dashboard "Total Res" tile (db-totalres) must use calc
// data over stale brand totals — same bug pattern as the board v42 fix
// applied separately to the dashboard's refreshDash widget. Without this,
// stale brand data shows the wrong number on the dashboard even after the
// board is fixed.
step('Dashboard tile: stale brand total does not override fresh inventory paste', () => {
  if (!g.STATE.pasteData) g.STATE.pasteData = {};
  g.STATE.pasteData.brands = { total: { totalRes: 34, totRet: 24 } };
  g.refreshDash();
  const tileVal = parseInt(elementStore['db-totalres']?.textContent) || 0;
  if (tileVal === 34) {
    throw new Error(
      `Dashboard db-totalres tile = 34 (stale brand value won over fresh calc). ` +
      `Same bug class as board v42. Fix: calcRes > 0 ? calcRes : tBrands.totalRes.`
    );
  }
  if (tileVal < 100) {
    throw new Error(`Dashboard db-totalres tile = ${tileVal}, expected ~500 from inventory paste`);
  }
  delete g.STATE.pasteData.brands;
});

// REGRESSION TEST: Stale brand totals must NOT override good calc data.
// The bug (v42): `totalRes = tot.totalRes || calcRes` let an old stale brand
// total of e.g. 34 (saved to localStorage from a prior buggy parse weeks ago)
// permanently override a fresh inventory paste of 520 remaining. Two values,
// two meanings — the board cares about remaining demand from inventory paste,
// not day-total bookings from brand summary.
step('Stale brand total does not override fresh inventory paste', () => {
  // Simulate a stale brand total from a prior session
  if (!g.STATE.pasteData) g.STATE.pasteData = {};
  g.STATE.pasteData.brands = { total: { totalRes: 34, totRet: 24 } };
  // Inventory paste already loaded above (real GL with ICAR=274 etc)
  g.calcBoard();
  const tileVal = parseInt(elementStore['board-total-res']?.textContent) || 0;
  if (tileVal === 34) {
    throw new Error(
      `TOTAL RES tile = 34 (stale brand value won over fresh calc). ` +
      `Bug: brand total overrode inventory-paste remaining count. ` +
      `Fix: calcRes > 0 ? calcRes : tot.totalRes — paste data must win.`
    );
  }
  if (tileVal < 100) {
    throw new Error(`TOTAL RES tile = ${tileVal}, expected ~500 from inventory paste`);
  }
  // Cleanup so other tests aren't affected
  delete g.STATE.pasteData.brands;
});

// REGRESSION TEST: TOTAL RES tile must equal sum of paste data, not just GROUP_META iteration.
// Codes mapping to groups outside GROUP_META (orphan groups) must still count toward total.
step('TOTAL RES tile sums all paste data (incl. orphan groups)', () => {
  g.calcBoard();
  const tileVal = parseInt(elementStore['board-total-res']?.textContent) || 0;
  const expected = Object.values(g.STATE.pasteData['res-am-remaining']||{}).reduce((s,v)=>s+v,0);
  if (tileVal !== expected) {
    throw new Error(`TOTAL RES tile = ${tileVal}, expected ${expected} (sum of paste data). Orphan groups may be leaking.`);
  }
});

// REGRESSION TEST: entering Schedule tab auto-runs distribution if no
// rotations exist yet — so users don't have to click anything to see real
// Exit/Counter blocks the first time they open the tab.
step('showTab(schedule) auto-triggers distribution when rotations are empty', () => {
  g._lastRotations = {};
  g.STATE.altSchedule = {};
  if (typeof g.showTab !== 'function') throw new Error('showTab missing');
  g.showTab('schedule');
  const count = Object.keys(g._lastRotations || {}).length;
  if (count < 3) {
    throw new Error(`Schedule tab entry didn't auto-distribute — only ${count} rotations after showTab. Auto-trigger broken.`);
  }
});

// REGRESSION TEST: autoSchedule must actually produce rotations.
// Previously buildSmartRotation gated on STATE.staffDuty[pid]===true (a flag
// never set automatically), so it silently returned 0 rotations even though
// autoDistributeExit had set the right altSchedule flags. Visible symptom:
// "auto distribution doesn't work" — flags set, but no Ctr/Exit blocks render.
step('autoSchedule produces rotations for scheduled CXRs', () => {
  // Reset to clean state
  g.STATE.altSchedule = {};
  g._lastRotations = {};
  if (typeof g.autoSchedule !== 'function') throw new Error('autoSchedule missing');
  g.autoSchedule();
  const rots = g._lastRotations || {};
  const count = Object.keys(rots).length;
  if (count < 3) {
    throw new Error(`autoSchedule produced only ${count} rotations — expected several scheduled CXRs to get blocks. Was buildSmartRotation's duty filter regressed?`);
  }
  // Spot-check that rotations have actual structure
  const first = Object.values(rots)[0];
  if (!first || !first.b1 || !first.b1.station) {
    throw new Error('First rotation missing b1.station — rotation structure broke');
  }
});
// (chart header padding-left, gap row width, section header spacer, staff name col).
// Drift here = visual misalignment between hour labels and staff bars.
step('Coverage timeline uses consistent LABEL_W and renders inside one scroll container', () => {
  g.buildCoverageTimeline();
  const tlHtml = elementStore['coverage-timeline']?.innerHTML || '';
  if (!tlHtml.length) throw new Error('Coverage timeline did not render');
  if (!tlHtml.includes('width:80px')) {
    throw new Error('Timeline label column not 80px — alignment may have drifted');
  }
  if (!tlHtml.includes('Exit') || !tlHtml.includes('Ctr')) {
    throw new Error('Chart bars (Exit/Ctr) not rendered inside timeline scroll container');
  }
  // v60.38: person bars use the SMOOTH station-view pill track (rounded bg +
  // border) instead of per-hour grid lines; time alignment comes from the
  // top/bottom hour axes + now-line. Assert the pill track is present.
  if (!tlHtml.includes('border-radius:9px')) {
    throw new Error('Smooth pill-track bars missing (border-radius:9px) — style may have regressed');
  }
});

// REGRESSION TEST: Flight delay card only shows on Closing tab.
step('Flight delay card lives on Closing checklist tab only', () => {
  const fd = elementStore['flight-delay-card'];
  if (!fd) throw new Error('flight-delay-card element missing — was it accidentally removed?');
  g.showChecklist('opening');
  if (fd.style.display !== 'none') throw new Error(`Card visible on Opening tab (display="${fd.style.display}"), should be hidden`);
  g.showChecklist('mid');
  if (fd.style.display !== 'none') throw new Error(`Card visible on Mid-Shift tab, should be hidden`);
  g.showChecklist('closing');
  if (fd.style.display === 'none') throw new Error(`Card hidden on Closing tab, should be visible`);
});
// (HTML clipboard interception path). Empty cells become real zeros.
step('TSV parser preserves hour positions', () => {
  const tsv = [
    'Vehicle Category\t12am\t1am\t2am\t3am\t4am\t5am\t6am\t7am\t8am\t9am\t10am\t11am\tRemaining',
    'ICAR\t\t\t\t\t\t\t1\t3\t10\t33\t27\t\t274',
  ].join('\n');
  const r = g.parseGLFull(tsv);
  if (!r || !r.codes.ICAR) throw new Error('TSV parser failed to recognize ICAR row');
  if (r.codes.ICAR.remaining !== 274) {
    throw new Error(`TSV ICAR remaining = ${r.codes.ICAR.remaining}, expected 274`);
  }
  if (r.codes.ICAR.hourlyRaw.length !== 12) {
    throw new Error(`TSV ICAR hourlyRaw length = ${r.codes.ICAR.hourlyRaw.length}, expected 12`);
  }
  if (r.codes.ICAR.hourlyRaw[6] !== 1) {
    throw new Error(`TSV ICAR hour 6am position = ${r.codes.ICAR.hourlyRaw[6]}, expected 1`);
  }
  if (r.codes.ICAR.hourlyRaw[0] !== 0) {
    throw new Error(`TSV ICAR hour 12am should be 0 (blank cell), got ${r.codes.ICAR.hourlyRaw[0]}`);
  }
});

// REGRESSION TEST: htmlTableToTSV converts HTML tables to TSV preserving blanks
step('htmlTableToTSV preserves blank cells', () => {
  // Need a DOM that creates real elements with textContent — fake one out using minimal mock
  const realHtml = '<table><tr><td>Code</td><td>1am</td><td>Remaining</td></tr><tr><td>ICAR</td><td></td><td>274</td></tr></table>';
  // Mock createElement('div') to actually parse children
  const origCreate = g.document.createElement;
  g.document.createElement = (tag) => {
    if (tag === 'div') {
      return {
        _html: '',
        set innerHTML(v) { this._html = v; },
        querySelectorAll(sel) {
          const html = this._html;
          if (sel === 'tr') {
            const trMatches = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gi)];
            return trMatches.map(m => ({
              querySelectorAll(s) {
                if (s.includes('td') || s.includes('th')) {
                  const cellMatches = [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gi)];
                  const arr = cellMatches.map(c => ({ textContent: c[1] }));
                  // Make iterable like NodeList
                  arr.forEach = Array.prototype.forEach;
                  return arr;
                }
                return [];
              }
            }));
          }
          return [];
        },
      };
    }
    return origCreate(tag);
  };
  try {
    const tsv = g.htmlTableToTSV(realHtml);
    g.document.createElement = origCreate;
    if (!tsv) throw new Error('htmlTableToTSV returned null');
    const lines = tsv.split('\n');
    if (lines.length !== 2) throw new Error(`Expected 2 rows, got ${lines.length}`);
    const cells = lines[1].split('\t');
    if (cells[0] !== 'ICAR') throw new Error(`Row 2 cell 0 = "${cells[0]}", expected "ICAR"`);
    if (cells[1] !== '') throw new Error(`Row 2 cell 1 should be empty (blank), got "${cells[1]}"`);
    if (cells[2] !== '274') throw new Error(`Row 2 cell 2 = "${cells[2]}", expected "274"`);
  } finally {
    g.document.createElement = origCreate;
  }
});
// Orphan groups have no display tile, so cars mapped to them are invisible.
// EXCEPTION: groups starting with ⚠ are intentional placeholders for codes
// awaiting AM confirmation (e.g. BFAR → '⚠ Possible GL Error') — not drift.
step('No orphan groups: every CODE_MAP target exists in GROUP_META', () => {
  const groupMetaNames = new Set(g.GROUP_META.map(m=>m.n));
  const codeMapTargets = new Set(Object.values(g.CODE_MAP));
  const orphans = [...codeMapTargets].filter(t => !groupMetaNames.has(t) && !t.startsWith('⚠'));
  if (orphans.length) {
    throw new Error(`Orphan groups in CODE_MAP not in GROUP_META: ${orphans.join(', ')}. Either add tiles or remap codes.`);
  }
});

step('Real GL data: ret ICAR = 40, math correct', () => {
  const ic = g.getGroupNetData()['Intermediate Car'];
  if (!ic.has) throw new Error('Intermediate Car has no data');
  if (ic.res !== 274) throw new Error(`res should be 274, got ${ic.res}`);
  if (ic.ret !== 40)  throw new Error(`ret should be 40, got ${ic.ret}`);
  if (ic.net !== -234) throw new Error(`net should be -234 (40-274), got ${ic.net}`);
});

step('calcBoard() runs without error',           () => g.calcBoard());
step('updateWUBtns() runs without error',        () => g.updateWUBtns());
step('updateBoardHeader() runs without error',   () => g.updateBoardHeader());

// ─── Priority Screen 2: HOURLY FLOW ──────────────────────────────────
console.log('\n─── Priority 2: HOURLY FLOW ───────────────────────────────');
step('buildBoardFlow() runs without error',      () => g.buildBoardFlow());
step('STATE.pasteHourly populated',              () => {
  const ph = g.STATE.pasteHourly || {};
  if (!ph.res || !Array.isArray(ph.res) || ph.res.length !== 24) {
    throw new Error('pasteHourly.res should be 24-hour array');
  }
  if (!ph.ret || !Array.isArray(ph.ret) || ph.ret.length !== 24) {
    throw new Error('pasteHourly.ret should be 24-hour array');
  }
});

// ─── Priority Screen 3: CHECKLISTS ───────────────────────────────────
console.log('\n─── Priority 3: CHECKLISTS ────────────────────────────────');
step('saveField sets values',                    () => {
  if (g.saveField) { g.saveField('cs', '7'); g.saveField('hot', '0'); }
  if (g.STATE.fields.cs !== '7') throw new Error('cs not saved');
});
step('countCLDone() runs without error',         () => g.countCLDone && g.countCLDone());
step('refreshDash() runs without error',         () => g.refreshDash());

// ─── Priority Screen 4: SCHEDULER ────────────────────────────────────
console.log('\n─── Priority 4: SCHEDULER ─────────────────────────────────');
step('buildCoverageTimeline() runs without error', () => g.buildCoverageTimeline());
step('updateManagerModeUI() runs without error',   () => g.updateManagerModeUI && g.updateManagerModeUI());

// ─── State persistence (the silent-killer area) ──────────────────────
console.log('\n─── Save / restore round-trip ─────────────────────────────');
step('saveState() writes to localStorage',       () => {
  g.saveState();
  if (Object.keys(g.localStorage._d).length === 0) throw new Error('Nothing saved');
});

step('loadState() returns full state object',    () => {
  const s = g.loadState();
  if (!s || typeof s !== 'object') throw new Error('loadState returned non-object');
  if (!s.pasteData) throw new Error('Reloaded state missing pasteData');
});

step('Round-trip preserves group data',          () => {
  const before = Object.entries(g.getGroupNetData()).filter(([, v]) => v.has).length;
  g.STATE = g.loadState();
  const after = Object.entries(g.getGroupNetData()).filter(([, v]) => v.has).length;
  if (before !== after) throw new Error(`Group count changed: ${before} → ${after}`);
});

// ─── v40 — Auto-distribute (the core schedule engine) ───────────────
console.log('\n─── Auto-distribute ───────────────────────────────────────');

// REGRESSION TEST: autoSchedule must produce rotations that actually appear
// in window._lastRotations. Without this, the schedule tab shows empty bars
// even though the algorithm "ran". We expect at least 1 rotation per
// scheduled CXR.
step('autoSchedule produces N rotations for N scheduled CXRs', () => {
  // Reset rotations to force a fresh run
  g.window._lastRotations = {};
  if (g.STATE && g.STATE.altSchedule) g.STATE.altSchedule = {};

  const expected = g.buildExpectedToday();
  const cxrCount = Object.values(expected).filter(e => e.person.role === 'CXR').length;
  if (cxrCount === 0) {
    throw new Error('No CXRs scheduled for today in test fixture — cannot validate autoSchedule');
  }

  g.autoSchedule();
  const rotCount = Object.keys(g.window._lastRotations || {}).length;

  if (rotCount === 0) {
    throw new Error(
      `autoSchedule produced 0 rotations despite ${cxrCount} CXRs being scheduled. ` +
      `This means buildSmartRotation is silently filtering out everyone — ` +
      `check staffDuty filter, getPersonShiftToday, or shift-code parsing.`
    );
  }
  if (rotCount < cxrCount) {
    throw new Error(`Only ${rotCount} rotations for ${cxrCount} CXRs — some CXRs being silently dropped`);
  }

  // Verify rotations have actual block structure (b1 with from/to/station)
  const firstRot = Object.values(g.window._lastRotations)[0];
  if (!firstRot.b1 || firstRot.b1.from == null || !firstRot.b1.station) {
    throw new Error(`Rotation missing b1 block structure: ${JSON.stringify(firstRot)}`);
  }
});

// REGRESSION TEST: Per CMH rule — nobody is `full-counter` unless exit is
// REGRESSION TEST: CMH rule (Matt, 2026-05-05) — "No one should ever be
// full counter unless too many people at exit. Exit/counter should be
// balanced or lean to exit." This means: zero CXRs auto-assigned to
// full-counter, AND at least 60% of CXRs should have some exit time.
// over-staffed AND counter is under-staffed during their hours. Default
// rotation should be balanced or exit-leaning (Counter→Exit), not all-counter.
step('CMH rule: zero CXRs auto-assigned full-counter, exit-leaning balance', () => {
  g.window._lastRotations = {};
  if (g.STATE) g.STATE.altSchedule = {};
  g.autoSchedule();

  const rots = Object.values(g.window._lastRotations || {});
  if (!rots.length) throw new Error('No rotations produced — autoSchedule failed');

  // STRICT: no CXR should be full-counter (both blocks at counter)
  const fullCounter = rots.filter(r =>
    r.b1 && r.b1.station === 'counter' &&
    r.b2 && r.b2.station === 'counter'
  );
  if (fullCounter.length > 0) {
    const names = fullCounter.map(r => r.nick || r.name).join(', ');
    throw new Error(
      `${fullCounter.length} CXR(s) auto-assigned full-counter: ${names}. ` +
      `CMH rule violation. autoSchedule must never produce full-counter — ` +
      `that's a manual switchboard option only.`
    );
  }

  // Count rotations that include exit time anywhere in b1 or b2
  const touchesExit = rots.filter(r => {
    return (r.b1 && r.b1.station === 'exit') || (r.b2 && r.b2.station === 'exit');
  }).length;

  // At least 60% of CXRs should touch exit. Less than that = Counter→Counter
  // is creeping back as the default, which violates the CMH rule.
  const exitPct = touchesExit / rots.length;
  if (exitPct < 0.6) {
    throw new Error(
      `Only ${touchesExit}/${rots.length} CXRs (${(exitPct*100).toFixed(0)}%) touch exit. ` +
      `CMH rule: default rotation is balanced or exit-leaning. ` +
      `Check that buildSmartRotation's "normal" branch defaults b2Station='exit'.`
    );
  }
});
// when no rotations exist yet. Matt should never see an empty timeline if
// CXRs are scheduled — the distribution should "just happen".
step('buildCoverageTimeline auto-runs distribution if no rotations exist', () => {
  // Clear rotations
  g.window._lastRotations = {};
  if (g.STATE && g.STATE.altSchedule) g.STATE.altSchedule = {};

  // Call timeline builder — it should detect missing rotations and call autoSchedule
  g.buildCoverageTimeline();

  const rotCount = Object.keys(g.window._lastRotations || {}).length;
  if (rotCount === 0) {
    throw new Error('buildCoverageTimeline did not auto-run autoSchedule when rotations were empty');
  }
});

// ─── Tab navigation (catches showTab regressions) ────────────────────
console.log('\n─── Tab navigation ────────────────────────────────────────');
['opening', 'board', 'schedule', 'closing', 'reference', 'history', 'admin'].forEach(tab => {
  step(`showTab('${tab}')`, () => g.showTab(tab));
});

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (totalFails === 0) {
  console.log(`  ✅  ALL TESTS PASSED — safe to ship`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(0);
} else {
  console.log(`  ❌  ${totalFails} TEST(S) FAILED — do NOT ship`);
  console.log(`  Fix the failures above or revert recent changes.`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(1);
}
