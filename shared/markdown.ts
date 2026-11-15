/**
 * The little Markdown the chat's answers are written in, read into a tree.
 *
 * A model's answer comes as Markdown: paragraphs, lists, a table of coins,
 * bold for the number that matters. This reads that much and no more, into
 * plain data the page turns into elements one by one — nothing is ever
 * handed to the browser as HTML, so nothing a model (or a note it quotes)
 * writes can become markup. What it does not know stays as the text it was.
 *
 * It is read on every chunk as an answer streams, so an unfinished answer
 * has to read sensibly too: an unclosed code fence is a code block to the
 * end, and an unclosed `**` is just two asterisks.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "code"; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** One line of a list: how deep it sits, whether its own marker was a number, and what it says. */
export interface ListItem {
  depth: number;
  ordered: boolean;
  c: Inline[];
}

/** A list as it nests: each item with the items indented under it. */
export interface ListNode {
  ordered: boolean;
  c: Inline[];
  children: ListNode[];
}

/** The flat items as a tree, by depth: an item deeper than the one before it belongs to it. */
export function nestList(items: ListItem[]): ListNode[] {
  const root: ListNode[] = [];
  const stack: { depth: number; node: ListNode }[] = [];
  for (const it of items) {
    const node: ListNode = { ordered: it.ordered, c: it.c, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= it.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : root).push(node);
    stack.push({ depth: it.depth, node });
  }
  return root;
}

/** Only a web address is a link; anything else a model writes in that position is shown as its text. */
const SAFE_HREF = /^https?:\/\/[^\s<>"']+$/i;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "bold", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // A single asterisk or underscore opens emphasis only against a word, so "5 * 3" and snake_case stay as written.
    if ((ch === "*" || ch === "_") && s[i + 1] && !/\s/.test(s[i + 1]) && s[i + 1] !== ch && (ch === "*" || i === 0 || /[\s(]/.test(s[i - 1]))) {
      let end = s.indexOf(ch, i + 1);
      while (end > 0 && (s[end + 1] === ch || /\s/.test(s[end - 1]))) end = s.indexOf(ch, end + 1);
      if (end > i + 1 && (ch === "*" || end === s.length - 1 || /[\s.,;:!?)]/.test(s[end + 1]))) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = s.indexOf("](", i + 1);
      const end = close > i ? s.indexOf(")", close + 2) : -1;
      if (end > 0) {
        const href = s.slice(close + 2, end).trim();
        if (SAFE_HREF.test(href)) {
          flush();
          out.push({ t: "link", href, c: parseInline(s.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: Math.min(3, h[1].length) as 1 | 2 | 3, c: parseInline(h[2].replace(/\s+#+\s*$/, "")) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    // A table: a row of cells with a rule of dashes under it.
    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]).map(parseInline));
      i--;
      out.push({ t: "table", head, rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: ListItem[] = [];
      const base = li[1].length;
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) items.push({ depth: Math.min(3, Math.floor(Math.max(0, m[1].length - base) / 2)), ordered: /\d/.test(m[2]), c: parseInline(m[3]) });
        // A line indented under an item carries the item on.
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].c.push({ t: "text", v: ` ${lines[i].trim()}` });
        else break;
        i++;
      }
      i--;
      out.push({ t: "list", ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      out.push({ t: "quote", c: parseInline(body.join("\n")) });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}
