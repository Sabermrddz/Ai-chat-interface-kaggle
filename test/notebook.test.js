'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { buildNotebook, parseBlocks } = require('../scripts/build-notebook');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'kaggle', 'notebook.py');
const OUTPUT_PATH = path.join(ROOT, 'kaggle', 'notebook.ipynb');

function cellSource(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

test('parseBlocks splits code and markdown cells', () => {
  const blocks = parseBlocks(
    [
      '# %% [markdown]',
      '# Title',
      '#',
      '# Details',
      '',
      '# %%',
      'value = 1',
      '',
      '# %%',
      'print(value)'
    ].join('\n')
  );

  assert.deepEqual(blocks, [
    { type: 'markdown', source: 'Title\n\nDetails' },
    { type: 'code', source: 'value = 1' },
    { type: 'code', source: 'print(value)' }
  ]);
});

test('buildNotebook creates valid nbformat cells', () => {
  const notebook = buildNotebook('# %%\nprint("hi")\n');
  const codeCell = notebook.cells[0];

  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.nbformat_minor, 5);
  assert.equal(notebook.cells.length, 1);
  assert.equal(codeCell.cell_type, 'code');
  assert.equal(codeCell.execution_count, null);
  assert.deepEqual(codeCell.outputs, []);
  assert.equal(cellSource(codeCell), 'print("hi")\n');
});

test('notebook.ipynb is generated from notebook.py and is current', () => {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const expected = buildNotebook(source);
  const actual = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));

  assert.deepEqual(actual, expected);
  assert.equal(actual.cells.length, 5);
  assert.equal(actual.cells.filter((cell) => cell.cell_type === 'markdown').length, 1);
  assert.equal(actual.cells.filter((cell) => cell.cell_type === 'code').length, 4);

  const markerCount = source
    .split(/\r?\n/)
    .filter((line) => /^# %%(?!\s*\[markdown\])/.test(line)).length;
  const codeCellCount = actual.cells.filter((cell) => cell.cell_type === 'code').length;

  assert.equal(codeCellCount, markerCount);
  assert.ok(
    actual.cells.every(
      (cell) =>
        !cellSource(cell)
          .split(/\r?\n/)
          .some((line) => line.startsWith('# %%'))
    )
  );
});
