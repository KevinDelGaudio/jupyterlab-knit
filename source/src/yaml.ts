import { WIDE_TABLES_FILE } from './filters';

/**
 * Minimal, line-based handling of the YAML header that Quarto reads from the
 * first (raw) cell of a notebook. Only the `format:` key is touched, so
 * comments and every other option are preserved exactly as written.
 */

interface IHeader {
  open: string;
  body: string[];
  rest: string[];
}

interface IFormatBlock {
  key: string;
  lines: string[];
}

interface IFormatSpec {
  index: number; // position of the `format:` line inside the header body
  length: number; // number of body lines covered by the format entry
  scalar: string | null; // `format: html`
  list: string[] | null; // `format: [html, pdf]`
  indent: string; // indentation of the mapping keys
  prefix: string[]; // comment lines before the first mapping key
  blocks: IFormatBlock[]; // `format:\n  html: ...\n  pdf: ...`
}

// LaTeX typesets code and output in verbatim environments that never wrap,
// so long lines run off the page. fvextra makes them wrap: code at spaces,
// or after . [ ( : when a token has none; printed output anywhere.
const PDF_WRAP_HEADER = [
  String.raw`\usepackage{fvextra}`,
  String.raw`\DefineVerbatimEnvironment{Highlighting}{Verbatim}{breaklines,breakafter={.,[(:},breaknonspaceingroup,commandchars=\\\{\}}`,
  String.raw`\RecustomVerbatimEnvironment{verbatim}{Verbatim}{breaklines,breakanywhere}`
];

/**
 * Lines for a new `format:` entry, indented by `indent`. PDF gets the
 * line-wrapping setup; every other format gets default options.
 */
function formatBlock(format: string, indent: string): string[] {
  if (format !== 'pdf') {
    return [`${indent}${format}: default`];
  }
  const step = '  ';
  return [
    `${indent}pdf:`,
    // tables are fitted to the page by a Lua filter kept next to the notebook
    `${indent}${step}filters:`,
    `${indent}${step}${step}- ${WIDE_TABLES_FILE}`,
    `${indent}${step}include-in-header:`,
    `${indent}${step}${step}text: |`,
    ...PDF_WRAP_HEADER.map(line => `${indent}${step}${step}${step}${line}`)
  ];
}

function splitHeader(src: string): IHeader | null {
  const lines = src.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return null;
  }
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') {
      return { open: lines[0], body: lines.slice(1, i), rest: lines.slice(i) };
    }
  }
  return null;
}

function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim();
}

function isMappingKey(line: string, indent: string): boolean {
  if (!line.startsWith(indent)) {
    return false;
  }
  const after = line.slice(indent.length);
  return /^[A-Za-z0-9_-]+\s*:/.test(after);
}

function parseFormat(body: string[]): IFormatSpec | null {
  const index = body.findIndex(line => /^format\s*:/.test(line));
  if (index < 0) {
    return null;
  }

  const spec: IFormatSpec = {
    index,
    length: 1,
    scalar: null,
    list: null,
    indent: '  ',
    prefix: [],
    blocks: []
  };

  const value = stripComment(body[index].replace(/^format\s*:/, ''));
  if (value.startsWith('[') && value.endsWith(']')) {
    spec.list = value
      .slice(1, -1)
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== '');
    return spec;
  }
  if (value !== '') {
    spec.scalar = value;
    return spec;
  }

  // Mapping form: collect the indented lines that follow `format:`
  const nested: string[] = [];
  for (let j = index + 1; j < body.length; j++) {
    const line = body[j];
    if (line.trim() !== '' && !/^\s/.test(line)) {
      break;
    }
    nested.push(line);
  }
  while (nested.length > 0 && nested[nested.length - 1].trim() === '') {
    nested.pop();
  }
  spec.length = 1 + nested.length;

  const firstKey = nested.findIndex(line => /^\s+[A-Za-z0-9_-]+\s*:/.test(line));
  if (firstKey < 0) {
    spec.prefix = nested;
    return spec;
  }
  spec.indent = (nested[firstKey].match(/^\s+/) as RegExpMatchArray)[0];
  spec.prefix = nested.slice(0, firstKey);

  for (const line of nested.slice(firstKey)) {
    if (isMappingKey(line, spec.indent)) {
      const key = (line.slice(spec.indent.length).match(/^[A-Za-z0-9_-]+/) as RegExpMatchArray)[0];
      spec.blocks.push({ key, lines: [line] });
    } else {
      spec.blocks[spec.blocks.length - 1].lines.push(line);
    }
  }
  return spec;
}

/**
 * The format the Knit button renders by default: the first one listed in
 * the header, as in R Markdown. Null when the header does not set one.
 */
export function defaultFormat(src: string): string | null {
  const header = splitHeader(src);
  if (!header) {
    return null;
  }
  const spec = parseFormat(header.body);
  if (!spec) {
    return null;
  }
  if (spec.scalar !== null) {
    return spec.scalar;
  }
  if (spec.list !== null) {
    return spec.list.length > 0 ? spec.list[0] : null;
  }
  return spec.blocks.length > 0 ? spec.blocks[0].key : null;
}

/**
 * Move `format` to the first position of the header's `format:` entry, adding
 * it with default options if absent (what RStudio does to the `output:` field
 * when a format is picked from the Knit menu). Returns the new cell source,
 * or null when nothing needs to change.
 */
export function promoteFormat(src: string, format: string): string | null {
  const header = splitHeader(src);
  if (!header) {
    return null;
  }
  const body = header.body;
  const spec = parseFormat(body);

  let replacement: string[];

  if (!spec) {
    // No format key: Quarto already defaults to HTML
    if (format === 'html') {
      return null;
    }
    const newBody = [...body, 'format:', ...formatBlock(format, '  ')];
    return [header.open, ...newBody, ...header.rest].join('\n');
  }

  if (spec.scalar !== null) {
    if (spec.scalar === format) {
      return null;
    }
    replacement = [
      'format:',
      ...formatBlock(format, '  '),
      ...formatBlock(spec.scalar, '  ')
    ];
  } else if (spec.list !== null) {
    if (spec.list[0] === format) {
      return null;
    }
    if (spec.list.includes(format)) {
      const items = [format, ...spec.list.filter(item => item !== format)];
      replacement = [`format: [${items.join(', ')}]`];
    } else {
      // A new format needs its own options: switch to the mapping form
      replacement = [
        'format:',
        ...formatBlock(format, '  '),
        ...spec.list.flatMap(item => formatBlock(item, '  '))
      ];
    }
  } else {
    if (spec.blocks.length > 0 && spec.blocks[0].key === format) {
      return null;
    }
    const chosen = spec.blocks.find(block => block.key === format) ?? {
      key: format,
      lines: formatBlock(format, spec.indent)
    };
    const others = spec.blocks.filter(block => block.key !== format);
    replacement = [
      body[spec.index],
      ...spec.prefix,
      ...chosen.lines,
      ...others.flatMap(block => block.lines)
    ];
  }

  const newBody = [
    ...body.slice(0, spec.index),
    ...replacement,
    ...body.slice(spec.index + spec.length)
  ];
  return [header.open, ...newBody, ...header.rest].join('\n');
}

/**
 * Source for a new header cell when the notebook has none.
 */
export function newHeader(format: string): string {
  return ['---', 'format:', ...formatBlock(format, '  '), '---'].join('\n');
}
