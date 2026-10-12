import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, encodeCsv } from '../src/lib/csv.js';

test('CSV escaping keeps spreadsheet formula-like text inert, including after whitespace', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(' \t@SUM(A1:A2)'), '"\' \t@SUM(A1:A2)"');
  assert.equal(csvCell('\u0000-5+5'), '"\'\u0000-5+5"');
  assert.equal(csvCell('ordinary text'), '"ordinary text"');
});

test('CSV escaping preserves numeric values and correctly quotes separators, quotes, and newlines', () => {
  assert.equal(csvCell(-12.5), '"-12.5"');
  assert.equal(encodeCsv([['name', 'value'], ['A, "B"\nC', 12.5]]), '"name","value"\r\n"A, ""B""\nC","12.5"');
});
