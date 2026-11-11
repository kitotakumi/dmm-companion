import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { criteria } from "../src/assessment";
import type { Feedback, Lesson, Library } from "../src/domain";
import {
  disableRecords,
  enableRecords,
  lessonMarkdown,
  RecordsSync,
  readRecordsSettings,
  recordFiles,
  syncRecords,
} from "../src/records";
import { atomicJson, Store } from "../src/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "dmm-records-"));
  roots.push(root);
  return root;
}
/** Git runs slowly on Windows, so tests that commit and push get longer than the default 5 seconds. */
const slow = 60_000;
/** Runs git for a test's setup and checks, and returns what it printed. */
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
/** A clone of an empty repository, as a newly created one is cloned, with that repository beside it. */
function clone(): { folder: string; remote: string } {
  const base = temporary();
  const remote = join(base, "remote.git");
  const folder = join(base, "records");
  git("init", "--quiet", "--bare", remote);
  git("clone", "--quiet", remote, folder);
  identify(folder);
  return { folder, remote };
}
/** Lets a test repository commit whatever the user's own git settings are. */
function identify(folder: string): void {
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ] as const)
    git("-C", folder, "config", key, value);
}
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(100);
}

const feedback: Feedback = {
  source: "native_audio",
  title: "Weekend plans",
  summary: "[0:18]で週末の予定を話しました。",
  speakerIdentification: "Identified by the tracks",
  strengths: ["Clear answers"],
  focus: ["Past tense [1:05]", "Ask back"],
  expressions: [
    {
      kind: "correction",
      at: 277,
      original: "I go yesterday",
      improved: "I went yesterday.",
      meaning: "昨日行った",
      explanation: "過去形 [4:37]",
      practice: "I went to the park yesterday.",
      confidence: "medium",
    },
    {
      kind: "pronunciation",
      at: null,
      original: "thirty",
      improved: "thirty",
      meaning: "30",
      explanation: "/θ/が/s/に聞こえる",
      practice: "Thirty-three thin thieves.",
      confidence: "high",
      words: ["thirty"],
    },
  ],
  nextLesson: ["Use the past tense"],
  uncertainties: ["Noise at [2:00]"],
};
function lesson(id: string, date: string, fields: Partial<Lesson> = {}): Lesson {
  return {
    id,
    bookingId: id,
    date,
    teacher: "Tutor",
    topic: "",
    attended: true,
    tracks: [],
    phase: "idle",
    reviewed: [],
    ...fields,
  };
}
function library(lessons: Lesson[], fields: Partial<Library> = {}): Library {
  return {
    version: 1,
    lessons,
    imports: [],
    coverage: { months: [], availableMonths: [], complete: false },
    ...fields,
  };
}

