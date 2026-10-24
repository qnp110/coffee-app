/* Coffee Dosing PWA: plain JavaScript, no build step.
 *
 * Sections: constants & helpers, storage (incl. schema migrations), ratio calculator, beans,
 * brew notes, backup (export/import), app shell (tabs, banner, service worker), init.
 *
 * Safety rule: user text is only ever inserted with textContent / text nodes (see el()),
 * never via innerHTML.
 */
'use strict';

/* ======================================================================
   Constants & helpers
   ====================================================================== */

// One namespaced key: every *.github.io project site shares the same origin and localStorage.
const STORAGE_KEY = 'coffee-app:data';
const SCHEMA_VERSION = 2;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Upper bounds for numbers (all must also be > 0). Masses in g, time in s.
const LIMITS = { dose: 1000, mass: 10000, ratio: 100, time: 36000, absorption: 5 };
const TEXT_MAX = { short: 100, setting: 200, text: 5000 };

// Typical brew ratio ranges, used only for a gentle warning.
const TYPICAL_RATIO = { espresso: [1, 4], filter: [10, 20] };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

/**
 * Create a DOM element safely.
 * @param {string} tag Element name.
 * @param {object} props Properties/attributes; keys starting with "on" become event listeners.
 * @param {...(Node|string|Array|null)} children Strings become text nodes, so they are never parsed as HTML.
 * @returns {HTMLElement}
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child); // append(string) = text node
  }
  return node;
}

/**
 * Parse a user-typed decimal number. Accepts "," as decimal separator (Swiss/German keyboards).
 * @returns {number|null} null for empty input, NaN for invalid input.
 */
function parseNum(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (s === '') return null;
  return /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

/** Parse a brew time given as seconds ("28") or minutes:seconds ("3:30"). Returns seconds, null or NaN. */
function parseTime(input) {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(input ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : parseNum(input);
}

/** True if n is a finite number with 0 < n <= max. */
function isPos(n, max) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;
}

/** Round to a number of decimals (returns a number). */
function round(n, digits) {
  return Number(n.toFixed(digits));
}

/** Format a number with at most `digits` decimals and no trailing zeros; '' for non-numbers. */
function fmt(n, digits = 1) {
  return typeof n === 'number' && Number.isFinite(n) ? String(round(n, digits)) : '';
}

/** Format seconds as "28 s" or "3:30". */
function fmtTime(seconds) {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Today's date as YYYY-MM-DD in local time (toISOString would use UTC). */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Human-readable date for a YYYY-MM-DD string. */
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Random unique id (with a fallback for older browsers). */
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Trimmed string clipped to max length; '' if the value is not a string. */
function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Split multi-line text into a clean list (one entry per non-empty line, max 100 entries). */
function lines(text) {
  return String(text).split('\n').map((s) => str(s, TEXT_MAX.setting)).filter(Boolean).slice(0, 100);
}

/* ======================================================================
   Storage
   Everything lives in localStorage[STORAGE_KEY] as one JSON object (schema version 2):

   {
     schemaVersion: 2,
     calc: {                         // last calculator values, per mode
       mode: 'espresso' | 'filter',
       espresso: { dose, yield, ratio },
       filter:   { dose, water, ratio, absorption }
     },
     beans: [ { id, name, grinder, settings: ['Espresso: 14', ...], info, notes } ],
     notes: [ { id, date: 'YYYY-MM-DD', beanId, beanName, grinder, grindSetting,
                dose, yield, time, rating, text, createdAt } ]
   }

   Units: masses in g, note time in s, createdAt in ms since 1970. rating is 1-5 or null.
   Empty optional numbers are stored as null. A note's beanName and grinder are snapshots taken
   when it was saved, so the note still reads correctly after the bean is renamed, changed or deleted.

   Changing this shape: bump SCHEMA_VERSION and add a migrateVxToVy() step in normalizeData(),
   so existing data and old backups are upgraded instead of lost.
   ====================================================================== */

// The in-memory copy of the data; every change is written back with saveData().
let data = defaultData();
// If stored data exists but cannot be read, we keep the raw string here and pause saving,
// so a bug or a newer app version can never silently overwrite your data.
let blockedRaw = null;
let persistStatus = 'checking…';

/** Fresh, empty app data. */
function defaultData() {
  return { schemaVersion: SCHEMA_VERSION, calc: defaultCalc(), beans: [], notes: [] };
}

/** Default calculator values. Ratio means yield/dose (espresso) or water/dose (filter). */
function defaultCalc() {
  return {
    mode: 'espresso',
    espresso: { dose: 18, yield: 36, ratio: 2 },
    filter: { dose: 15, water: 240, ratio: 16, absorption: 2 },
  };
}

/** Read data from localStorage. Never throws; on failure returns defaults and explains in a banner. */
function loadData() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    showBanner('Storage is unavailable (private browsing?). Changes will not be saved.', 'error');
    return defaultData();
  }
  if (raw === null) return defaultData();
  try {
    const parsed = JSON.parse(raw);
    const { data: loaded } = normalizeData(parsed);
    // Write back right away if an older schema was upgraded, so the migration runs only once.
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      data = loaded;
      saveData();
    }
    return loaded;
  } catch (err) {
    blockedRaw = raw;
    showBanner(`Saved data could not be read (${err.message}). Saving is paused so nothing is overwritten. See the Data tab.`, 'error');
    return defaultData();
  }
}

