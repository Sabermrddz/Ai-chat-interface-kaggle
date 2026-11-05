'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'kaggle', 'notebook.py');
const OUTPUT_PATH = path.join(ROOT, 'kaggle', 'notebook.ipynb');

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === '') {
    start += 1;
  }

  while (end > start && lines[end - 1].trim() === '') {
    end -= 1;
  }

  return lines.slice(start, end);
}

function parseBlocks(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const marker = line.match(/^# %%(\s*\[markdown\])?\s*$/);

    if (marker) {
      if (current) {
        blocks.push(current);
      }
      current = { type: marker[1] ? 'markdown' : 'code', lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks
    .map((block) => {
      const contentLines = trimBlankLines(block.lines);

      if (block.type === 'markdown') {
        return {
          type: 'markdown',
          source: contentLines.map((line) => line.replace(/^# ?/, '')).join('\n')
        };
      }

      return { type: 'code', source: contentLines.join('\n') };
    })
    .filter((block) => block.source.trim());
}

function withTrailingNewline(text) {
  if (!text) {
    return '';
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function buildNotebook(source) {
  const blocks = parseBlocks(source);
  const cells = [];

  for (const block of blocks) {
    if (block.type === 'markdown') {
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: withTrailingNewline(block.source)
      });
      continue;
    }

    cells.push({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: withTrailingNewline(block.source)
    });
  }

  return {
    cells,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        name: 'python',
        version: '3.10'
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

function main() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const notebook = buildNotebook(source);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(notebook, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${notebook.cells.length} cells).`);
}

if (require.main === module) {
  main();
}

module.exports = { parseBlocks, buildNotebook };
