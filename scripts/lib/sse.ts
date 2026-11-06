/**
 * Parse a complete Server-Sent Events text into messages (the API check and
 * its tests). Comments (`: ping`) and `retry:` lines are skipped. Pure.
 */
export interface SseMessage {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

export function parseSse(text: string): SseMessage[] {
  const out: SseMessage[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    let any = false;
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else continue;
      any = true;
    }
    if (any && (data.length > 0 || event !== 'message'))
      out.push({ id, event, data: data.join('\n') });
  }
  return out;
}