/** Write data to localStorage. Returns true on success. */
function saveData() {
  if (blockedRaw !== null) {
    showBanner('Saving is paused because stored data could not be read. Export it or import a backup in the Data tab.', 'error');
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    showBanner('Could not save: storage is full or unavailable. Export a backup.', 'error');
    return false;
  }
}

/**
 * Validate, migrate and clean untrusted data (from storage or an imported file).
 * Fatal problems throw; individual bad entries are dropped and counted.
 * @returns {{data: object, skipped: number}}
 */
function normalizeData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a JSON object');
  const version = obj.schemaVersion;
  if (!Number.isInteger(version) || version < 1) throw new Error('missing or invalid schemaVersion');
  if (version > SCHEMA_VERSION) throw new Error(`schema version ${version} is newer than this app supports (${SCHEMA_VERSION})`);

  // Migrations run one version step at a time, so data of any older version reaches the current one.
  if (version < 2) obj = migrateV1toV2(obj);

  if (!Array.isArray(obj.beans) || !Array.isArray(obj.notes)) throw new Error('beans or notes list missing');
  const beans = uniqueIds(obj.beans.map(normalizeBean).filter(Boolean));
  const notes = uniqueIds(obj.notes.map(normalizeNote).filter(Boolean));
  const skipped = (obj.beans.length - beans.length) + (obj.notes.length - notes.length);
  return { data: { schemaVersion: SCHEMA_VERSION, calc: normalizeCalc(obj.calc), beans, notes }, skipped };
}

/**
 * Schema v1 -> v2: the "grinders" list was replaced by "beans".
 * Each old grinder becomes a bean named "Unnamed bean" that keeps the grinder name and settings
 * (and the same id, so old notes stay linked). Notes get beanId/beanName/grinder from their old grinder fields.
 */
function migrateV1toV2(obj) {
  if (!Array.isArray(obj.grinders) || !Array.isArray(obj.notes)) throw new Error('grinders or notes list missing');
  const isObject = (x) => x !== null && typeof x === 'object';
  return {
    schemaVersion: 2,
    calc: obj.calc,
    beans: obj.grinders.map((g) => (isObject(g)
      ? { id: g.id, name: 'Unnamed bean', grinder: g.name, settings: g.settings, info: '', notes: '' }
      : null)),
    notes: obj.notes.map((n) => (isObject(n)
      ? { ...n, beanId: n.grinderId, beanName: n.grinderId ? 'Unnamed bean' : '', grinder: n.grinderName }
      : null)),
  };
}

/** Give any duplicate ids a fresh id so edit/delete always target exactly one entry. */
function uniqueIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) item.id = newId();
    seen.add(item.id);
  }
  return items;
}

/** Clean one bean, or return null if it has no name. */
function normalizeBean(b) {
  if (!b || typeof b !== 'object') return null;
  const name = str(b.name, TEXT_MAX.short);
  if (!name) return null;
  return {
    id: str(b.id, 100) || newId(),
    name,
    grinder: str(b.grinder, TEXT_MAX.short),
    settings: Array.isArray(b.settings) ? b.settings.map((s) => str(s, TEXT_MAX.setting)).filter(Boolean).slice(0, 100) : [],
    info: str(b.info, TEXT_MAX.text),
    notes: str(b.notes, TEXT_MAX.text),
  };
}

