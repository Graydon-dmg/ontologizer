// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh temp directory to use as a store home. */
export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
}

/** Parsed events of a fixture, e.g. fixtureEvents('plastic-modeling'). @param {string} name @returns {any[]} */
export function fixtureEvents(name) {
  const file = new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