test("レッスンのページは振り返り・CEFR・話し方・書き起こしを画面の順に並べ、ノートに残したものに★を付ける", () => {
  const page = lessonMarkdown(
    lesson("a", "2026-09-12T01:00:00.000Z", {
      audio: { file: "audio/a.mp3", seconds: 1570, origin: "2026-09-12T01:00:00.000Z" },
      feedback,
      favorites: [0],
      reviewed: [0],
      model: "gemini-test",
      analyzedAt: "2026-09-12T02:00:00.000Z",
      assessment: {
        source: "native_audio",
        criteria: [
          {
            criterion: "range",
            evidence: "[3:10]で言い換えた\n・<be used to>を使えた",
            level: "B1",
            nextStep: "理由を足す",
          },
        ],
        overall: { rationale: "おおむねB1", level: "B1" },
        caveats: ["講師が多く話した"],
        model: "gemini-test",
        assessedAt: "2026-09-12T02:10:00.000Z",
      },
      metrics: {
        version: 1,
        learnerSeconds: 300,
        teacherSeconds: 660,
        talkShare: 0.3125,
        turns: 40,
        meanTurnSeconds: 7.5,
        words: 120,
        wordsPerMinute: 98,
        meanLengthOfRun: 5.1,
        fillersPerMinute: 2.3,
        mattr: 0.71,
        measuredAt: "2026-09-12T02:20:00.000Z",
        model: "gemini-low",
      },
    }),
    [
      { id: "s1", lessonId: "a", from: "focus", text: "Past tense [1:05]", savedAt: "", favorite: true },
      { id: "s2", lessonId: "a", from: "range", text: "理由を足す", savedAt: "", favorite: true },
      { id: "s3", lessonId: "other", from: "focus", text: "Ask back", savedAt: "", favorite: true },
    ],
    {
      learner: { model: "gemini-low", transcript: "Hello.\n\nI go yesterday." },
      teacher: { model: "whisper-large-v3-turbo", lines: [{ at: 20.4, text: "So you said" }] },
    },
  );
  expect(page).toStartWith(
    "# Weekend plans\n\n2026年9月12日(土) 10:00（日本時間） · Tutor先生 · 26分10秒の会話\n\n[一覧](../README.md) · [ノート](../notebook.md) · [成長の記録](../growth.md)\n\n文中の 4:37 のような時刻は、録音の先頭からの経過時間です。\n\n0:18で週末",
  );
  expect(page).toContain("## 次の一歩\n\n- Past tense 1:05 ★\n- Ask back\n\n");
  expect(page).toContain(
    "### 1. 昨日行った\n\n言い直し · 4:37 · 聞き取りの確信度: 中程度 · ★ お気に入り · ✓ 復習済み\n\n言い直しの例: I went yesterday.\n\nレッスンでの発話: I go yesterday\n\n過去形 4:37\n\n次はこの文も: I went to the park yesterday.",
  );
  expect(page).toContain(
    "### 2. 30\n\n発音\n\n言い直しの例: thirty\n\nレッスンでの発話: thirty\n\n/θ/が/s/に聞こえる\n\nネイティブの発音: [thirty](https://youglish.com/pronounce/thirty/english/us)",
  );
  expect(page).toContain(
    "## CEFRの目安 B1\n\nおおむねB1\n\n### 表現の幅 B1\n\n根拠: 3:10で言い換えた\n\n・\\<be used to>を使えた\n\n次へ: 理由を足す ★\n\n- 講師が多く話した\n\n25分の会話1回分から gemini-test が判定した目安です。",
  );
  expect(page).toContain("| 話した割合 | 31% |\n| 1回の発言 | 7.5秒 |");
  expect(page).toContain(
    "<details>\n\n<summary>あなたの発話の書き起こし (120語)</summary>\n\nHello.\n\nI go yesterday.\n\ngemini-low が言い淀みも含めて書き起こしたものです。\n\n</details>",
  );
  expect(page).toContain("<summary>先生の発言 (1行)</summary>\n\n- 0:20 So you said\n\n");
  expect(page).toEndWith(
    "## 分析の補足\n\nIdentified by the tracks\n\nNoise at 2:00\n\n振り返りのモデル: gemini-test · 分析した日時: 2026-09-12 11:00（日本時間）\n",
  );
});

