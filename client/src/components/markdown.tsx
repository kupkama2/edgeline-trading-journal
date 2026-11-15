import { memo, useMemo } from "react";
import { nestList, parseMarkdown, type Block, type Inline, type ListNode } from "@shared/markdown";

function Inlines({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case "text":
            return <span key={i}>{x.v}</span>;
          case "bold":
            return (
              <strong key={i} className="font-semibold text-foreground">
                <Inlines c={x.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines c={x.c} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-secondary/70 px-1 py-px font-mono text-[0.9em]">
                {x.v}
              </code>
            );
          case "link":
            return (
              <a key={i} href={x.href} target="_blank" rel="noreferrer noopener" className="underline decoration-dotted underline-offset-2 hover:text-sky-400">
                <Inlines c={x.c} />
              </a>
            );
        }
      })}
    </>
  );
}

/** A list and the lists inside it. Each level is a bullet or a numbered list by its own first item's marker. */
function ListView({ nodes }: { nodes: ListNode[] }) {
  if (!nodes.length) return null;
  const Tag = nodes[0].ordered ? "ol" : "ul";
  return (
    <Tag className={`space-y-1 pl-5 ${nodes[0].ordered ? "list-decimal" : "list-disc"}`}>
      {nodes.map((n, i) => (
        <li key={i} className="leading-relaxed">
          <Inlines c={n.c} />
          {n.children.length > 0 && (
            <div className="mt-1">
              <ListView nodes={n.children} />
            </div>
          )}
        </li>
      ))}
    </Tag>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p":
      return (
        <p className="whitespace-pre-wrap leading-relaxed">
          <Inlines c={b.c} />
        </p>
      );
    case "h":
      return (
        <p className={`font-semibold text-foreground ${b.level === 1 ? "text-base" : "text-sm"}`}>
          <Inlines c={b.c} />
        </p>
      );
    case "list":
      return <ListView nodes={nestList(b.items)} />;
    case "code":
      return <pre className="overflow-x-auto rounded-md border border-border/60 bg-secondary/40 p-2 font-mono text-[11px] leading-relaxed">{b.v}</pre>;
    case "quote":
      return (
        <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3 text-muted-foreground">
          <Inlines c={b.c} />
        </blockquote>
      );
    case "hr":
      return <hr className="border-border/60" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                {b.head.map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-2 py-1 font-medium">
                    <Inlines c={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 align-top font-mono">
                      <Inlines c={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * An answer's Markdown, drawn as elements. Never as HTML: the text is read
 * into a tree (shared/markdown.ts) and each node becomes an element, so
 * whatever the text contains stays text.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="space-y-2 text-sm text-foreground/90">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
});
