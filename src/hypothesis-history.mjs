// Base rates for competing hypotheses: reference-class forecasting across
// sessions.
//
// A team that opens "why does the login test fail only on CI?" with a flat
// prior ignores what it already learned: the last four similar questions in
// this setup were a missing environment variable twice, a race once and a
// timezone never. Kahneman and Lovallo call this neglect of the outside view;
// the remedy is to start from the base rate of the reference class. Here every
// question the coordinator resolves on the hypotheses matrix is kept as a case
// (the question, the explanation that was right, the ones that were wrong).
// When a new question is opened, the similar past questions form its
// reference class, and each hypothesis's prior is scaled by how often similar
// explanations were the answer (wins) or were ruled out (losses):
//
//   prior multiplier = (1 + wins) / (1 + losses), within [1/3, 3]
//
// with each case weighted by how similar its question is. The prior only
// shifts the starting point; evidence still decides. Each hypothesis shows its
// base rate so agents can see why it starts ahead.
//
// File: <config>/sessions/hypothesis-history.json (300 cases), moved with
// OASIS_HYPOTHESIS_HISTORY_FILE, off with OASIS_HYPOTHESIS_HISTORY=0.

import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getConfigDirectory } from './config.mjs';
import { tokenize } from './auto-memory.mjs';

const MAX_CASES = 300;
const QUESTION_SIMILARITY = 0.2;
const HYPOTHESIS_SIMILARITY = 0.4;
const MAX_REFERENCES = 20;

export function hypothesisHistoryEnabled(env = process.env) {
  return !['0', 'false', 'off', 'no'].includes(String(env.OASIS_HYPOTHESIS_HISTORY || '').toLowerCase());
}

export function hypothesisHistoryFile(env = process.env) {
  if (env.OASIS_HYPOTHESIS_HISTORY_FILE) return path.resolve(env.OASIS_HYPOTHESIS_HISTORY_FILE);
  return path.join(getConfigDirectory(env), 'sessions', 'hypothesis-history.json');
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeCase(item) {
  if (!item || typeof item !== 'object') return null;
  const question = clean(item.question, 300);
  const answer = clean(item.answer, 300);
  if (!question || !clean(item.id, 120)) return null;
  return { id: clean(item.id, 120), question, answer, rejected: (Array.isArray(item.rejected) ? item.rejected : []).map((text) => clean(text, 300)).filter(Boolean).slice(0, 8), at: Number.isFinite(item.at) ? item.at : 0 };
}

/** A case store; with a file it loads lazily and saves atomically, without one it lives in memory. */
export function createHypothesisHistory({ file = '', now = () => Date.now() } = {}) {
  let cases = null;
  let writable = Boolean(file);
  const load = () => {
    if (cases) return cases;
    cases = [];
    if (!file) return cases;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const raw of Array.isArray(data && data.cases) ? data.cases.slice(-MAX_CASES) : []) { const item = sanitizeCase(raw); if (item) cases.push(item); }
    } catch {}
    return cases;
  };
  const save = () => {
    if (!writable) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.' + process.pid + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, cases }) + '\n', { mode: 0o600 });
      renameSync(temp, file);
    } catch { writable = false; }
  };
  return {
    file,
    cases: () => load().slice(),
    record(input) {
      const item = sanitizeCase({ ...input, at: now() });
      if (!item) return null;
      const list = load();
      const index = list.findIndex((entry) => entry.id === item.id);
      if (index >= 0) list[index] = item; else list.push(item);
      if (list.length > MAX_CASES) list.splice(0, list.length - MAX_CASES);
      save();
      return item;
    }
  };
}

const shared = new Map();
export function sharedHypothesisHistory(env = process.env) {
  if (!hypothesisHistoryEnabled(env)) return null;
  const file = hypothesisHistoryFile(env);
  if (!shared.has(file)) shared.set(file, createHypothesisHistory({ file }));
  return shared.get(file);
}

function jaccard(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let both = 0;
  for (const term of left) if (right.has(term)) both++;
  return both / (left.size + right.size - both);
}

/**
 * Priors for new hypotheses from the reference class of past cases. Returns
 * one { prior, wins, losses, references } per hypothesis text; prior 1 when
 * the history says nothing about it.
 */
export function basePriors(question, hypotheses, cases) {
  const references = (cases || []).map((item) => ({ item, weight: jaccard(question, item.question) }))
    .filter((entry) => entry.weight >= QUESTION_SIMILARITY)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_REFERENCES);
  return hypotheses.map((text) => {
    let wins = 0;
    let losses = 0;
    for (const { item, weight } of references) {
      if (item.answer && jaccard(text, item.answer) >= HYPOTHESIS_SIMILARITY) wins += weight;
      else if (item.rejected.some((other) => jaccard(text, other) >= HYPOTHESIS_SIMILARITY)) losses += weight;
    }
    const prior = Math.min(3, Math.max(1 / 3, (1 + wins) / (1 + losses)));
    return { prior: Math.round(prior * 100) / 100, wins: Math.round(wins * 100) / 100, losses: Math.round(losses * 100) / 100, references: references.length };
  });
}
