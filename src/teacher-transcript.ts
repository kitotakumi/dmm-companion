import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import script from "../scripts/transcribe-dialogue.py" with { type: "text" };
import { speakerAudio } from "./audio";
import type { Lesson } from "./domain";
import { command } from "./process";
import { atomicJson, type Store } from "./store";

const whisperSchema = z.object({
  model: z.string(),
  lines: z.array(z.object({ start: z.number().finite().nonnegative(), text: z.string() })),
});
/** One stretch of the teacher's speech and the second it starts at on the lesson recording. */
export type TeacherLine = { at: number; text: string };

/**
 * Transcribes the teacher's track on this computer with Whisper (scripts/transcribe-dialogue.py, run by
 * uv) for listening review. Whisper times each word on the audio and a line starts at its first word;
 * the track lies on the lesson recording's timeline, so that time seeks the lesson recording directly.
 * `progress` hears how far through the recording it is, from 0 to 1.
 */
export async function transcribeTeacher(
  store: Store,
  lesson: Lesson,
  progress: (done: number) => void,
): Promise<void> {
  if (!Bun.which("uv"))
    throw new Error(
      "先生の発言の書き起こしにはuvが必要です。https://docs.astral.sh/uv/ の手順でインストールしてください。",
    );
  const audio = await speakerAudio(store, lesson, "Teacher");
  // uv runs a script from a file, so the copy built into this binary is written out first.
  const runner = store.path("work", "transcribe-dialogue.py");
  if (!existsSync(runner) || readFileSync(runner, "utf8") !== script) await Bun.write(runner, script);
  const out = store.path("work", lesson.id, "teacher.whisper.json");
  await command(["uv", "run", "--script", runner, "--track", `Teacher=${audio}`, "--out", out], {
    timeout: 3 * 3600_000,
    onStderr: (line) => {
      const done = whisperProgress(line);
      if (done !== undefined) progress(done);
    },
  });
  const { model, lines } = teacherLines(JSON.parse(await Bun.file(out).text()));
  const transcribedAt = new Date().toISOString();
  atomicJson(store.path("analyses", `${lesson.id}.teacher.json`), { model, transcribedAt, lines });
  lesson.teacherTranscript = { model, transcribedAt, lines: lines.length };
  delete lesson.teacherTranscriptError;
  store.save();
}

/** How far through the recording the script is, from one of its progress lines ("Teacher: 512/1458s"). */
export function whisperProgress(line: string): number | undefined {
  const match = /: (\d+)\/(\d+)s$/.exec(line);
  return match ? Math.min(1, Number(match[1]) / Math.max(1, Number(match[2]))) : undefined;
}

/** The teacher's lines in the script's output, in speaking order, and the Whisper model that heard them. */
export function teacherLines(output: unknown): { model: string; lines: TeacherLine[] } {
  const { model, lines } = whisperSchema.parse(output);
  const spoken = lines.flatMap((l) => (l.text.trim() ? [{ at: l.start, text: l.text.trim() }] : []));
  if (!spoken.length) throw new Error("講師の発話を書き起こせませんでした。");
  return { model, lines: spoken };
}
