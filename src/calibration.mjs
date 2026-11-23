// Calibration ledger: how far to trust a model's stated confidence.
//
// Agents attach a confidence (0-1) to the findings they post on the shared
// knowledge board. Most of those findings are later settled by something the
// runtime sees, not by the author's say-so:
//
//   held      another agent independently corroborated it with grounded
//             evidence, or the finding that disputed it was retracted
//   failed    its author withdrew it, the main agent retracted it, or it lost
//             a dispute (the other side stood and this one was retracted)
//
// Each settled finding is one forecast: (stated p, outcome 0/1), recorded per
// model and agent type in <config>/sessions/calibration.json. From those,
//
//   brier          mean (p - outcome)^2; 0 is perfect, 0.25 is a coin flip
//   overconfidence mean stated p minus the rate the findings actually held
//   calibrated(p)  what this model's stated p has meant so far: a kernel-
//                  weighted hit rate of its past forecasts near p, shrunk
//                  toward p itself while the record is thin
//
// The board shows the calibrated value next to the stated one, ranks search
// results by it, and puts "stated 0.9, holds ~0.6 for this model" in front of
// the agents reading the finding. A model that says 95% about everything
// stops being believed at 95%.
//
// Local and best-effort: an unwritable disk turns persistence off and the
// board carries on. OASIS_CALIBRATION=0 (or settings "calibration": false)
// turns it off; OASIS_CALIBRATION_FILE moves the file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const CALIBRATION_VERSION = 1;
const MAX_RECORDS = 5000;
const PRIOR_WEIGHT = 4;
const BANDWIDTH = 0.12;
const MIN_FOR_ADJUST = 5;
const OUTCOME_KINDS = new Set(['corroborated', 'won-dispute', 'supported', 'withdrawn', 'retracted', 'lost-dispute', 'verified', 'refuted']);

export function calibrationEnabled(env = process.env, settings = null) {
  if (settings && settings.calibration === false) return false;
  return !['0', 'false', 'off', 'no'].includes(String(env.OASIS_CALIBRATION || '').toLowerCase());
}

export function calibrationFile(env = process.env) {
  if (env.OASIS_CALIBRATION_FILE) return path.resolve(env.OASIS_CALIBRATION_FILE);
  return path.join(getConfigDirectory(env), 'sessions', 'calibration.json');
}

/** A stated confidence: a number in [0, 1], a percentage, or a word. Null when absent or unreadable. */
export function parseConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    const words = { certain: 0.99, 'very likely': 0.9, likely: 0.75, probable: 0.7, 'even odds': 0.5, possible: 0.4, unlikely: 0.25, 'very unlikely': 0.1 };
    if (Object.hasOwn(words, text)) return words[text];
    const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
    if (percent) return clampP(Number(percent[1]) / 100);
    value = Number(text);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return clampP(number > 1 && number <= 100 ? number / 100 : number);
}

function clampP(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 1000) / 1000;
}

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function sanitizeRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const p = clampP(Number(item.p));
  const o = item.o === 1 || item.o === 0 ? item.o : null;
  const id = cleanText(item.id, 160);
  if (p === null || o === null || !id) return null;
  return { id, model: cleanText(item.model, 120) || 'unknown', type: cleanText(item.type, 80), p, o, kind: OUTCOME_KINDS.has(item.kind) ? item.kind : 'verified', at: Number.isFinite(item.at) ? item.at : Date.now() };
}

/**
 * A ledger of settled forecasts. With a file it loads lazily and saves after
 * each change (atomic rename); without one it lives in memory (tests, and the
 * fallback when the disk is read-only).
 */
export function createCalibrationLedger({ file = '', now = () => Date.now() } = {}) {
  let records = null;
  let writable = Boolean(file);
  const load = () => {
    if (records) return records;
    records = [];
    if (!file) return records;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const raw of Array.isArray(data && data.records) ? data.records.slice(-MAX_RECORDS) : []) {
        const record = sanitizeRecord(raw);
        if (record) records.push(record);
      }
    } catch {}
    return records;
  };
  const save = () => {
    if (!writable) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.' + process.pid + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: CALIBRATION_VERSION, records }) + '\n', { mode: 0o600 });
      renameSync(temp, file);
    } catch { writable = false; }
  };
  return {
    file,
    /** Record (or replace, by id) one settled forecast. Returns the stored record or null. */
    record(input) {
      const record = sanitizeRecord({ ...input, at: input && Number.isFinite(input.at) ? input.at : now() });
      if (!record) return null;
      const list = load();
      const index = list.findIndex((item) => item.id === record.id);
      if (index >= 0) list[index] = record; else list.push(record);
      if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
      save();
      return record;
    },
    records({ model = '', type = '' } = {}) {
      return load().filter((item) => (!model || item.model === model) && (!type || item.type === type));
    },
    forget({ model = '' } = {}) {
      const list = load();
      const before = list.length;
      records = model ? list.filter((item) => item.model !== model) : [];
      save();
      return before - records.length;
    }
  };
}

const shared = new Map();
/** The ledger for this environment, or null when calibration is off. */
export function sharedCalibrationLedger(env = process.env, settings = null) {
  if (!calibrationEnabled(env, settings)) return null;
  const file = calibrationFile(env);
  if (!shared.has(file)) shared.set(file, createCalibrationLedger({ file }));
  return shared.get(file);
}

