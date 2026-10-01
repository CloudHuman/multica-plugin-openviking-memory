import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';
import { atomicWriteJson } from '../src/util.mjs';
import { tempStateDir } from './helpers.mjs';

test('accepted delivery IDs survive restart and bounded retention', () => {
  const stateDir = tempStateDir();
  const ledger = new Ledger({ stateDir, maxKeys: 2 });
  ledger.add('inv:old');
  ledger.add('inv:next');
  ledger.add('inv:latest');
  const restarted = new Ledger({ stateDir });
  assert.equal(restarted.has('inv:old'), false);
  assert.equal(restarted.has('inv:next'), true);
  assert.equal(restarted.has('inv:latest'), true);
});

test('legacy bare-map delivery ledgers retain dedupe IDs after upgrade', () => {
  const stateDir = tempStateDir();
  atomicWriteJson(`${stateDir}/ledger.json`, { 'inv:legacy': '2026-09-30T00:00:00Z' });
  const ledger = new Ledger({ stateDir });
  assert.equal(ledger.has('inv:legacy'), true);
  ledger.add('inv:new');
  const restarted = new Ledger({ stateDir });
  assert.equal(restarted.has('inv:legacy'), true);
  assert.equal(restarted.has('inv:new'), true);
});

test('failed ledger persistence does not mark a delivery accepted in memory', () => {
  const stateDir = tempStateDir();
  const ledger = new Ledger({ stateDir });
  ledger.path = stateDir; // Renaming a JSON file onto a directory must fail.
  assert.throws(() => ledger.add('inv:retry'));
  assert.equal(ledger.has('inv:retry'), false);
  ledger.path = `${stateDir}/ledger.json`;
  ledger.add('inv:retry');
  assert.equal(new Ledger({ stateDir }).has('inv:retry'), true);
});
