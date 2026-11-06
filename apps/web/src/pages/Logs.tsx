/**
 * The activity log: every recorded run event across tasks, newest first, ten
 * at a time (GET /api/logs, redacted by the server). New events are picked up
 * by polling every few seconds; a single task's page streams live over SSE.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorNotice, JsonBlock, Loading, PageHead, Status } from '../components/ui.tsx';
import { ApiError, getJson } from '../lib/api.ts';
import { utcTime } from '../lib/format.ts';
import { PAGE, canShowLess, mergeEntries, moreAction } from '../lib/logs.ts';
import { SEVERITY_TEXT, STAGE_TEXT, severityTone } from '../lib/runs.ts';
import { stepOf } from '../lib/timeline.ts';
import type { LogEntry, LogsResponse } from '../lib/types.ts';

type Connection = 'loading' | 'live' | 'disconnected' | 'failed';

const POLL_MS = 5_000;

function LogRow({ entry, fresh }: { entry: LogEntry; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const step = stepOf({
    runId: entry.runId,
    seq: entry.seq,
    type: entry.type,
    payload: entry.payload,
    at: entry.at,
  });
  const id = `log-${entry.id}`;
  return (
    <li className={`log log-${entry.severity}${fresh ? ' log-new' : ''}`}>
      <button
        type="button"
        className="log-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <time className="log-time" dateTime={entry.at}>
          {utcTime(entry.at)}
        </time>
        <Status tone={severityTone(entry.severity)}>{SEVERITY_TEXT[entry.severity]}</Status>
        <span className="log-stage">{entry.stage === null ? 'Run' : STAGE_TEXT[entry.stage]}</span>
        <span className="log-title">
          {step.title}
          {step.detail === null ? null : <span className="log-detail"> {step.detail}</span>}
        </span>
        <span className="log-toggle" aria-hidden="true">
          {open ? 'Hide' : 'Details'}
        </span>
      </button>
      {open ? (
        <div className="log-more" id={id}>
          <p className="hint">
            Task <a href={`#/tasks/${entry.runId}`}>{entry.runId}</a>, event {entry.seq + 1} (
            <code>{entry.type}</code>)
          </p>
          <JsonBlock
            value={entry.payload}
            label={`Event ${entry.seq + 1} of task ${entry.runId}`}
          />
        </div>
      ) : null}
    </li>
  );
}

export function LogsPage() {
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [visible, setVisible] = useState(PAGE);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [fetching, setFetching] = useState(false);
  const seen = useRef<number>(-1);
  const [freshFrom, setFreshFrom] = useState<number>(Infinity);
  const loadedOnce = useRef(false);

  const loadNewest = useCallback(async () => {
    try {
      if (!loadedOnce.current) {
        const page = await getJson<LogsResponse>(`/api/logs?limit=${PAGE}`);
        loadedOnce.current = true;
        setEntries(page.entries);
        setNext(page.next);
        setTotal(page.total);
        seen.current = page.entries[0]?.id ?? 0;
      } else {
        // only what is newer than the newest entry on screen
        const page = await getJson<LogsResponse>(`/api/logs?limit=100&after=${seen.current}`);
        setTotal(page.total);
        if (page.entries.length > 0) {
          setFreshFrom(seen.current + 1);
          seen.current = page.entries[0]?.id ?? seen.current;
          if (page.next !== null) {
            // more arrived than one poll returns: start again from the newest, no gaps
            setEntries(page.entries);
            setNext(page.next);
            setVisible(PAGE);
          } else {
            setEntries((current) => mergeEntries(current, page.entries));
          }
        }
      }
      setConnection('live');
      setError(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'UNREACHABLE', String(e), null);
      setError(err);
      setConnection(loadedOnce.current ? 'disconnected' : 'failed');
    }
  }, []);

  useEffect(() => {
    void loadNewest();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadNewest();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [loadNewest]);

  const showMore = async () => {
    const action = moreAction({ visible, next }, entries.length);
    if (action === 'reveal') {
      setVisible((v) => v + PAGE);
      return;
    }
    if (action !== 'fetch' || next === null) return;
    setFetching(true);
    try {
      const page = await getJson<LogsResponse>(`/api/logs?limit=${PAGE}&before=${next}`);
      setEntries((current) => mergeEntries(current, page.entries));
      setNext(page.next);
      setVisible((v) => v + PAGE);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setFetching(false);
    }
  };

  const shown = entries.slice(0, visible);
  const more = moreAction({ visible, next }, entries.length);

  return (
    <>
      <PageHead
        title="Activity log"
        intro="Everything the agent did, newest first. Open a line for details."
        aside={
          <span
            className={`stream stream-${connection === 'live' ? 'live' : connection === 'loading' ? 'connecting' : 'reconnecting'}`}
          >
            {connection === 'live'
              ? 'Updating'
              : connection === 'loading'
                ? 'Connecting…'
                : connection === 'disconnected'
                  ? 'Disconnected, retrying'
                  : 'Not loaded'}
          </span>
        }
      />
      {connection === 'failed' && error !== null ? (
        <ErrorNotice
          error={error}
          action={
            <button type="button" className="button-quiet" onClick={() => void loadNewest()}>
              Try again
            </button>
          }
        />
      ) : connection === 'loading' ? (
        <Loading what="the log" />
      ) : entries.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing recorded yet.</p>
          <p>
            <a href="#/new">Start a task</a>; each step it takes appears here.
          </p>
        </div>
      ) : (
        <>
          {connection === 'disconnected' && error !== null ? (
            <p className="stale" role="status">
              Lost contact with the API ({error.message}). Showing what was loaded; retrying every{' '}
              {POLL_MS / 1000} s.
            </p>
          ) : null}
          <ol className="logs" aria-label="Recorded events, newest first">
            {shown.map((e) => (
              <LogRow key={e.id} entry={e} fresh={e.id >= freshFrom} />
            ))}
          </ol>
          <div className="log-paging">
            <span className="hint">
              Showing {shown.length}
              {total === null ? '' : ` of ${total}`}
            </span>
            {more === 'none' ? null : (
              <button
                type="button"
                className="button"
                disabled={fetching}
                onClick={() => void showMore()}
              >
                {fetching ? 'Loading…' : `Show ${PAGE} more`}
              </button>
            )}
            {canShowLess({ visible, next }) ? (
              <button type="button" className="button-quiet" onClick={() => setVisible(PAGE)}>
                Show less
              </button>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
