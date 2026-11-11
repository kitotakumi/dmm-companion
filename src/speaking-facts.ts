import type { SpeakingMetrics } from "./domain";

/** A lesson's speaking metrics as label and value, as the page and the exported records show them. */
export function speakingFacts(metrics: SpeakingMetrics): [string, string][] {
  return [
    ["話した割合", `${(metrics.talkShare * 100).toFixed(0)}%`],
    ["1回の発言", `${metrics.meanTurnSeconds.toFixed(1)}秒`],
    ["途切れずに", `${metrics.meanLengthOfRun.toFixed(1)}語`],
    ["速さ", `${metrics.wordsPerMinute.toFixed(0)}語/分`],
    ["語彙の多様さ", metrics.mattr === null ? "—" : metrics.mattr.toFixed(2)],
    ["uh・um", `${metrics.fillersPerMinute.toFixed(1)}回/分`],
  ];
}
