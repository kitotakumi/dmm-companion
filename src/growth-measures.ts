import { aspectMean, type CefrLevel, cefrLevels, cefrPeriods, cefrScore, type Period } from "./cefr";
import type { Lesson, SpeakingMetrics } from "./domain";

/** How the learner's speaking changes across lessons, figured alike for the growth view and the exported records. */
export type Measured = Pick<Lesson, "id" | "date" | "teacher" | "metrics" | "assessment">;

/** Reads a metric off a lesson that has speaking metrics. */
const fromMetrics =
  (read: (m: SpeakingMetrics) => number | null) =>
  (l: Measured): number | null =>
    l.metrics ? read(l.metrics) : null;

/** A CEFR-like score (A2 = 2, B1 = 3, "+" = 0.5) shown as the nearest level with the score, so averages stay comparable. */
export function cefrLabel(score: number): string {
  const nearest = cefrLevels.reduce((best, level) =>
    Math.abs(cefrScore[level] - score) < Math.abs(cefrScore[best] - score) ? level : best,
  );
  return `${nearest} (${score.toFixed(1)})`;
}

/** Lessons swing with the topic, so trends are read from the average of this many recent lessons. */
export const recent = 4;

export type Measure = {
  key: string;
  label: string;
  value: (l: Measured) => number | null;
  format: (v: number) => string;
  better: "higher" | "lower";
  note: string;
};
export const measures: Measure[] = [
  {
    key: "cefr",
    label: "CEFRの目安 (6観点の平均)",
    value: (l) => (l.assessment ? aspectMean(l.assessment.criteria.map((c) => c.level)) : null),
    format: cefrLabel,
    better: "higher",
    note: "録音からGeminiが判定した6観点のレベルを数値 (A2 = 2, B1 = 3, + = 0.5) にして平均した目安",
  },
  {
    key: "share",
    label: "話した割合",
    value: fromMetrics((m) => m.talkShare * 100),
    format: (v) => `${v.toFixed(0)}%`,
    better: "higher",
    note: "あなたと講師が声を出していた時間のうち、あなたの割合",
  },
  {
    key: "turn",
    label: "1回の発言の長さ",
    value: fromMetrics((m) => m.meanTurnSeconds),
    format: (v) => `${v.toFixed(1)}秒`,
    better: "higher",
    note: "講師と交代するまでに話し続けた時間の平均。相づちは数えない",
  },
  {
    key: "run",
    label: "途切れずに言えた語数",
    value: fromMetrics((m) => m.meanLengthOfRun),
    format: (v) => `${v.toFixed(1)}語`,
    better: "higher",
    note: "0.25秒以上の間を空けずに続けて言えた語数の平均 (MLR)。流暢さの代表的な指標",
  },
  {
    key: "rate",
    label: "話す速さ",
    value: fromMetrics((m) => m.wordsPerMinute),
    format: (v) => `${v.toFixed(0)}語/分`,
    better: "higher",
    note: "声を出している時間あたりの語数。uh・umは含めない",
  },
  {
    key: "mattr",
    label: "語彙の多様さ",
    value: fromMetrics((m) => m.mattr),
    format: (v) => v.toFixed(2),
    better: "higher",
    note: "50語ごとの窓で、異なる語の割合を平均した値 (MATTR)。話した量に左右されにくい",
  },
  {
    key: "filler",
    label: "uh・umの頻度",
    value: fromMetrics((m) => m.fillersPerMinute),
    format: (v) => `${v.toFixed(1)}回/分`,
    better: "lower",
    note: "声を出している1分あたりのuh・um・erなど",
  },
];

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

/** Each lesson's value, and the average of the lessons up to and including it. */
export function series(lessons: Measured[], measure: Measure) {
  const points = lessons.flatMap((l) => {
    const v = measure.value(l);
    return v === null ? [] : [{ lesson: l, value: v }];
  });
  return points.map((p, i) => ({
    ...p,
    average: mean(points.slice(Math.max(0, i - recent + 1), i + 1).map((q) => q.value)),
  }));
}

/**
 * The average of the latest `recent` values, and its change from the `recent` before them once there are
 * more than `recent`; `improved` says whether that change is for the better.
 */
export function trend(points: { value: number }[], measure: Measure) {
  const latest = mean(points.slice(-recent).map((p) => p.value));
  const before =
    points.length > recent ? mean(points.slice(-2 * recent, -recent).map((p) => p.value)) : undefined;
  const change = before ? (latest - before) / before : undefined;
  const improved = change !== undefined && (measure.better === "higher" ? change > 0 : change < 0);
  return { latest, change, improved };
}

/** Lessons per period: enough judgements that one lesson's topic does not decide the level. */
export const periodSize = 10;

export type Judged = { lesson: Measured; overall: CefrLevel; aspects: Record<string, CefrLevel> };

/** The judged lessons, oldest first, with their levels per aspect keyed by criterion. */
export function judged(lessons: Measured[]): Judged[] {
  return lessons.flatMap((l) =>
    l.assessment
      ? [
          {
            lesson: l,
            overall: l.assessment.overall.level,
            aspects: Object.fromEntries(l.assessment.criteria.map((c) => [c.criterion, c.level])),
          },
        ]
      : [],
  );
}

/** The judged lessons' CEFR estimates averaged over every `periodSize` of them, oldest period first. */
export function judgedPeriods(judgements: Judged[]): Period[] {
  return cefrPeriods(
    judgements.map((j) => ({ date: j.lesson.date, overall: j.overall, aspects: j.aspects })),
    periodSize,
  );
}
