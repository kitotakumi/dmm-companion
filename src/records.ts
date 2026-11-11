import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { aspectLabel, aspectMean, cefrScore } from "./cefr";
import { expressionMarkdown } from "./delivery";
import { type Feedback, type Lesson, type Library, type SavedAdvice, safeError } from "./domain";
import {
  cefrLabel,
  judged,
  judgedPeriods,
  type Measured,
  measures,
  periodSize,
  recent,
  series,
  trend,
} from "./growth-measures";
import { command } from "./process";
import { speakingFacts } from "./speaking-facts";
import { atomicJson, type Store } from "./store";
import { clock, plainTimes } from "./timestamps";

export const recordsSettingsSchema = z.object({
  version: z.literal(1),
  /** The top of a clone of the repository the records are pushed to. */
  folder: z.string().min(1),
  enabledAt: z.iso.datetime(),
});
export type RecordsSettings = z.infer<typeof recordsSettingsSchema>;

const settingsPath = (root: string) => join(root, "records.json");

/** Reads the settings on every sync, so `dmm records` takes effect in a running app. */
export function readRecordsSettings(root: string): RecordsSettings | undefined {
  const path = settingsPath(root);
  return existsSync(path) ? recordsSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

/** Stops writing the records; the folder and what was pushed stay as they are. */
export function disableRecords(root: string): void {
  rmSync(settingsPath(root), { force: true });
}

/** A time in Japan as the page shows a lesson's, e.g. 2026年11月11日(水) 19:30. */
const longDate = (date: string) =>
  new Date(date).toLocaleString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
/** A time in Japan as 2026-11-11 19:30. Japan keeps no summer time, so it is always UTC+9. */
const shortDate = (date: string) =>
  new Date(Date.parse(date) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
/** Prose with its references to the recording as plain times, since the records cannot play it. */
const prose = (text: string) => plainTimes(text).trim();
/** Prose on one line, for a list item. */
const flat = (text: string) => prose(text).replace(/\s*\n\s*/g, " ");
const cell = (text: string) => flat(text).replaceAll("|", "\\|");
/** A section folded until opened, as GitHub shows <details>; the blank lines keep its Markdown rendered. */
const folded = (summary: string, blocks: string[]) =>
  ["<details>", `<summary>${summary}</summary>`, ...blocks, "</details>"].join("\n\n");

/** What point an expression makes. */
const kindLabel: Record<Feedback["expressions"][number]["kind"], string> = {
  correction: "言い直し",
  expression: "覚えたい表現",
  pronunciation: "発音",
  comprehension: "聞き取り",
};
/** Where in a lesson's review a piece of kept advice was given, as the notebook names it. */
const adviceFrom = (from: SavedAdvice["from"]) =>
  from === "focus" ? "次の一歩" : from === "nextLesson" ? "次のレッスンへ" : `CEFR ${aspectLabel[from]}`;

const learnerSchema = z.object({ model: z.string(), transcript: z.string() });
const teacherSchema = z.object({
  model: z.string(),
  lines: z.array(z.object({ at: z.number(), text: z.string() })),
});
export type Transcripts = {
  learner?: z.infer<typeof learnerSchema>;
  teacher?: z.infer<typeof teacherSchema>;
};

/** A lesson's transcripts as saved in analyses/, leaving out one that is missing or unreadable. */
function transcriptsOf(root: string, lesson: Lesson): Transcripts {
  const read = <S extends z.ZodType>(name: string, schema: S): z.infer<S> | undefined => {
    const path = join(root, "analyses", `${lesson.id}.${name}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return schema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  };
  return { learner: read("learner", learnerSchema), teacher: read("teacher", teacherSchema) };
}

/**
 * One lesson's results in the page's order: the review, the CEFR estimate and how the learner spoke, then
 * both transcripts folded away. Stars mark the expressions and the advice kept in the notebook.
 */
export function lessonMarkdown(lesson: Lesson, saved: SavedAdvice[], transcripts: Transcripts): string {
  const kept = (text: string) => (saved.some((a) => a.lessonId === lesson.id && a.text === text) ? " ★" : "");
  const { feedback, assessment, metrics } = lesson;
  const { learner, teacher } = transcripts;
  const blocks = [
    `# ${flat(feedback?.title || `${lesson.teacher}先生とのレッスン`)}`,
    [
      longDate(lesson.date),
      `${lesson.teacher}先生`,
      ...(lesson.audio ? [`${clock(lesson.audio.seconds)}の会話`] : []),
    ].join(" · "),
    ...(lesson.topic ? [`トピック: ${flat(lesson.topic)}`] : []),
    ...(feedback ? reviewBlocks(lesson, feedback, kept) : []),
    ...(assessment
      ? [
          `## CEFRの目安 ${assessment.overall.level}`,
          prose(assessment.overall.rationale),
          ...assessment.criteria.flatMap((c) => [
            `### ${aspectLabel[c.criterion]} ${c.level}`,
            `根拠: ${prose(c.evidence)}`,
            `次へ: ${prose(c.nextStep)}${kept(c.nextStep)}`,
          ]),
          assessment.caveats.map((c) => `- ${flat(c)}`).join("\n"),
          `25分の会話1回分から ${assessment.model} が判定した目安です。`,
        ]
      : []),
    ...(metrics
      ? [
          "## 話し方",
          [
            "| 項目 | 値 |",
            "| --- | --- |",
            ...speakingFacts(metrics).map(([label, value]) => `| ${label} | ${value} |`),
          ].join("\n"),
        ]
      : []),
    ...(learner
      ? [
          folded(`あなたの発話の書き起こし${metrics ? ` (${metrics.words}語)` : ""}`, [
            ...learner.transcript
              .split(/\n+/)
              .map((line) => line.trim())
              .filter(Boolean),
            `${learner.model} が言い淀みも含めて書き起こしたものです。`,
          ]),
        ]
      : []),
    ...(teacher
      ? [
          folded(`先生の発言 (${teacher.lines.length}行)`, [
            teacher.lines.map((line) => `- ${clock(line.at)} ${flat(line.text)}`).join("\n"),
            `${teacher.model}が書き起こした先生の発言です。`,
          ]),
        ]
      : []),
    ...(feedback
      ? [
          "## 分析の補足",
          prose(feedback.speakerIdentification),
          ...feedback.uncertainties.map(prose),
          [
            lesson.model,
            lesson.analyzedAt &&
              new Date(lesson.analyzedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : []),
  ];
  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}

/** The review as the page lays it out; `kept` marks the advice kept in the notebook. */
function reviewBlocks(lesson: Lesson, feedback: Feedback, kept: (text: string) => string): string[] {
  return [
    ...(feedback.source === "audio_transcript"
      ? ["録音の文字起こしから、文法・表現を振り返っています。発音の評価は含みません。"]
      : []),
    prose(feedback.summary),
    "## うまくできたこと",
    feedback.strengths.map((s) => `- ${flat(s)}`).join("\n"),
    "## 次の一歩",
    feedback.focus.map((s) => `- ${flat(s)}${kept(s)}`).join("\n"),
    "## 次は、こう言ってみよう。",
    ...feedback.expressions.flatMap((e, i) => {
      const [heading = "", ...rest] = expressionMarkdown(
        { ...e, explanation: prose(e.explanation) },
        `### ${i + 1}. ${flat(e.meaning)}`,
      );
      const marks = [
        kindLabel[e.kind],
        ...(e.at === null ? [] : [clock(e.at)]),
        ...(e.confidence === "high"
          ? []
          : [
              `${e.kind === "comprehension" ? "推測の確信度" : "聞き取りの確信度"}: ${e.confidence === "low" ? "低め・音声で確認" : "中程度"}`,
            ]),
        ...(lesson.favorites?.includes(i) ? ["★ お気に入り"] : []),
        ...(lesson.reviewed.includes(i) ? ["✓ 復習済み"] : []),
      ];
      return [heading, marks.join(" · "), ...rest];
    }),
    "## 次のレッスンに、ひとつ持っていこう。",
    feedback.nextLesson.map((s, i) => `${i + 1}. ${flat(s)}${kept(s)}`).join("\n"),
  ];
}

type Page = { lesson: Lesson; file: string };

/** The front page: every lesson with results, newest first, and the way to the notebook. */
function indexMarkdown(pages: Page[]): string {
  const rows = pages.map(
    ({ lesson, file }) =>
      `| [${shortDate(lesson.date)}](${file}) | ${cell(lesson.teacher)} | ${cell(lesson.feedback?.title ?? "—")} | ${lesson.assessment?.overall.level ?? "—"} |`,
  );
  return `${[
    "# DMM英会話の記録",
    "レッスンごとの振り返りと書き起こしです。表現とアドバイスは[ノート](notebook.md)に、話す力の推移は[成長の記録](growth.md)にまとめています。",
    rows.length
      ? ["| 日時 | 先生 | 振り返り | CEFR |", "| --- | --- | --- | --- |", ...rows].join("\n")
      : "まだ振り返りはありません。",
  ].join("\n\n")}\n`;
}

/** The phrase notebook's shelves as the page groups them, newest first, each linked to its lesson. */
function notebookMarkdown(library: Library, files: Map<string, string>): string {
  const lessonLink = (lesson: Lesson) => {
    const name = `${shortDate(lesson.date).slice(0, 10)} ${lesson.teacher}先生`;
    const file = files.get(lesson.id);
    return file ? `[${name}](${file})` : name;
  };
  const marks = (favorite: boolean, reviewed: boolean) => `${favorite ? " ★" : ""}${reviewed ? " ✓" : ""}`;
  const entries: { shelf: "sentence" | "word" | "advice"; date: string; line: string }[] = [
    ...library.lessons.flatMap((l) =>
      (l.feedback?.expressions ?? []).map((e, i) => ({
        shelf: "sentence" as const,
        date: l.date,
        line: `- **${flat(e.improved)}** ${flat(e.meaning)}${marks(Boolean(l.favorites?.includes(i)), l.reviewed.includes(i))} — ${lessonLink(l)}`,
      })),
    ),
    ...(library.ownExpressions ?? []).map((e) => ({
      shelf: e.kind,
      date: e.createdAt,
      line: `- **${flat(e.text)}**${e.meaning ? ` ${flat(e.meaning)}` : ""}${e.memo ? `（${flat(e.memo)}）` : ""}${marks(e.favorite, e.reviewed)} — 自分で書いた表現`,
    })),
    ...(library.savedAdvice ?? []).map((a) => {
      const lesson = library.lessons.find((l) => l.id === a.lessonId);
      return {
        shelf: "advice" as const,
        date: a.savedAt,
        line: `- ${flat(a.text)}${marks(a.favorite, false)} — ${adviceFrom(a.from)}${lesson ? ` · ${lessonLink(lesson)}` : ""}`,
      };
    }),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const shelf = (name: (typeof entries)[number]["shelf"], title: string) => {
    const lines = entries.filter((e) => e.shelf === name).map((e) => e.line);
    return [`## ${title}`, lines.length ? lines.join("\n") : "まだありません。"];
  };
  return `${[
    "# ノート",
    "★はお気に入り、✓は声に出して復習済みです。",
    ...shelf("sentence", "文章"),
    ...shelf("word", "単語"),
    ...shelf("advice", "アドバイス"),
  ].join("\n\n")}\n`;
}

/** A Markdown table from its header and rows. */
const table = (head: string[], rows: string[][]) =>
  [head, head.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");

/**
 * The growth view's figures: each measure's recent average and its change, the CEFR estimate by period
 * and by lesson, and every measured lesson's values, newest first. Each measure is explained with the
 * direction that is better, so the figures read the same away from the page.
 */
function growthMarkdown(library: Library, files: Map<string, string>): string {
  const measured = library.lessons
    .filter((l) => l.metrics || l.assessment)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!measured.length) return "# 成長の記録\n\nまだ計測したレッスンがありません。\n";
  const day = (lesson: Measured) => {
    const name = shortDate(lesson.date).slice(0, 10);
    const file = files.get(lesson.id);
    return file ? `[${name}](${file})` : name;
  };
  const trends = measures.flatMap((m) => {
    const points = series(measured, m);
    if (!points.length) return [];
    const { latest, change, improved } = trend(points, m);
    return [
      [
        m.label,
        `${m.format(latest)}${points.length < recent ? ` (${points.length}回)` : ""}`,
        change === undefined
          ? "—"
          : `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}%${improved ? " 良くなっています" : ""}`,
      ],
    ];
  });
  const judgements = judged(measured);
  const periods = judgedPeriods(judgements);
  const aspects = Object.keys(periods.at(-1)?.aspects ?? {});
  const aspectNames = aspects.map((a) => aspectLabel[a] ?? a);
  const failed = library.lessons.filter((l) => l.metricsError && !l.metrics).length;
  return `${[
    "# 成長の記録",
    `話す力の推移です。計測・判定したレッスンは${measured.length}件です。話題や教材で1回ごとの値は大きく動くので、直近${recent}回の平均で見ます。${failed ? `計測できなかったレッスンが${failed}件あります。` : ""}`,
    "## 直近の平均",
    table(["指標", `直近${recent}回の平均`, `前の${recent}回からの変化`], trends),
    measures
      .map((m) => `- ${m.label}: ${m.note}。${m.better === "higher" ? "高い" : "低い"}ほど良い`)
      .join("\n"),
    ...(periods.length
      ? [
          `## ${periodSize}回ごとのCEFRの目安`,
          "各レッスンの判定を平均したものです。",
          table(
            ["期間", "回数", "総合", ...aspectNames],
            [...periods].reverse().map((p, i, all) => {
              const previous = all[i + 1];
              const change = previous ? p.overall - previous.overall : 0;
              return [
                `${shortDate(p.from).slice(0, 10)}〜${shortDate(p.to).slice(0, 10)}`,
                String(p.count),
                `${cefrLabel(p.overall)}${Math.abs(change) >= 0.25 ? (change > 0 ? " ↗" : " ↘") : ""}`,
                ...aspects.map((a) => (p.aspects[a] === undefined ? "—" : cefrLabel(p.aspects[a]))),
              ];
            }),
          ),
          "## レッスンごとのCEFRの目安",
          "1回ごとの判定です。話題で上下します。",
          table(
            ["日付", "講師", "総合", "6観点の平均", ...aspectNames],
            [...judgements]
              .reverse()
              .map((j) => [
                day(j.lesson),
                cell(j.lesson.teacher),
                j.overall,
                cefrLabel(aspectMean(Object.values(j.aspects)) ?? cefrScore[j.overall]),
                ...aspects.map((a) => j.aspects[a] ?? "—"),
              ]),
          ),
        ]
      : []),
    "## レッスンごとの計測値",
    table(
      ["日付", "講師", ...measures.map((m) => m.label), "語数"],
      [...measured].reverse().map((l) => [
        day(l),
        cell(l.teacher),
        ...measures.map((m) => {
          const v = m.value(l);
          return v === null ? "—" : m.format(v);
        }),
        l.metrics ? String(l.metrics.words) : "—",
      ]),
    ),
  ].join("\n\n")}\n`;
}

/**
 * The records by path within their folder: the front page, the notebook, the growth figures, and a page
 * for each lesson with results, named by when it started.
 */
export function recordFiles(root: string, library: Library): Map<string, string> {
  const pages: Page[] = [];
  for (const lesson of library.lessons
    .filter((l) => l.feedback || l.assessment || l.metrics || l.teacherTranscript)
    .sort((a, b) => b.date.localeCompare(a.date))) {
    const at = `lessons/${shortDate(lesson.date).replace(" ", "-").replace(":", "")}`;
    // Two lessons never start in the same minute, but their pages must stay apart even if they did.
    pages.push({
      lesson,
      file: pages.some((p) => p.file === `${at}.md`) ? `${at}-${lesson.id.slice(0, 8)}.md` : `${at}.md`,
    });
  }
  const files = new Map<string, string>(
    pages.map(({ lesson, file }) => [
      file,
      lessonMarkdown(lesson, library.savedAdvice ?? [], transcriptsOf(root, lesson)),
    ]),
  );
  const fileOf = new Map(pages.map((p) => [p.lesson.id, p.file]));
  files.set("README.md", indexMarkdown(pages));
  files.set("notebook.md", notebookMarkdown(library, fileOf));
  files.set("growth.md", growthMarkdown(library, fileOf));
  return files;
}

/** The records' own paths in their folder; nothing else there is staged. */
const owned = ["README.md", "notebook.md", "growth.md", "lessons"];

/** Git in the records folder. It never waits for a password, since the app runs without a terminal. */
const git = (folder: string, ...args: string[]) =>
  command(["git", "-C", folder, ...args], { env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });

/** Names what a commit changes, e.g. "Update 2026-11-11-1930, README". */
function commitMessage(paths: string[]): string {
  const names = paths.map((p) => p.replace(/^lessons\//, "").replace(/\.md$/, ""));
  return `Update ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

/**
 * Writes the records into their folder, commits what changed and pushes. A page whose lesson no longer
 * has results is removed. A commit left unpushed, as when offline, goes out with the next sync.
 * Returns whether there was anything to commit.
 */
export async function syncRecords(root: string, library: Library, folder: string): Promise<boolean> {
  if (!existsSync(folder)) throw new Error(`記録の書き出し先のフォルダがありません: ${folder}`);
  const files = recordFiles(root, library);
  mkdirSync(join(folder, "lessons"), { recursive: true });
  for (const name of readdirSync(join(folder, "lessons")))
    if (name.endsWith(".md") && !files.has(`lessons/${name}`)) rmSync(join(folder, "lessons", name));
  for (const [path, content] of files) {
    const file = join(folder, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content);
  }
  await git(folder, "add", "--all", "--", ...owned);
  const changed = (await git(folder, "diff", "--cached", "--name-only", "--", ...owned))
    .split(/\r?\n/)
    .filter(Boolean);
  if (changed.length) await git(folder, "commit", "--quiet", "--message", commitMessage(changed));
  // Without an upstream the branch has never been pushed.
  const unpushed = await git(folder, "rev-list", "--count", "@{upstream}..HEAD").then(
    (count) => Number(count.trim()) > 0,
    () => true,
  );
  if (unpushed) await git(folder, "push", "--quiet", "--set-upstream", "origin", "HEAD");
  return changed.length > 0;
}

/** Whether `inner` is `outer` or lies inside it. */
function within(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Whether GitHub shows the folder's repository as public; without gh, or off GitHub, it cannot tell. */
async function publicOnGitHub(folder: string): Promise<boolean> {
  if (!Bun.which("gh")) return false;
  const answer = await command(["gh", "repo", "view", "--json", "isPrivate", "--jq", ".isPrivate"], {
    cwd: folder,
  }).catch(() => "");
  return answer.trim() === "false";
}

/**
 * Starts writing the records into `folder`, the top of a clone of the repository they go to, kept apart
 * from the data. The settings are saved only once a first sync has pushed. A repository GitHub shows as
 * public is refused, since the records hold the teacher's words and what the learner said.
 */
export async function enableRecords(
  root: string,
  library: Library,
  folder: string,
  isPublic = publicOnGitHub,
): Promise<string> {
  const target = resolve(folder);
  const top = existsSync(target) ? await git(target, "rev-parse", "--show-toplevel").catch(() => "") : "";
  if (!top.trim() || relative(resolve(top.trim()), target) !== "")
    throw new Error("書き出し先には、Gitリポジトリのいちばん上のフォルダを指定してください。");
  if (within(target, resolve(root)) || within(resolve(root), target))
    throw new Error("書き出し先は、dmmの保存先と重ならないフォルダにしてください。");
  if (!(await git(target, "remote")).split(/\r?\n/).includes("origin"))
    throw new Error(
      "書き出し先のリポジトリにoriginがありません。push先のリポジトリをoriginに設定してください。",
    );
  if (await isPublic(target))
    throw new Error(
      "公開リポジトリには書き出せません。先生の発言も入るので、非公開のリポジトリを指定してください。",
    );
  await syncRecords(root, library, target);
  atomicJson(settingsPath(root), { version: 1, folder: target, enabledAt: new Date().toISOString() });
  return target;
}

/** Seconds the records wait after a save, so that a burst of changes goes out in one commit. */
const settle = 30;
/** Minutes before a failed sync is tried again when nothing else is saved. */
const retry = 10;

/**
 * Keeps the records in step with the library while the app runs: each save brings a sync after a short
 * wait, one at a time, and the app's start brings one for what changed while it was closed.
 */
export class RecordsSync {
  private timer?: ReturnType<typeof setTimeout>;
  private syncing: Promise<void> = Promise.resolve();
  private state: { syncedAt?: string; error?: string } = {};
  constructor(
    private readonly store: Store,
    private readonly wait = settle * 1000,
  ) {}
  start(): void {
    this.store.onSave(() => this.schedule(this.wait));
    this.schedule(0);
  }
  /** Where the records go and how the last sync went, or undefined while they are off. */
  snapshot() {
    const settings = readRecordsSettings(this.store.root);
    return settings && { folder: settings.folder, ...this.state };
  }
  /** Syncs once any sync already running has finished; a failure is kept for the page and tried again. */
  sync(): Promise<void> {
    const pass = this.syncing.then(async () => {
      try {
        const settings = readRecordsSettings(this.store.root);
        if (!settings) return;
        await syncRecords(this.store.root, this.store.library, settings.folder);
        this.state = { syncedAt: new Date().toISOString() };
      } catch (error) {
        this.state = { ...this.state, error: safeError(error) };
        console.error(`記録の書き出し: ${this.state.error}`);
        this.schedule(retry * 60_000);
      }
    });
    this.syncing = pass;
    return pass;
  }
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delay);
  }
}