/** Clean one brew note, or return null if it has no valid date. Invalid numbers become null. */
function normalizeNote(n) {
  if (!n || typeof n !== 'object' || typeof n.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.date)) return null;
  const num = (value, max) => (isPos(value, max) ? value : null);
  return {
    id: str(n.id, 100) || newId(),
    date: n.date,
    beanId: str(n.beanId, 100) || null,
    beanName: str(n.beanName, TEXT_MAX.short),
    grinder: str(n.grinder, TEXT_MAX.short),
    grindSetting: str(n.grindSetting, TEXT_MAX.short),
    dose: num(n.dose, LIMITS.dose),
    yield: num(n.yield, LIMITS.mass),
    time: num(n.time, LIMITS.time),
    rating: Number.isInteger(n.rating) && n.rating >= 1 && n.rating <= 5 ? n.rating : null,
    text: str(n.text, TEXT_MAX.text),
    createdAt: Number.isFinite(n.createdAt) ? n.createdAt : 0,
  };
}

/** Clean calculator state; any invalid value falls back to its default. */
function normalizeCalc(c) {
  const d = defaultCalc();
  if (!c || typeof c !== 'object') return d;
  const pick = (src, key, max, fallback) => (src && isPos(src[key], max) ? src[key] : fallback);
  const e = c.espresso, f = c.filter;
  const absorption = f && Number.isFinite(f.absorption) && f.absorption >= 0 && f.absorption <= LIMITS.absorption
    ? f.absorption : d.filter.absorption;
  return {
    mode: c.mode === 'filter' ? 'filter' : 'espresso',
    espresso: {
      dose: pick(e, 'dose', LIMITS.dose, d.espresso.dose),
      yield: pick(e, 'yield', LIMITS.mass, d.espresso.yield),
      ratio: pick(e, 'ratio', LIMITS.ratio, d.espresso.ratio),
    },
    filter: {
      dose: pick(f, 'dose', LIMITS.dose, d.filter.dose),
      water: pick(f, 'water', LIMITS.mass, d.filter.water),
      ratio: pick(f, 'ratio', LIMITS.ratio, d.filter.ratio),
      absorption,
    },
  };
}

/** Ask the browser not to evict our storage under pressure (best effort, mostly matters on iOS). */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const granted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
      persistStatus = granted ? 'Granted' : 'Not granted';
    } else {
      persistStatus = 'Not supported';
    }
  } catch {
    persistStatus = 'Unknown';
  }
  renderDataStatus();
}

/* ======================================================================
   Ratio calculator
   Espresso: ratio = yield / dose.   Filter: ratio = water / dose,
   estimated yield = water - absorption * dose (grounds retain water).
   ====================================================================== */

// The calculator's <input> elements keyed by field name (dose, target, ratio, absorption); filled in init().
// "target" is the yield input in espresso mode and the water input in filter mode.
const calcInputs = {};

/** Current mode's calculator values. */
function calcState() {
  return data.calc[data.calc.mode];
}

/** Name of the "target" value for the current mode. */
function targetKey() {
  return data.calc.mode === 'espresso' ? 'yield' : 'water';
}

/** Decimals for the target value: 0.1 g for espresso, 1 g for filter. */
function targetDigits() {
  return data.calc.mode === 'espresso' ? 1 : 0;
}

/** Upper bound for a calculator field. */
function fieldMax(field) {
  return field === 'target' ? LIMITS.mass : LIMITS[field];
}

/** Estimated beverage yield for filter mode, or null if it cannot be computed. */
function filterYield(s) {
  if (!isPos(s.dose, LIMITS.dose) || !isPos(s.water, LIMITS.mass)) return null;
  const y = s.water - s.absorption * s.dose;
  return y > 0 ? y : null;
}

/**
 * Recompute dependent values after one field was edited.
 * dose changed   -> keep the ratio, scale the target (or derive the ratio if none is set)
 * target changed -> ratio = target / dose
 * ratio changed  -> target = dose * ratio
 */
