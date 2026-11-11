import { useState } from "react";
import { aspectLabel, aspectMean, cefrScore } from "../cefr";
import type { Lesson } from "../domain";
import {
  cefrLabel,
  judged,
  judgedPeriods,
  type Measure,
  type Measured,
  measures,
  periodSize,
  recent,
  series,
  trend,
} from "../growth-measures";

const day = (date: string) =>
  new Date(date).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });

function Tile({
  lessons,
  measure,
  onOpen,
}: {
  lessons: Measured[];
  measure: Measure;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState<number>();
  const points = series(lessons, measure);
  if (!points.length) return null;
  const { latest, change, improved } = trend(points, measure);
  // Sparkline geometry in viewBox units; times are positioned by date so gaps between lessons show.
  const width = 280;
  const height = 64;
  const pad = 6;
  const times = points.map((p) => Date.parse(p.lesson.date));
  const values = points.flatMap((p) => [p.value, p.average]);
  const [t0, t1] = [Math.min(...times), Math.max(...times)];
  const [v0, v1] = [Math.min(...values), Math.max(...values)];
  const x = (t: number) => (t1 === t0 ? width / 2 : pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad));
  const y = (v: number) =>
    v1 === v0 ? height / 2 : height - pad - ((v - v0) / (v1 - v0)) * (height - 2 * pad);
  const shown = hover === undefined ? undefined : points[hover];
  return (
    <figure className="growth-tile">
      <figcaption>
        <span className="growth-label">{measure.label}</span>
        <span className="growth-value">{measure.format(latest)}</span>
        <span className="growth-change">
          直近{Math.min(recent, points.length)}回の平均
          {change !== undefined && (
            <>
              {" · "}前の{recent}回より{change > 0 ? "+" : ""}
              {(change * 100).toFixed(0)}%{improved ? " ↗ 良くなっています" : ""}
            </>
          )}
        </span>
      </figcaption>
      <div className="growth-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${measure.label}の推移`}>
          <polyline
            className="growth-average"
            points={points.map((p, i) => `${x(times[i] ?? 0)},${y(p.average)}`).join(" ")}
          />
          {points.map((p, i) => (
            <circle
              key={p.lesson.id}
              className={i === hover ? "growth-dot active" : "growth-dot"}
              cx={x(times[i] ?? 0)}
              cy={y(p.value)}
              r={i === hover ? 4.5 : 3}
            />
          ))}
        </svg>
        {points.map((p, i) => (
          // Hit targets wider than the dots, laid over the plot as real buttons.
          <button
            key={p.lesson.id}
            type="button"
            className="growth-hit"
            style={{ left: `${(x(times[i] ?? 0) / width) * 100}%` }}
            aria-label={`${day(p.lesson.date)} ${p.lesson.teacher}: ${measure.format(p.value)}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(undefined)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(undefined)}
            onClick={() => onOpen(p.lesson.id)}
          />
        ))}
        {shown && hover !== undefined && (
          <div className="growth-tooltip" style={{ left: `${(x(times[hover] ?? 0) / width) * 100}%` }}>
            <strong>{measure.format(shown.value)}</strong>
            <span>
              {day(shown.lesson.date)} · {shown.lesson.teacher}
            </span>
            <span>平均 {measure.format(shown.average)}</span>
          </div>
        )}
      </div>
      <p className="growth-note">{measure.note}</p>
    </figure>
  );
}

/** The CEFR estimate per aspect, either averaged over every 10 judged lessons or lesson by lesson, newest first. */
function Periods({ lessons, onOpen }: { lessons: Measured[]; onOpen: (id: string) => void }) {
  const [view, setView] = useState<"periods" | "lessons">("periods");
  const judgements = judged(lessons);
  const periods = judgedPeriods(judgements);
  if (!periods.length) return null;
  const aspects = Object.keys(periods.at(-1)?.aspects ?? {});
  return (
    <div className="growth-periods">
      <div className="growth-periods-heading">
        <h3>
          {view === "periods" ? (
            <>
              {periodSize}回ごとのCEFRの目安 <span>各レッスンの判定を平均したもの</span>
            </>
          ) : (
            <>
              レッスンごとのCEFRの目安 <span>1回ごとの判定。話題で上下します</span>
            </>
          )}
        </h3>
        <fieldset className="growth-switch" aria-label="表示の単位">
          <button type="button" aria-pressed={view === "periods"} onClick={() => setView("periods")}>
            {periodSize}回ごと
          </button>
          <button type="button" aria-pressed={view === "lessons"} onClick={() => setView("lessons")}>
            各レッスン
          </button>
        </fieldset>
      </div>
      <div className="growth-table-wrap">
        <table className="growth-table">
          <thead>
            <tr>
              {view === "periods" ? (
                <>
                  <th>期間</th>
                  <th>回数</th>
                </>
              ) : (
                <>
                  <th>日付</th>
                  <th>講師</th>
                </>
              )}
              <th>総合</th>
              {view === "lessons" && <th>6観点の平均</th>}
              {aspects.map((a) => (
                <th key={a}>{aspectLabel[a] ?? a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view === "periods"
              ? [...periods].reverse().map((p, i, all) => {
                  const previous = all[i + 1];
                  const change = previous ? p.overall - previous.overall : 0;
                  return (
                    <tr key={p.from}>
                      <td>
                        {day(p.from)}〜{day(p.to)}
                      </td>
                      <td>{p.count}</td>
                      <td>
                        {cefrLabel(p.overall)}
                        {Math.abs(change) >= 0.25 && (
                          <span className="growth-delta">{change > 0 ? " ↗" : " ↘"}</span>
                        )}
                      </td>
                      {aspects.map((a) => (
                        <td key={a}>{p.aspects[a] === undefined ? "—" : cefrLabel(p.aspects[a])}</td>
                      ))}
                    </tr>
                  );
                })
              : [...judgements].reverse().map((j) => (
                  <tr key={j.lesson.id} onClick={() => onOpen(j.lesson.id)}>
                    <td>{day(j.lesson.date)}</td>
                    <td>{j.lesson.teacher}</td>
                    <td>{j.overall}</td>
                    <td>{cefrLabel(aspectMean(Object.values(j.aspects)) ?? cefrScore[j.overall])}</td>
                    {aspects.map((a) => (
                      <td key={a}>{j.aspects[a] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Growth({
  lessons,
  onOpen,
}: {
  lessons: Pick<Lesson, "id" | "date" | "teacher" | "metrics" | "metricsError" | "assessment">[];
  onOpen: (id: string) => void;
}) {
  const measured = lessons
    .filter((l) => l.metrics || l.assessment)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const failed = lessons.filter((l) => l.metricsError && !l.metrics).length;
  return (
    <section className="growth">
      <div className="section-heading">
        <h2>
          Your progress <span>話す力の推移 · {measured.length}レッスン</span>
        </h2>
        <span className="growth-legend">
          <i className="dot" /> 各レッスン <i className="line" /> 直近{recent}回の平均
        </span>
      </div>
      {measured.length ? (
        <>
          <div className="growth-grid">
            {measures.map((m) => (
              <Tile key={m.key} lessons={measured} measure={m} onOpen={onOpen} />
            ))}
          </div>
          <Periods lessons={measured} onOpen={onOpen} />
          <p className="growth-caveat">
            話題や教材で1回ごとの値は大きく動きます。平均の線の向きで見てください。点を押すとそのレッスンを開きます。
            {failed ? ` 計測できなかったレッスンが${failed}件あります。` : ""}
          </p>
          <div className="growth-table-wrap">
            <table className="growth-table">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>講師</th>
                  {measures.map((m) => (
                    <th key={m.key}>{m.label}</th>
                  ))}
                  <th>語数</th>
                </tr>
              </thead>
              <tbody>
                {[...measured].reverse().map((l) => (
                  <tr key={l.id} onClick={() => onOpen(l.id)}>
                    <td>{day(l.date)}</td>
                    <td>{l.teacher}</td>
                    {measures.map((m) => {
                      const v = m.value(l);
                      return <td key={m.key}>{v === null ? "—" : m.format(v)}</td>;
                    })}
                    <td>{l.metrics?.words ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="reflection-empty">
          <h3>まだ計測したレッスンがありません。</h3>
          <p>
            振り返りを作ると、あわせて発話量・流暢さ・語彙を計測します。過去のレッスンは{" "}
            <code>dmm measure all</code> で計測できます。
          </p>
        </div>
      )}
    </section>
  );
}
