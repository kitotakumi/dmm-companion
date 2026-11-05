import { expect, test } from "bun:test";
import { teacherLines, whisperProgress } from "../src/teacher-transcript";

test("Whisperの出力から、話した順の行と話し始めの時刻を取り出す", () => {
  expect(
    teacherLines({
      model: "large-v3-turbo",
      tracks: [{ speaker: "Teacher", file: "teacher.mp3", seconds: 60, speech: 30 }],
      lines: [
        { speaker: "Teacher", start: 3.2, end: 4.1, text: " Hello! ", words: [[3.2, 4.1, "Hello!"]] },
        { speaker: "Teacher", start: 6.4, end: 9, text: "How are you today?", words: [] },
      ],
    }),
  ).toEqual({
    model: "large-v3-turbo",
    lines: [
      { at: 3.2, text: "Hello!" },
      { at: 6.4, text: "How are you today?" },
    ],
  });
});

test("空の行は使わず、行がなければ失敗する", () => {
  expect(
    teacherLines({
      model: "large-v3-turbo",
      lines: [
        { start: 1, text: "  " },
        { start: 2, text: "Yes." },
      ],
    }).lines,
  ).toEqual([{ at: 2, text: "Yes." }]);
  expect(() => teacherLines({ model: "large-v3-turbo", lines: [{ start: 1, text: " " }] })).toThrow(
    "書き起こせません",
  );
  expect(() => teacherLines({ model: "large-v3-turbo", lines: [{ start: -1, text: "x" }] })).toThrow();
});

test("進み具合の行から、録音のどこまで書き起こしたかを読む", () => {
  expect(whisperProgress("Teacher: 512/1458s")).toBeCloseTo(512 / 1458);
  expect(whisperProgress("Teacher: 1460/1458s")).toBe(1);
  expect(whisperProgress("Teacher: 420 lines from 1458s of audio (884s of speech) in 606s")).toBeUndefined();
  expect(whisperProgress("Installed 24 packages in 2.82s")).toBeUndefined();
});