function recalc(changed) {
  const s = calcState();
  const t = targetKey();
  const okDose = isPos(s.dose, LIMITS.dose);
  const okTarget = isPos(s[t], LIMITS.mass);
  const okRatio = isPos(s.ratio, LIMITS.ratio);

  if (changed === 'dose' && okDose) {
    if (okRatio) s[t] = round(s.dose * s.ratio, targetDigits());
    else if (okTarget) s.ratio = round(s[t] / s.dose, 2);
  } else if (changed === 'target' && okDose && okTarget) {
    s.ratio = round(s[t] / s.dose, 2);
  } else if (changed === 'ratio' && okDose && okRatio) {
    s[t] = round(s.dose * s.ratio, targetDigits());
  }
}

/** Handle typing in a calculator field. */
function onCalcInput(event) {
  const input = event.target;
  const field = input.dataset.field;
  const value = parseNum(input.value);
  const valid = field === 'absorption'
    ? value !== null && value >= 0 && value <= LIMITS.absorption
    : isPos(value, fieldMax(field));

  input.setAttribute('aria-invalid', String(value !== null && !valid)); // empty is "incomplete", not an error
  const s = calcState();
  s[field === 'target' ? targetKey() : field] = valid ? value : null;
  if (valid) recalc(field);
  renderCalc(input); // don't rewrite the field the user is typing in
  saveData();
}

