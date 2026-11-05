import { useState } from "react";
import type { Lesson } from "../domain";
import type { TeacherLine } from "../teacher-transcript";
import { clock } from "../timestamps";

type Loaded = { lines: TeacherLine[]; model: string };

/**
 * The teacher's lines for listening review, loaded when opened; each start time plays the recording from
 * there. Until they exist, a button transcribes the teacher on this computer, apart from the review.
 */
export function TeacherLines({
  transcript,
  error,
  progress,
  transcribe,
  load,
  play,
}: {
  transcript?: Lesson["teacherTranscript"];
  error?: string;
  /** How far the transcript is (0–1), "waiting" behind another lesson's, or undefined when not asked for. */
  progress?: number | "waiting";
  transcribe: () => void;
  load: () => Promise<Loaded>;
  play: (at: number) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState("");
  if (!transcript)
    return (
      <div className="teacher-lines">
        <button
          type="button"
          className="outline-button"
          disabled={progress !== undefined}
          onClick={transcribe}
        >
          {progress === undefined
            ? "先生の発言を時刻つきで書き起こす"
            : progress === "waiting"
              ? "書き起こしの順番待ち"
              : progress > 0
                ? `先生の発言を書き起こし中… ${Math.floor(progress * 100)}%`
                : "書き起こしを準備中…"}
        </button>
        <small>このPCのWhisperで書き起こします。振り返りとは別に進み、数分〜十数分かかります。</small>
        {error && progress === undefined && (
          <p className="speaking-error">先生の発言の書き起こしに失敗しました: {error}</p>
        )}
      </div>
    );
  return (
    <details
      className="teacher-lines"
      onToggle={(e) => {
        if (e.currentTarget.open && !loaded)
          load()
            .then(setLoaded)
            .catch((e: Error) => setFailure(e.message));
      }}
    >
      <summary>先生の発言を読む・聞き直す ({transcript.lines}行)</summary>
      {failure ? (
        <p className="speaking-error">{failure}</p>
      ) : loaded ? (
        <>
          <ol className="transcript teacher-transcript">
            {loaded.lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered
              <li key={i} className="spoken-line">
                <button type="button" className="timestamp" onClick={() => play(line.at)}>
                  ▷ {clock(line.at)}
                </button>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
          <small>
            このPCのWhisper（{loaded.model}
            ）が書き起こした先生の発言です。時刻を押すと、その少し前から再生します。
          </small>
        </>
      ) : (
        <p>読み込み中…</p>
      )}
    </details>
  );
}
