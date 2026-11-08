import { expect, test } from "bun:test";
import { teacherLines } from "../src/teacher-transcript";

const heardThroughout = [{ start: 0, end: 1000 }];
/** Words one after another without pauses, from `start`, a quarter second each. */
const spoken = (text: string, start: number) =>
  text.split(" ").map((word, i) => ({ word, start: start + i * 0.25, end: start + (i + 1) * 0.25 }));

test("文の終わりで行を区切り、短い文は間があっても1行にする", () => {
  expect(
    teacherLines(
      {
        words: [
          { word: "Hello!", start: 3.2, end: 3.6 },
          ...spoken("You said you would like to do self-introductions.", 4),
          { word: "I", start: 105.5, end: 105.9 },
          ...spoken("am 35 years old.", 107.4),
        ],
      },
      heardThroughout,
    ),
  ).toEqual([
    { at: 3.2, text: "Hello!" },
    { at: 4, text: "You said you would like to do self-introductions." },
    { at: 105.5, text: "I am 35 years old." },
  ]);
});

test("20語を超える文は、4語以上の行になるよう最も長い間で分け、読点の後を優先する", () => {
  const words = spoken("one two three four five six seven eight nine ten", 0);
  const rest = spoken(
    "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
    3.7,
  );
  const lines = teacherLines(
    { words: [...words, ...rest, ...spoken("more words here", 6.2)] },
    heardThroughout,
  );
  expect(lines).toEqual([
    { at: 0, text: "one two three four five six seven eight nine ten" },
    {
      at: 3.7,
      text: "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty more words here",
    },
  ]);
  const listed = teacherLines(
    {
      words: [
        ...spoken("a b c d e f", 0),
        ...spoken("g h i j k,", 1.9),
        ...spoken("l m n o p q r s t u v.", 3.2),
      ],
    },
    heardThroughout,
  );
  expect(listed.map((l) => l.text)).toEqual(["a b c d e f g h i j k,", "l m n o p q r s t u v."]);
});

test("行の時刻は、録音に音がある最初の語の時刻にする", () => {
  expect(
    teacherLines(
      {
        words: [
          ...spoken("Are you first?", 31.8),
          { word: "Of", start: 33.83, end: 34.29 },
          { word: "course.", start: 83.54, end: 83.76 },
        ],
      },
      [
        { start: 31.76, end: 33.61 },
        { start: 83.36, end: 84.02 },
      ],
    ),
  ).toEqual([
    { at: 31.8, text: "Are you first?" },
    { at: 83.54, text: "Of course." },
  ]);
});

test("録音が無音の区間に書かれた語は使わず、音の前後0.5秒までの語は残す", () => {
  expect(
    teacherLines(
      {
        words: [
          { word: "Okay,", start: 1.1, end: 1.9 },
          { word: "right.", start: 2.3, end: 2.45 },
          { word: "Thank", start: 10, end: 10.3 },
          { word: "you.", start: 10.3, end: 10.5 },
          { word: "Great.", start: 20.2, end: 20.6 },
        ],
      },
      [
        { start: 1, end: 2 },
        { start: 20, end: 21 },
      ],
    ),
  ).toEqual([
    { at: 1.1, text: "Okay, right." },
    { at: 20.2, text: "Great." },
  ]);
});

test("書き起こせた語がなければ失敗し、単語の時刻がない回答も受け付けない", () => {
  expect(() => teacherLines({ words: [] }, heardThroughout)).toThrow("書き起こせません");
  expect(() =>
    teacherLines({ words: [{ word: "Hi.", start: 50, end: 51 }] }, [{ start: 0, end: 1 }]),
  ).toThrow("書き起こせません");
  expect(() => teacherLines({ text: "Hi." }, heardThroughout)).toThrow("単語ごとの時刻");
  expect(() => teacherLines({ words: [{ word: "Hi", start: -1, end: 0 }] }, heardThroughout)).toThrow(
    "単語ごとの時刻",
  );
});