/** Update the calculator UI. `activeInput` (being edited) is left untouched. */
function renderCalc(activeInput = null) {
  const mode = data.calc.mode;
  const s = calcState();
  const t = targetKey();

  $$('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $$('.filter-only').forEach((node) => { node.hidden = mode !== 'filter'; });
  $('#calc-target-label').textContent = mode === 'espresso' ? 'Yield' : 'Water';

  const setValue = (input, value, digits) => {
    if (input === activeInput) return;
    input.value = value === null || value === undefined ? '' : fmt(value, digits);
    input.removeAttribute('aria-invalid');
  };
  setValue(calcInputs.dose, s.dose, 1);
  setValue(calcInputs.target, s[t], targetDigits());
  setValue(calcInputs.ratio, s.ratio, 2);
  if (mode === 'filter') setValue(calcInputs.absorption, s.absorption, 1);

  // Big ratio and summary line
  const okRatio = isPos(s.ratio, LIMITS.ratio);
  $('#ratio-big').textContent = okRatio ? `1:${fmt(s.ratio, 2)}` : '1:–';
  const g = (n, digits = 1) => (isPos(n, LIMITS.mass) ? `${fmt(n, digits)} g` : '– g');
  if (mode === 'espresso') {
    $('#ratio-summary').textContent = `${g(s.dose)} coffee → ${g(s.yield)} in the cup`;
  } else {
    const y = filterYield(s);
    $('#ratio-summary').textContent = `${g(s.dose)} coffee + ${g(s.water, 0)} water ≈ ${y === null ? '–' : fmt(y, 0)} g in the cup`;
  }

  $('#calc-hint').textContent = calcHint(s, t);
}

/** Short message about missing/invalid values or an unusual ratio ('' if all is fine). */
function calcHint(s, t) {
  const missing = [];
  if (!isPos(s.dose, LIMITS.dose)) missing.push('dose');
  if (!isPos(s[t], LIMITS.mass)) missing.push(t);
  if (!isPos(s.ratio, LIMITS.ratio)) missing.push('ratio');
  if (missing.length) return `Enter a positive number for: ${missing.join(', ')}.`;

  const [lo, hi] = TYPICAL_RATIO[data.calc.mode];
  if (s.ratio < lo || s.ratio > hi) return `1:${fmt(s.ratio, 2)} is unusual for ${data.calc.mode} (typical 1:${lo} to 1:${hi}).`;
  if (data.calc.mode === 'filter' && filterYield(s) === null) return 'Not enough water to cover absorption.';
  return '';
}

/** Switch between espresso and filter mode. */
function setCalcMode(mode) {
  data.calc.mode = mode;
  renderCalc();
  saveData();
}

/** Open a new brew note prefilled from the calculator. */
function calcToNote() {
  const s = calcState();
  if (data.calc.mode === 'espresso') {
    openNoteDialog(null, { dose: s.dose, yield: s.yield });
  } else {
    const y = filterYield(s);
    openNoteDialog(null, {
      dose: s.dose,
      yield: y === null ? null : round(y, 0),
      text: `Filter: ${fmt(s.water, 0)} g water, 1:${fmt(s.ratio, 2)}`,
    });
  }
}

/* ======================================================================
   Beans
   ====================================================================== */

// id of the bean open in the editor sheet, or null when adding a new one.
let editingBeanId = null;

/** Render the bean list; tapping a card opens its editor. */
function renderBeans() {
  $('#bean-list').replaceChildren(...data.beans.map((b) => el('li', {},
    el('button', { type: 'button', class: 'card', onclick: () => openBeanDialog(b) },
      el('span', { class: 'card-title' }, b.name),
      b.grinder ? el('span', { class: 'card-sub' }, b.grinder) : null,
      b.settings.length ? el('span', { class: 'chips' }, b.settings.map((s) => el('span', { class: 'chip' }, s))) : null,
      b.info ? [el('span', { class: 'card-label' }, 'Bean info'), el('span', { class: 'card-text' }, b.info)] : null,
      b.notes ? [el('span', { class: 'card-label' }, 'Notes'), el('span', { class: 'card-text' }, b.notes)] : null,
    ),
  )));
  $('#bean-empty').hidden = data.beans.length > 0;
}

/** All grinder names used so far (beans and notes), for the grinder suggestions. */
function knownGrinders() {
  const names = [...data.beans.map((b) => b.grinder), ...data.notes.map((n) => n.grinder)].filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Open the bean editor (b = null to add a new bean). */
function openBeanDialog(b = null) {
  const form = $('#bean-form');
  editingBeanId = b ? b.id : null;
  $('#bean-dialog-title').textContent = b ? 'Edit bean' : 'New bean';
  form.elements.name.value = b ? b.name : '';
  form.elements.grinder.value = b ? b.grinder : '';
  form.elements.settings.value = b ? b.settings.join('\n') : '';
  form.elements.info.value = b ? b.info : '';
  form.elements.notes.value = b ? b.notes : '';
  $('#grinder-options').replaceChildren(...knownGrinders().map((g) => el('option', { value: g })));
  form.querySelector('.edit-only').hidden = !b;
  setFormError(form, '');
  openSheet('#bean-dialog');
}

/** Validate and save the bean form. */
function onBeanSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const f = form.elements;
  const name = str(f.name.value, TEXT_MAX.short);
  if (!name) return setFormError(form, 'Please enter a name for the bean.');

  const bean = {
    name,
    grinder: str(f.grinder.value, TEXT_MAX.short),
    settings: lines(f.settings.value),
    info: str(f.info.value, TEXT_MAX.text),
    notes: str(f.notes.value, TEXT_MAX.text),
  };
  const existing = data.beans.find((b) => b.id === editingBeanId);
  if (existing) Object.assign(existing, bean);
  else data.beans.push({ id: newId(), ...bean });

  saveData();
  $('#bean-dialog').close();
  renderAll();
}

/** Delete the bean open in the editor, after confirmation. Notes keep the bean's name as a snapshot. */
function deleteBean() {
  const bean = data.beans.find((b) => b.id === editingBeanId);
  if (!bean) return;
  const used = data.notes.filter((n) => n.beanId === bean.id).length;
  const extra = used ? `\n\n${used} brew note(s) use it; they will keep showing its name.` : '';
  if (!confirm(`Delete "${bean.name}"?${extra}`)) return;
  data.beans = data.beans.filter((b) => b.id !== bean.id);
  saveData();
  $('#bean-dialog').close();
  renderAll();
}

/* ======================================================================
   Brew notes
   ====================================================================== */

// id of the note open in the editor sheet, or null when adding a new one.
let editingNoteId = null;

/** Sort order for notes: newest date first, then most recently created. */
function compareNotes(a, b) {
  return b.date.localeCompare(a.date) || b.createdAt - a.createdAt;
}

/** Display name of a note's bean: its current name, or the saved snapshot if it was deleted. */
function noteBeanName(n) {
  const bean = data.beans.find((b) => b.id === n.beanId);
  return bean ? bean.name : n.beanName;
}

/**
 * Grinder to record for a note with the given bean. When editing a note whose bean is unchanged,
 * keep its snapshot (the grinder actually used back then); otherwise take the bean's current grinder.
 */
function grinderForNote(beanId) {
  const existing = data.notes.find((n) => n.id === editingNoteId);
  if (existing && existing.beanId === beanId && existing.grinder) return existing.grinder;
  const bean = data.beans.find((b) => b.id === beanId);
  return bean ? bean.grinder : '';
}

/** Bean to preselect for a new note: the one from the newest note, else the first bean. */
function defaultBeanId() {
  const newest = [...data.notes].sort(compareNotes)[0];
  if (newest && data.beans.some((b) => b.id === newest.beanId)) return newest.beanId;
  return data.beans.length ? data.beans[0].id : null;
}

/** Render brew notes, newest first; tapping a card opens its editor. */
function renderNotes() {
  $('#note-list').replaceChildren(...[...data.notes].sort(compareNotes).map((n) => {
    const beanName = noteBeanName(n);
    const grinderLine = [n.grinder, n.grindSetting].filter(Boolean).join(' · ');
    const stats = [
      n.dose !== null ? ['Dose', `${fmt(n.dose)} g`] : null,
      n.yield !== null ? ['Yield', `${fmt(n.yield)} g`] : null,
      n.dose !== null && n.yield !== null ? ['Ratio', `1:${fmt(n.yield / n.dose, 2)}`] : null,
      n.time !== null ? ['Time', fmtTime(n.time)] : null,
    ].filter(Boolean);

    return el('li', {},
      el('button', { type: 'button', class: 'card', onclick: () => openNoteDialog(n) },
        el('span', { class: 'card-top' },
          el('span', { class: 'card-title' }, fmtDate(n.date)),
          n.rating ? el('span', { class: 'stars', role: 'img', 'aria-label': `Rating ${n.rating} of 5` }, '★'.repeat(n.rating) + '☆'.repeat(5 - n.rating)) : null),
        beanName ? el('span', { class: 'chips' }, el('span', { class: 'chip lavender' }, beanName)) : null,
        grinderLine ? el('span', { class: 'card-sub' }, grinderLine) : null,
        stats.length ? el('span', { class: 'stats' }, stats.map(([label, value]) => el('span', { class: 'stat' },
          el('span', { class: 'stat-label' }, label),
          el('span', { class: 'stat-value' }, value)))) : null,
        n.text ? el('span', { class: 'card-text' }, n.text) : null,
      ),
    );
  }));
  $('#note-empty').hidden = data.notes.length > 0;
}

/**
 * Open the note editor.
 * @param {object|null} n Existing note to edit, or null for a new one.
 * @param {object} prefill Values for a new note (e.g. from the calculator).
 */
function openNoteDialog(n = null, prefill = {}) {
  const form = $('#note-form');
  const f = form.elements;
  const src = n || { date: todayISO(), beanId: defaultBeanId(), beanName: '', grindSetting: '', dose: null, yield: null, time: null, rating: null, text: '', ...prefill };
  editingNoteId = n ? n.id : null;
  $('#note-dialog-title').textContent = n ? 'Edit brew note' : 'New brew note';

  // Bean options; keep a deleted bean selectable so editing the note doesn't lose it.
  const options = [el('option', { value: '' }, 'None'), ...data.beans.map((b) => el('option', { value: b.id }, b.name))];
  if (src.beanId && !data.beans.some((b) => b.id === src.beanId)) {
    options.push(el('option', { value: src.beanId }, `${src.beanName || 'Unknown'} (deleted)`));
  }
  f.beanId.replaceChildren(...options);
  f.beanId.value = src.beanId || '';

  f.date.value = src.date;
  f.grindSetting.value = src.grindSetting || '';
  f.dose.value = fmt(src.dose);
  f.yield.value = fmt(src.yield);
  // Show times of a minute or more as m:ss (parseTime accepts both forms).
  f.time.value = src.time === null ? '' : src.time >= 60 ? fmtTime(src.time) : String(Math.round(src.time));
  f.rating.value = src.rating ? String(src.rating) : '';
  f.text.value = src.text || '';
  form.querySelector('.edit-only').hidden = !n;
  setFormError(form, '');
  updateNoteForm();
  openSheet('#note-dialog');
}

/** Refresh the derived parts of the note form: grinder, grind setting suggestions and ratio. */
function updateNoteForm() {
  const f = $('#note-form').elements;
  const bean = data.beans.find((b) => b.id === f.beanId.value);
  $('#note-grinder').textContent = grinderForNote(f.beanId.value || null) || '–';
  $('#grind-setting-options').replaceChildren(...(bean ? bean.settings : []).map((s) => el('option', { value: s })));

  const dose = parseNum(f.dose.value);
  const yld = parseNum(f.yield.value);
  $('#note-ratio').textContent = isPos(dose, LIMITS.dose) && isPos(yld, LIMITS.mass) ? `1:${fmt(yld / dose, 2)}` : '–';
}

/** Validate and save the note form. */
function onNoteSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const f = form.elements;
  const errors = [];

  const date = f.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('a date');

  // Optional numbers: empty is fine, otherwise must be valid and in range.
  const optional = (value, max, label) => {
    if (value === null) return null;
    if (!isPos(value, max)) { errors.push(label); return null; }
    return value;
  };
  const dose = optional(parseNum(f.dose.value), LIMITS.dose, `a dose between 0 and ${LIMITS.dose} g`);
  const yld = optional(parseNum(f.yield.value), LIMITS.mass, `a yield between 0 and ${LIMITS.mass} g`);
  const time = optional(parseTime(f.time.value), LIMITS.time, 'a time like 28 or 3:30');
  if (errors.length) return setFormError(form, `Please enter ${errors.join(', ')}.`);

  const beanId = f.beanId.value || null;
  const bean = data.beans.find((b) => b.id === beanId);
  const existing = data.notes.find((n) => n.id === editingNoteId);
  const note = {
    id: existing ? existing.id : newId(),
    date,
    beanId,
    // Snapshot of the bean name; for a deleted bean keep the old snapshot.
    beanName: bean ? bean.name : (existing && existing.beanId === beanId ? existing.beanName : ''),
    grinder: grinderForNote(beanId),
    grindSetting: str(f.grindSetting.value, TEXT_MAX.short),
    dose,
    yield: yld,
    time,
    rating: f.rating.value ? Number(f.rating.value) : null,
    text: str(f.text.value, TEXT_MAX.text),
    createdAt: existing ? existing.createdAt : Date.now(),
  };
  if (existing) Object.assign(existing, note);
  else data.notes.push(note);

  saveData();
  $('#note-dialog').close();
  renderAll();
  showView('notes');
}

