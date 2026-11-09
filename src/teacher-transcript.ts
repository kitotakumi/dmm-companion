import { z } from "zod";
import { speakerAudio } from "./audio";
import type { Lesson } from "./domain";
import { groqWhisper, readGroqSettings, transcribeWithGroq } from "./groq";
import { type Run, speechRuns } from "./metrics";
import { atomicJson, type Store } from "./store";

/** One stretch of the teacher's speech and the second it starts at on the lesson recording. */
export type TeacherLine = { at: number; text: string };

// Whisper writes in the style of its prompt. Without a punctuated one it can write a whole recording in
// lowercase without punctuation, which leaves no sentence ends to cut lines at.
const style = "Hello! How are you today? I'm good, thanks. Let's get started.";

/**
 * Sound below this level, in dB, is silence. WebRTC noise suppression leaves near-digital silence
 * between the teacher's words, and a softly spoken word stays above it.
 */
const silence = -45;

/**
 * Transcribes the teacher's track with Groq's Whisper for listening review. Whisper times each word on
 * the audio and a line starts at its first word; the track lies on the lesson recording's timeline, so
 * that time seeks the lesson recording directly.
 */
export async function transcribeTeacher(store: Store, lesson: Lesson): Promise<void> {
  const settings = readGroqSettings(store.root);
  if (!settings)
    throw new Error("先生の発言の書き起こしにはGroqのAPIキーが必要です。dmm groqで設定してください。");
  const audio = await speakerAudio(store, lesson, "Teacher");
  const [transcription, heard] = await Promise.all([
    transcribeWithGroq(settings.apiKey, audio, style),
    speechRuns(audio, silence),
  ]);
  // Groq's answer is kept, as the analyses' raw output is, so a surprising transcript can be inspected.
  atomicJson(store.path("work", lesson.id, "teacher.groq.json"), transcription);
  const lines = teacherLines(transcription, heard);
  const transcribedAt = new Date().toISOString();
  atomicJson(store.path("analyses", `${lesson.id}.teacher.json`), {
    model: groqWhisper,
    transcribedAt,
    lines,
  });
  lesson.teacherTranscript = { model: groqWhisper, transcribedAt, lines: lines.length };
  delete lesson.teacherTranscriptError;
  store.save();
}

const time = z.number().finite().nonnegative();
const transcriptionSchema = z.object({
  words: z.array(z.object({ word: z.string(), start: time, end: time })),
});
type Word = z.infer<typeof transcriptionSchema>["words"][number];

/** How far, in seconds, a word may lie outside the sound ffmpeg heard and still be kept, as Whisper times words loosely. */
const loose = 0.5;
/**
 * A line starts at its first word within this many seconds of sound. Whisper can put a sentence's first
 * word in the silence before it, even a minute early.
 */
const close = 0.2;
/** A line holds at most this many words; a longer sentence, or a stretch Whisper wrote without punctuation, is split. */
const longest = 20;
/** Splitting leaves no line shorter than this many words, so that no line is a stray word. */
const shortest = 4;
/** Seconds a pause after a comma counts beyond its length, so that a long sentence splits at its commas first. */
const comma = 0.5;

/**
 * The teacher's lines in Groq's answer: one sentence each, a long one split at its longest pauses. Groq
 * writes each word with the punctuation after it, so a sentence ends at a word ending in ".", "?" or "!".
 * Whisper can write a sentence nobody said into a long silence, so words where `heard` finds no sound are
 * left out.
 */
export function teacherLines(transcription: unknown, heard: Run[]): TeacherLine[] {
  const parsed = transcriptionSchema.safeParse(transcription);
  if (!parsed.success) throw new Error("Groqの回答に単語ごとの時刻がありません。");
  const near = (word: Word, margin: number) =>
    heard.some((run) => word.start < run.end + margin && word.end > run.start - margin);
  const sentences: Word[][] = [[]];
  for (const word of parsed.data.words.filter((w) => near(w, loose))) {
    sentences.at(-1)?.push(word);
    if (/[.?!]$/.test(word.word)) sentences.push([]);
  }
  const lines = sentences.flatMap(split).map((line) => ({
    at: (line.find((w) => near(w, close)) ?? line[0])?.start ?? 0,
    text: line.map((w) => w.word).join(" "),
  }));
  if (!lines.length) throw new Error("講師の発話を書き起こせませんでした。");
  return lines;
}

/** The sentence in lines of at most `longest` words, split where it pauses longest. */
function split(words: Word[]): Word[][] {
  if (words.length <= longest) return words.length ? [words] : [];
  const middle = words.length / 2;
  let at = 0;
  let pause = Number.NEGATIVE_INFINITY;
  for (let i = shortest; i <= words.length - shortest; i++) {
    const before = words[i - 1];
    const after = words[i];
    if (!before || !after) continue;
    const length = after.start - before.end + (/[,;:]$/.test(before.word) ? comma : 0);
    // Between equal pauses, as in speech Whisper times without gaps, the split nearest the middle is taken.
    if (length > pause + 1e-6 || (length > pause - 1e-6 && Math.abs(i - middle) < Math.abs(at - middle))) {
      pause = length;
      at = i;
    }
  }
  return at ? [...split(words.slice(0, at)), ...split(words.slice(at))] : [words];
}