test("結果のあるレッスンだけをページにし、一覧とノートから日時の新しい順にリンクする", () => {
  const root = temporary();
  mkdirSync(join(root, "analyses"));
  atomicJson(join(root, "analyses", "b.teacher.json"), {
    model: "whisper-large-v3-turbo",
    transcribedAt: "2026-09-11T12:00:00.000Z",
    lines: [{ at: 1, text: "Hi." }],
  });
  const files = recordFiles(
    root,
    library(
      [
        lesson("c", "2026-09-10T01:00:00.000Z"),
        lesson("a", "2026-09-12T01:00:00.000Z", { feedback, favorites: [1] }),
        lesson("b", "2026-09-11T10:30:00.000Z", {
          teacherTranscript: { model: "whisper-large-v3-turbo", transcribedAt: "", lines: 1 },
        }),
      ],
      {
        ownExpressions: [
          {
            id: "o1",
            kind: "word",
            text: "relieved",
            meaning: "ほっとした",
            memo: "",
            createdAt: "2026-09-13T00:00:00.000Z",
            reviewed: false,
            favorite: true,
          },
        ],
        savedAdvice: [
          {
            id: "s1",
            lessonId: "a",
            from: "nextLesson",
            text: "Use the past tense",
            savedAt: "2026-09-12T03:00:00.000Z",
            favorite: false,
          },
        ],
      },
    ),
  );
  expect([...files.keys()].sort()).toEqual([
    "README.md",
    "growth.md",
    "lessons/2026-09-11-1930.md",
    "lessons/2026-09-12-1000.md",
    "notebook.md",
  ]);
  expect(files.get("README.md")).toContain(
    "| [2026-09-12 10:00](lessons/2026-09-12-1000.md) | Tutor | Weekend plans | — |\n| [2026-09-11 19:30](lessons/2026-09-11-1930.md) | Tutor | — | — |\n",
  );
  expect(files.get("lessons/2026-09-11-1930.md")).toContain("- 0:01 Hi.");
  const notebook = files.get("notebook.md");
  const from = "[2026-09-12 Tutor先生](lessons/2026-09-12-1000.md)";
  expect(notebook).toContain(
    `## 文章\n\n- **I went yesterday.** 昨日行った — ${from}\n- **thirty** 30 ★ — ${from}\n\n`,
  );
  expect(notebook).toContain("## 単語\n\n- **relieved** ほっとした ★ — 自分で書いた表現\n\n");
  expect(notebook).toEndWith(`## アドバイス\n\n- Use the past tense — 次のレッスンへ · ${from}\n`);
});

test("ノートの聞き取りの項目は、先生の発言とその意味に、返し方を添えて書く", () => {
  const listening: Feedback = {
    ...feedback,
    expressions: [
      {
        kind: "comprehension",
        at: 61,
        original: "He's still alive?",
        improved: "No, he passed away.",
        meaning: "彼はまだ生きていますか？",
        explanation: "Yeahとだけ返した",
        practice: "Sorry, could you say that again?",
        confidence: "medium",
      },
    ],
  };
  const files = recordFiles(
    temporary(),
    library([lesson("a", "2026-09-12T01:00:00.000Z", { feedback: listening })]),
  );
  expect(files.get("notebook.md")).toContain(
    "- 聞き取り: 先生の「He's still alive?」（彼はまだ生きていますか？）への返し方 **No, he passed away.** — [2026-09-12 Tutor先生](lessons/2026-09-12-1000.md)",
  );
});

test("成長の記録は画面と同じ計算で、直近4回の平均と前の4回からの変化、CEFRの推移、レッスンごとの値を並べる", () => {
  const measured = [0.2, 0.2, 0.3, 0.3, 0.3, 0.3].map((share, i) =>
    lesson(`m${i}`, `2026-09-0${i + 1}T01:00:00.000Z`, {
      metrics: {
        version: 1,
        learnerSeconds: 300,
        teacherSeconds: 600,
        talkShare: share,
        turns: 30,
        meanTurnSeconds: 5,
        words: 400 + i,
        wordsPerMinute: 100,
        meanLengthOfRun: 4,
        fillersPerMinute: i < 2 ? 2 : 3,
        mattr: null,
        measuredAt: "",
        model: "gemini-low",
      },
      assessment: {
        source: "native_audio",
        criteria: criteria.map((criterion) => ({
          criterion,
          evidence: "e",
          level: i < 2 ? "A2" : "B1",
          nextStep: "n",
        })),
        overall: { rationale: "r", level: i < 2 ? "A2" : "B1" },
        caveats: [],
        model: "gemini-test",
        assessedAt: "",
      },
    }),
  );
  const growth =
    recordFiles(
      temporary(),
      library([...measured, lesson("x", "2026-09-07T01:00:00.000Z", { metricsError: "failed" })]),
    ).get("growth.md") ?? "";
  expect(growth).toContain("計測・判定したレッスンは6件です。");
  expect(growth).toContain("計測できなかったレッスンが1件あります。");
  expect(growth).toContain("| CEFRの目安 (6観点の平均) | B1 (3.0) | +50% 良くなっています |");
  expect(growth).toContain("| 話した割合 | 30% | +50% 良くなっています |");
  expect(growth).toContain("| 1回の発言の長さ | 5.0秒 | 0% |");
  // Fewer uh and um is better, so a rise is not marked as better.
  expect(growth).toContain("| uh・umの頻度 | 3.0回/分 | +50% |");
  expect(growth).not.toMatch(/^\| 語彙の多様さ \|/m);
  expect(growth).toContain("- uh・umの頻度: 声を出している1分あたりのuh・um・erなど。低いほど良い");
  expect(growth).toContain(`| 2026-09-01〜2026-09-06 | 6 | A2+ (2.7) |${" A2+ (2.7) |".repeat(6)}`);
  expect(growth).toContain(
    `| [2026-09-06](lessons/2026-09-06-1000.md) | Tutor | B1 | B1 (3.0) |${" B1 |".repeat(6)}`,
  );
  expect(growth).toContain(
    "| [2026-09-06](lessons/2026-09-06-1000.md) | Tutor | B1 (3.0) | 30% | 5.0秒 | 4.0語 | 100語/分 | — | 3.0回/分 | 405 |",
  );
});