/** Delete the note open in the editor, after confirmation. */
function deleteNote() {
  const note = data.notes.find((n) => n.id === editingNoteId);
  if (!note || !confirm(`Delete the brew note from ${fmtDate(note.date)}?`)) return;
  data.notes = data.notes.filter((n) => n.id !== note.id);
  saveData();
  $('#note-dialog').close();
  renderAll();
}

/** Show (or clear, with '') an error message inside a sheet form. */
function setFormError(form, message) {
  const p = form.querySelector('.form-error');
  p.textContent = message;
  p.hidden = !message;
}

/** Open a bottom sheet dialog, scrolled to its top. */
function openSheet(selector) {
  const dialog = $(selector);
  dialog.querySelector('.sheet-body').scrollTop = 0;
  dialog.showModal();
}

/* ======================================================================
   Backup: export / import
   ====================================================================== */

/** Download the data as JSON (or share it on touch devices, which works better in iOS home screen apps). */
async function exportData() {
  // If stored data was unreadable, export it untouched so nothing is lost.
  const json = blockedRaw ?? JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
  const name = `coffee-app-${blockedRaw === null ? 'backup' : 'raw'}-${todayISO()}.json`;
  const file = new File([json], name, { type: 'application/json' });

  if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user closed the share sheet
      // otherwise fall back to a normal download
    }
  }
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Validate a chosen backup file (older schema versions are migrated) and, after confirmation, replace all data. */
async function importFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) return showBanner('That file is too large to be a backup. Nothing was changed.', 'error');

  let result;
  try {
    result = normalizeData(JSON.parse(await file.text()));
  } catch (err) {
    return showBanner(`Import failed: ${err.message}. Nothing was changed.`, 'error');
  }

  const incoming = result.data;
  const current = blockedRaw === null
    ? `ALL current data (${data.beans.length} beans, ${data.notes.length} notes)`
    : 'the unreadable stored data';
  const skipped = result.skipped ? `\n\n${result.skipped} invalid entries in the file will be skipped.` : '';
  const ok = confirm(`Replace ${current} with this backup (${incoming.beans.length} beans, ${incoming.notes.length} notes)?${skipped}\n\n`
    + 'This cannot be undone. Export first if unsure.');
  if (!ok) return;

  data = incoming;
  blockedRaw = null;
  if (saveData()) showBanner('Backup imported.');
  renderAll();
}

