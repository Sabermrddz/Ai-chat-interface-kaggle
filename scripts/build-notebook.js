'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'kaggle', 'notebook.py');
const OUTPUT_PATH = path.join(ROOT, 'kaggle', 'notebook.ipynb');

const INTRO = `# Kaggle LLM Bridge

This notebook is generated from \`kaggle/notebook.py\`. Edit that file and run
\`npm run build:notebook\` to regenerate this notebook.

Before running:

1. In the Kaggle notebook settings, enable **Internet**.
2. Enable a **GPU** accelerator. A T4 x2 or P100 is enough for the default 3B model.
3. Add Secrets in **Add-ons > Secrets** and attach them to this notebook:
   - \`KAGGLE_BRIDGE_TOKEN\` (required): the same long random value as the website's \`BRIDGE_TOKEN\`.
   - \`HF_TOKEN\` (optional): only needed for gated Hugging Face repositories.
4. In the configuration cell, set \`SITE_URL\` to your deployed website base URL,
   for example \`https://my-chat.onrender.com\` (HTTPS, no trailing slash).
5. Run all cells and leave the final cell running.

The notebook downloads a GGUF model from Hugging Face, serves it through
\`llama-cpp-python\` with an OpenAI-compatible API, exposes it with a Cloudflare
quick tunnel, and sends heartbeats to the website.
`;

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
  const cells = [
    {
      cell_type: 'markdown',
      metadata: {},
      source: withTrailingNewline(INTRO)
    }
  ];

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