export function resetCalibrationLedgers() {
  shared.clear();
}

/** Brier score, log loss, mean stated p, hit rate and overconfidence of a set of forecasts. */
export function scoreForecasts(records) {
  const list = Array.isArray(records) ? records.filter((item) => item && Number.isFinite(item.p) && (item.o === 0 || item.o === 1)) : [];
  if (!list.length) return { n: 0 };
  let brier = 0; let logLoss = 0; let stated = 0; let held = 0;
  for (const { p, o } of list) {
    brier += (p - o) ** 2;
    const q = Math.min(1 - 1e-3, Math.max(1e-3, p));
    logLoss -= o ? Math.log(q) : Math.log(1 - q);
    stated += p; held += o;
  }
  const n = list.length;
  const round = (value) => Math.round(value * 1000) / 1000;
  return { n, brier: round(brier / n), logLoss: round(logLoss / n), meanStated: round(stated / n), hitRate: round(held / n), overconfidence: round((stated - held) / n) };
}

/** Reliability table: forecasts grouped into bins of stated p, with how often each bin held. */
export function reliability(records, bins = 5) {
  const out = Array.from({ length: bins }, (_, index) => ({ from: index / bins, to: (index + 1) / bins, n: 0, stated: 0, held: 0 }));
  for (const { p, o } of records || []) {
    const bin = out[Math.min(bins - 1, Math.floor(p * bins))];
    bin.n++; bin.stated += p; bin.held += o;
  }
  return out.filter((bin) => bin.n).map((bin) => ({ range: bin.from.toFixed(1) + '-' + bin.to.toFixed(1), n: bin.n, stated: Math.round(bin.stated / bin.n * 100) / 100, held: Math.round(bin.held / bin.n * 100) / 100 }));
}

/**
 * What a stated p has meant for this record: a Gaussian-kernel hit rate of
 * past forecasts near p, with PRIOR_WEIGHT pseudo-forecasts at p itself so a
 * thin record barely moves it. Returns { p, n, adjusted } where adjusted says
 * whether the record was large enough to change anything.
 */
export function calibrate(p, records, { bandwidth = BANDWIDTH, prior = PRIOR_WEIGHT, minRecords = MIN_FOR_ADJUST } = {}) {
  const stated = clampP(Number(p));
  if (stated === null) return null;
  const list = Array.isArray(records) ? records : [];
  if (list.length < minRecords) return { p: stated, n: list.length, adjusted: false };
  let weight = prior; let held = prior * stated; let near = 0;
  for (const item of list) {
    const w = Math.exp(-(((item.p - stated) / bandwidth) ** 2) / 2);
    weight += w; held += w * item.o;
    if (w > 0.6) near++;
  }
  const value = Math.round(held / weight * 100) / 100;
  return { p: value, n: list.length, near, adjusted: Math.abs(value - stated) >= 0.01 };
}

/** Per model (and agent type) scores, worst calibrated first. */
export function calibrationTable(records, { by = ['model'] } = {}) {
  const groups = new Map();
  for (const item of records || []) {
    const key = by.map((field) => item[field] || '-').join('\u0000');
    if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(by.map((field) => [field, item[field] || '-'])), records: [] });
    groups.get(key).records.push(item);
  }
  return [...groups.values()].map(({ records: list, ...rest }) => ({ ...rest, ...scoreForecasts(list), reliability: reliability(list) }))
    .sort((a, b) => b.brier - a.brier || b.n - a.n);
}

export function formatCalibrationTable(rows) {
  if (!rows.length) return 'No settled forecasts yet. Agents state a confidence when they post findings with knowledge_post; a finding is settled when another agent corroborates it or it is retracted or loses a dispute.';
  const lines = ['Calibration: how often each model\'s stated confidence held (Brier 0 is perfect, 0.25 is a coin flip).', ''];
  for (const row of rows) {
    const lean = row.overconfidence > 0.05 ? 'overconfident by ' + Math.round(row.overconfidence * 100) + ' points' : row.overconfidence < -0.05 ? 'underconfident by ' + Math.round(-row.overconfidence * 100) + ' points' : 'well calibrated';
    lines.push(row.model + (row.type && row.type !== '-' ? ' (' + row.type + ')' : '') + ': ' + row.n + ' settled, Brier ' + row.brier.toFixed(3) + ', stated ' + Math.round(row.meanStated * 100) + '% on average, held ' + Math.round(row.hitRate * 100) + '%: ' + lean);
    if (row.reliability.length > 1) lines.push('  ' + row.reliability.map((bin) => bin.range + ': stated ' + bin.stated + ', held ' + bin.held + ' (n ' + bin.n + ')').join('; '));
  }
  return lines.join('\n');
}

/** One-line reading of a calibrated confidence, for agents. */
export function describeCalibration(stated, calibrated, model) {
  if (!calibrated || !calibrated.adjusted) return '';
  return 'stated ' + stated + '; ' + (model || 'this model') + '\'s findings at that confidence have held about ' + Math.round(calibrated.p * 100) + '% of the time (' + calibrated.n + ' settled)';
}