/** Render the status list on the Data tab. */
function renderDataStatus() {
  const rows = [
    ['Beans', String(data.beans.length)],
    ['Brew notes', String(data.notes.length)],
    ['Persistent storage', persistStatus],
    ['Saving', blockedRaw === null ? 'Active' : 'Paused'],
    ['Schema version', String(SCHEMA_VERSION)],
  ];
  $('#data-status').replaceChildren(...rows.map(([k, v]) => el('div', { class: 'row' }, el('dt', {}, k), el('dd', {}, v))));
}

/* ======================================================================
   App shell: tabs, banner, service worker
   ====================================================================== */

// Header title per tab (keys match data-view on the tab buttons and the view-* section ids).
const VIEW_TITLES = { ratio: 'Ratio', beans: 'Beans', notes: 'Brew Notes', data: 'Data' };
let bannerTimer = null; // auto-hide timer for info banners

/** Show one tab's view and hide the others. */
function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.tabbar button').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#view-title').textContent = VIEW_TITLES[name];
  window.scrollTo(0, 0);
}

/**
 * Show a message above the tab bar.
 * @param {string} message Plain text.
 * @param {'info'|'error'|'update'} kind Info messages hide automatically; others stay until dismissed.
 * @param {{label: string, run: Function}} [action] Optional button.
 */
