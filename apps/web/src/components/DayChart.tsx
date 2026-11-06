/**
 * A small per-day bar chart (D-089) drawn with plain elements and the theme's
 * colour tokens, so all three themes style it. Every bar is a real total from
 * the API; a chart with no activity says so instead of drawing empty bars.
 */
import { dayLabel, share, type DayColumn } from '../lib/activity.ts';

export interface SeriesStyle {
  readonly key: string;
  readonly label: string;
  /** good · warn · bad · proof: the theme's colour tokens. */
  readonly tone: 'good' | 'warn' | 'bad' | 'proof';
}

export function DayChart({
  title,
  columns,
  series,
  format,
  empty,
}: {
  title: string;
  columns: readonly DayColumn[];
  series: readonly SeriesStyle[];
  format: (v: bigint) => string;
  empty: string;
}) {
  const max = columns.reduce((m, c) => (c.total > m ? c.total : m), 0n);
  const sum = columns.reduce((s, c) => s + c.total, 0n);
  const first = columns[0]?.day;
  const last = columns[columns.length - 1]?.day;
  return (
    <figure className="day-chart">
      <figcaption className="day-chart-head">
        <span>{title}</span>
        <span className="day-chart-total">{sum === 0n ? '' : format(sum)}</span>
      </figcaption>
      {sum === 0n ? (
        <p className="hint day-chart-empty">{empty}</p>
      ) : (
        <>
          <ol className="day-chart-bars" aria-label={`${title}, by UTC day`}>
            {columns.map((c) => (
              <li key={c.day} className="day-chart-col">
                <span
                  className="day-chart-stack"
                  style={{ height: `${share(c.total, max)}%` }}
                  title={`${dayLabel(c.day)}: ${format(c.total)}`}
                >
                  {c.segments.map((s) => {
                    const style = series.find((x) => x.key === s.key);
                    return s.value === 0n || style === undefined ? null : (
                      <span
                        key={s.key}
                        className={`day-chart-seg tone-${style.tone}`}
                        style={{ flexGrow: Number(s.value) }}
                      />
                    );
                  })}
                </span>
                <span className="sr-only">
                  {dayLabel(c.day)}: {format(c.total)}
                </span>
              </li>
            ))}
          </ol>
          <div className="day-chart-axis hint" aria-hidden="true">
            <span>{first === undefined ? '' : dayLabel(first)}</span>
            <span>{last === undefined ? '' : `${dayLabel(last)} (UTC)`}</span>
          </div>
          {series.length > 1 ? (
            <ul className="day-chart-legend">
              {series.map((s) => (
                <li key={s.key}>
                  <span className={`day-chart-dot tone-${s.tone}`} aria-hidden="true" />
                  {s.label}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </figure>
  );
}
