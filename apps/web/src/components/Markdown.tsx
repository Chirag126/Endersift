/** Renders the agent's brief from the safe markdown tree: text nodes only, https links only. */
import type { ReactNode } from 'react';
import { parseMarkdown, type Inline } from '../lib/markdown.ts';

function inline(parts: readonly Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'bold':
        return <strong key={i}>{p.v}</strong>;
      case 'code':
        return <code key={i}>{p.v}</code>;
      case 'link':
        return (
          <a key={i} href={p.href} target="_blank" rel="noreferrer noopener">
            {p.v}
          </a>
        );
      default:
        return <span key={i}>{p.v}</span>;
    }
  });
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="brief">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'heading':
            return b.level === 1 ? <h2 key={i}>{inline(b.v)}</h2> : <h3 key={i}>{inline(b.v)}</h3>;
          case 'paragraph':
            return <p key={i}>{inline(b.v)}</p>;
          case 'list':
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={i} className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} scope="col">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>{inline(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