function showBanner(message, kind = 'info', action = null) {
  const banner = $('#banner');
  banner.replaceChildren(
    el('span', {}, message),
    action ? el('button', { type: 'button', class: 'banner-action', onclick: action.run }, action.label) : null,
    el('button', { type: 'button', class: 'banner-close', 'aria-label': 'Dismiss', onclick: () => { banner.hidden = true; } }, '×'),
  );
  banner.className = `banner ${kind}`;
  banner.hidden = false;
  clearTimeout(bannerTimer);
  if (kind === 'info') bannerTimer = setTimeout(() => { banner.hidden = true; }, 4000);
}

/** Register the service worker and offer a reload when a new version takes over. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller); // false on the very first visit
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showBanner('A new version is ready.', 'update', { label: 'Reload', run: () => location.reload() });
  });
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => {
      // Home screen apps are often resumed rather than reloaded, so check for updates on resume.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn('Service worker registration failed:', err));
}

/** Re-render every view from `data`. */
function renderAll() {
  renderCalc();
  renderBeans();
  renderNotes();
  renderDataStatus();
}

/* ======================================================================
   Init
   ====================================================================== */

/** Wire up event handlers, load data and render. Runs after the DOM is parsed (script is deferred). */
function init() {
  for (const field of ['dose', 'target', 'ratio', 'absorption']) {
    const input = $(`#calc-${field}`);
    calcInputs[field] = input;
    input.addEventListener('input', onCalcInput);
    input.addEventListener('change', () => renderCalc()); // tidy the value (e.g. "18," -> "18") on blur
  }
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => setCalcMode(b.dataset.mode)));
  $('#calc-to-note').addEventListener('click', calcToNote);

  $('#add-bean').addEventListener('click', () => openBeanDialog());
  $('#bean-form').addEventListener('submit', onBeanSubmit);
  $('#bean-delete').addEventListener('click', deleteBean);

  $('#add-note').addEventListener('click', () => openNoteDialog());
  $('#note-form').addEventListener('submit', onNoteSubmit);
  $('#note-form').addEventListener('input', updateNoteForm);
  $('#note-delete').addEventListener('click', deleteNote);

  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  $('#export-btn').addEventListener('click', exportData);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (event) => {
    await importFile(event.target.files[0]);
    event.target.value = ''; // allow choosing the same file again
  });

  data = loadData();
  renderAll();
  showView('ratio');
  requestPersistence();
  registerServiceWorker();
}

init();
