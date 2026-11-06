/**
 * A small, safe markdown reader for the agent's brief (the server renders it
 * deterministically: headings, paragraphs, bullet lists, pipe tables, **bold**,
 * `code`, [links](https://…)). It returns a tree that React renders as text
 * nodes, so nothing in a brief can inject HTML. Links must be https. Pure.
 */

export type HeadingLevel = 1 | 2 | 3;

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'bold'; readonly v: string }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'link'; readonly v: string; readonly href: string };

export type Block =
  | { readonly t: 'heading'; readonly level: HeadingLevel; readonly v: Inline[] }
  | { readonly t: 'paragraph'; readonly v: Inline[] }
  | { readonly t: 'list'; readonly items: Inline[][] }
  | { readonly t: 'table'; readonly head: Inline[][]; readonly rows: Inline[][][] };

const headingLevel = (n: number): HeadingLevel => (n <= 1 ? 1 : n === 2 ? 2 : 3);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: text.slice(last, i) });
    if (m[1] !== undefined) out.push({ t: 'bold', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined && m[4] !== undefined) out.push({ t: 'link', v: m[3], href: m[4] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out.map((x) => (x.t === 'text' ? { t: 'text', v: x.v.replace(/\\\|/g, '|') } : x));
}

/** Split a pipe-table row on unescaped pipes. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ t: 'paragraph', v: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h !== null) {
      flush();
      blocks.push({
        t: 'heading',
        level: headingLevel(h[1]?.length ?? 1),
        v: parseInline(h[2] ?? ''),
      });
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? '').map(parseInline));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'list', items });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