test(
  "書き出した記録だけをcommitしてpushし、変わらなければcommitせず、結果のなくなったページは消す",
  async () => {
    const { folder, remote } = clone();
    const root = temporary();
    const records = library([lesson("a", "2026-09-12T01:00:00.000Z", { feedback })]);
    writeFileSync(join(folder, "notes.txt"), "not a record");
    const pushed = () => git("--git-dir", remote, "ls-tree", "-r", "--name-only", "HEAD").split("\n");

    expect(await syncRecords(root, records, folder)).toBe(true);
    expect(pushed()).toEqual(["README.md", "growth.md", "lessons/2026-09-12-1000.md", "notebook.md"]);
    expect(await syncRecords(root, records, folder)).toBe(false);
    expect(git("--git-dir", remote, "rev-list", "--count", "HEAD")).toBe("1");

    // A file the user staged in the folder stays out of the records' commits.
    writeFileSync(join(folder, "staged.txt"), "staged by hand");
    git("-C", folder, "add", "staged.txt");
    const first = records.lessons[0];
    if (first) delete first.feedback;
    expect(await syncRecords(root, records, folder)).toBe(true);
    expect(pushed()).toEqual(["README.md", "growth.md", "notebook.md"]);
    expect(git("--git-dir", remote, "log", "-1", "--format=%s")).toBe(
      "Update README, 2026-09-12-1000, notebook",
    );
  },
  slow,
);

test(
  "書き出し先は保存先と重ならないリポジトリのいちばん上だけで、公開リポジトリは断り、pushできてから設定を保存する",
  async () => {
    const { folder, remote } = clone();
    const root = temporary();
    const empty = library([]);
    const asked: string[] = [];
    const isPrivate = async (url: string) => {
      asked.push(url);
      return false;
    };
    await expect(enableRecords(root, empty, temporary(), isPrivate)).rejects.toThrow("いちばん上のフォルダ");
    mkdirSync(join(folder, "inner"));
    await expect(enableRecords(root, empty, join(folder, "inner"), isPrivate)).rejects.toThrow(
      "いちばん上のフォルダ",
    );
    await expect(enableRecords(folder, empty, folder, isPrivate)).rejects.toThrow("重ならない");
    const unlinked = temporary();
    git("init", "--quiet", unlinked);
    await expect(enableRecords(root, empty, unlinked, isPrivate)).rejects.toThrow("originがありません");
    // A repository that holds other files, or has no branch checked out, is not one kept for the records.
    const notes = temporary();
    git("init", "--quiet", notes);
    identify(notes);
    writeFileSync(join(notes, "notes.txt"), "mine");
    git("-C", notes, "add", "notes.txt");
    git("-C", notes, "commit", "--quiet", "--message", "notes");
    git("-C", notes, "remote", "add", "origin", remote);
    await expect(enableRecords(root, empty, notes, isPrivate)).rejects.toThrow("記録のためだけのリポジトリ");
    git("-C", notes, "checkout", "--quiet", "--detach");
    await expect(enableRecords(root, empty, notes, isPrivate)).rejects.toThrow("ブランチに切り替えて");
    await expect(enableRecords(root, empty, folder, async () => true)).rejects.toThrow(
      "公開リポジトリには書き出せません",
    );
    await expect(
      enableRecords(root, empty, folder, async () => {
        throw new Error("公開設定を確かめられませんでした");
      }),
    ).rejects.toThrow("確かめられませんでした");
    expect(readRecordsSettings(root)).toBeUndefined();

    expect(await enableRecords(root, empty, folder, isPrivate)).toBe(resolve(folder));
    expect(asked.at(-1)).toBe(remote);
    expect(readRecordsSettings(root)?.folder).toBe(resolve(folder));
    disableRecords(root);
    expect(readRecordsSettings(root)).toBeUndefined();
  },
  slow,
);

test(
  "起動中は、始めたときと保存のたびに少し待ってから書き出す",
  async () => {
    const { folder, remote } = clone();
    const store = new Store(temporary());
    store.library.lessons.push(lesson("a", "2026-09-12T01:00:00.000Z", { feedback }));
    atomicJson(store.path("records.json"), { version: 1, folder, enabledAt: new Date().toISOString() });
    const commits = () => git("--git-dir", remote, "rev-list", "--count", "--all");
    const records = new RecordsSync(store, 50);
    records.start();
    await until(() => commits() === "1");
    expect(commits()).toBe("1");

    const first = store.library.lessons[0];
    if (first) first.favorites = [0];
    store.save();
    store.save();
    await until(() => commits() === "2");
    expect(commits()).toBe("2");
    expect(records.snapshot()).toEqual({ folder, syncedAt: expect.any(String) });
  },
  slow,
);

test(
  "ほかでpushされていても取り込んでから記録をpushし、止められたgitが残したロックは片づける",
  async () => {
    const { folder, remote } = clone();
    const root = temporary();
    const records = library([lesson("a", "2026-09-12T01:00:00.000Z", { feedback })]);
    await syncRecords(root, records, folder);
    // The repository moves on elsewhere: README.md is edited and a file added, as on GitHub.
    const elsewhere = join(temporary(), "elsewhere");
    git("clone", "--quiet", remote, elsewhere);
    identify(elsewhere);
    writeFileSync(join(elsewhere, "README.md"), "edited elsewhere\n");
    writeFileSync(join(elsewhere, "extra.md"), "added elsewhere\n");
    git("-C", elsewhere, "add", "--all");
    git("-C", elsewhere, "commit", "--quiet", "--message", "edit elsewhere");
    git("-C", elsewhere, "push", "--quiet");
    const lock = join(folder, ".git", "index.lock");
    writeFileSync(lock, "");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(lock, hourAgo, hourAgo);

    const first = records.lessons[0];
    if (first) first.favorites = [0];
    expect(await syncRecords(root, records, folder)).toBe(true);
    expect(git("--git-dir", remote, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toContain(
      "extra.md",
    );
    expect(git("--git-dir", remote, "show", "HEAD:README.md")).toBe(
      (recordFiles(root, records).get("README.md") ?? "").trim(),
    );
  },
  slow,
);

test(
  "書き出し先が公開されたら書き出しを止め、records.jsonが読めなくてもページの情報は返す",
  async () => {
    const { folder, remote } = clone();
    const store = new Store(temporary());
    store.library.lessons.push(lesson("a", "2026-09-12T01:00:00.000Z", { feedback }));
    atomicJson(store.path("records.json"), { version: 1, folder, enabledAt: new Date().toISOString() });
    const records = new RecordsSync(store, 50, async () => true);
    await records.sync();
    expect(records.snapshot()?.error).toContain("公開リポジトリになっているため");
    expect(git("--git-dir", remote, "rev-list", "--count", "--all")).toBe("0");
    writeFileSync(store.path("records.json"), "{");
    expect(records.snapshot()?.error).toContain("records.jsonを読めません");
  },
  slow,
);
