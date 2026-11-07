import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { aspectLabel } from "../cefr";
import type { Lesson, Library, OwnExpression, SavedAdvice } from "../domain";
import { slackShareText } from "../share";
import { clock, span, timedSegments } from "../timestamps";
import { LessonAssessment } from "./assessment";
import { ExpressionForm } from "./expression-form";
import { Growth } from "./growth";
import { TeacherLines } from "./listening";
import { LessonSpeaking } from "./speaking";
import { NativeExamples } from "./youglish";

type ViewLesson = Omit<Lesson, "tracks" | "audio"> & {
  tracks: { id: string; role: string; start: string; chunks: number }[];
  audio?: { seconds: number };
};
type Snapshot = Omit<Library, "lessons"> & {
  lessons: ViewLesson[];
  status: { busy: boolean; message: string; error: string };
  transcription: { queue: string[]; progress: number };
  model: string;
  dataDir: string;
  canSync: boolean;
  automation?: {
    config?: { enabled: boolean; intervalMinutes: number };
    running: boolean;
    nextCheckAt?: string;
    error?: string;
  };
};
const token = location.hash.slice(1) || sessionStorage.getItem("companion-token") || "";
if (token) {
  sessionStorage.setItem("companion-token", token);
  history.replaceState(null, "", location.pathname + location.search);
}
const dateParts = (date: string) => {
  const d = new Date(date);
  return {
    month: d.toLocaleDateString("en-US", { month: "short", timeZone: "Asia/Tokyo" }).toUpperCase(),
    day: d.toLocaleDateString("en-US", { day: "2-digit", timeZone: "Asia/Tokyo" }),
    full: d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Tokyo",
    }),
  };
};
const phaseLabel: Record<Lesson["phase"], string> = {
  idle: "未分析",
  queued: "順番待ち",
  downloading: "音声を準備中",
  listening: "音声を分析中",
  done: "振り返りあり",
  error: "要確認",
};
/** The notebook's shelves: sentences from lessons and the learner, the learner's words, and kept advice. */
const categories = { all: "すべて", sentence: "文章", word: "単語", advice: "アドバイス" } as const;
type Category = keyof typeof categories;
/** Where in a lesson's review a piece of kept advice was given. */
const adviceFrom = (from: SavedAdvice["from"]) =>
  from === "focus" ? "次の一歩" : from === "nextLesson" ? "次のレッスンへ" : `CEFR ${aspectLabel[from]}`;
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "x-companion-token": token, ...options.headers },
  });
  if (response.status === 401) throw new Error("起動時に表示されたURLからページを開き直してください。");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "処理に失敗しました。");
  return result as T;
}
const post = <T,>(path: string, data: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

function App() {
  const [data, setData] = useState<Snapshot>();
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get("lesson") ?? "");
  const [tab, setTab] = useState<"lessons" | "phrases" | "growth">("lessons");
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState("");
  const [showLearned, setShowLearned] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [category, setCategory] = useState<Category>("all");
  // Whether a new expression is being written in the notebook, or jotted down in the sidebar beside
  // whatever is open, and which written one is being rewritten.
  const [writing, setWriting] = useState(false);
  const [jotting, setJotting] = useState(false);
  const [editing, setEditing] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  // One native-example player at a time: which card and which word.
  const [native, setNative] = useState<{ card: string; word: string }>();
  const refresh = useCallback(async () => {
    const snapshot = await api<Snapshot>("/api/library");
    setData(snapshot);
    setSelected(
      (current) =>
        (snapshot.lessons.some((l) => l.id === current) && current) ||
        snapshot.lessons.find((l) => l.feedback)?.id ||
        snapshot.lessons[0]?.id ||
        "",
    );
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e.message)));
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e.message))), 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  async function act(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const lessons = data?.lessons ?? [];
  const own = data?.ownExpressions ?? [];
  const advice = data?.savedAdvice ?? [];
  const lesson = lessons.find((l) => l.id === selected);
  const reviewed =
    lessons.reduce((sum, l) => sum + l.reviewed.length, 0) + own.filter((e) => e.reviewed).length;
  const expressionCount =
    lessons.reduce((sum, l) => sum + (l.feedback?.expressions.length ?? 0), 0) + own.length;
  const favoriteCount =
    lessons.reduce((sum, l) => sum + (l.favorites?.length ?? 0), 0) +
    [...own, ...advice].filter((e) => e.favorite).length;
  const analyzed = lessons.filter((l) => l.feedback).length;
  const busy = Boolean(data?.status.busy);
  const transcribing = lessons.find((l) => l.id === data?.transcription.queue[0]);
  const transcriptAt = lesson ? (data?.transcription.queue.indexOf(lesson.id) ?? -1) : -1;
  const months = [
    ...new Set(
      lessons.map((l) =>
        new Date(l.date).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7),
      ),
    ),
  ]
    .sort()
    .reverse();
  const filtered = lessons.filter(
    (l) =>
      (!month ||
        new Date(l.date).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).startsWith(month)) &&
      `${l.teacher} ${l.topic} ${l.feedback?.title ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const listed = (favorite: boolean, learned: boolean, text: string) =>
    // Favorites stay listed after they are reviewed.
    (favoritesOnly ? favorite : showLearned || !learned) && text.toLowerCase().includes(query.toLowerCase());
  const entries = [
    ...lessons.flatMap((l) =>
      (l.feedback?.expressions ?? []).map((expression, index) => ({
        category: "sentence" as const,
        date: l.date,
        shown: listed(
          Boolean(l.favorites?.includes(index)),
          l.reviewed.includes(index),
          `${expression.original} ${expression.improved} ${expression.meaning}`,
        ),
        card: () => expressionCard(l, index),
      })),
    ),
    ...own.map((e) => ({
      category: e.kind,
      date: e.createdAt,
      shown: listed(e.favorite, e.reviewed, `${e.text} ${e.meaning} ${e.memo}`),
      card: () => ownCard(e),
    })),
    // Advice is not something to say aloud, so it is never marked reviewed.
    ...advice.map((a) => ({
      category: "advice" as const,
      date: a.savedAt,
      shown: listed(a.favorite, false, a.text),
      card: () => adviceCard(a),
    })),
  ];
  const cards = entries
    .filter((e) => e.shown && (category === "all" || e.category === category))
    // What the learner wrote or kept takes its place among the lessons by the date it was written or kept.
    .sort((a, b) => b.date.localeCompare(a.date));
  const teacherLines = lesson?.tracks.some((t) => t.role === "Teacher") && (
    <TeacherLines
      transcript={lesson.teacherTranscript}
      error={lesson.teacherTranscriptError}
      progress={transcriptAt < 0 ? undefined : transcriptAt ? "waiting" : data?.transcription.progress}
      transcribe={() => void act(() => post("/api/transcribe", { ids: [lesson.id] }))}
      load={() => api(`/api/lessons/${lesson.id}/teacher`)}
      play={(at) => play(at)}
    />
  );

  /** Plays from at; with until, plays only that span and pauses at its end. */
  function play(at: number, until?: number) {
    if (!audio.current) return;
    stopAt.current = until ?? null;
    audio.current.currentTime = Math.max(0, at - 1);
    void audio.current.play().catch((e) => setError(e.message));
  }
  /** Renders [m:ss] in feedback prose as a button that plays the selected lesson's recording from there. */
  function timed(l: ViewLesson, text: string) {
    const playable = tab === "lessons" && l.id === lesson?.id && l.audio;
    return timedSegments(text).map((s, i) =>
      "text" in s ? (
        s.text
      ) : playable ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
        <button key={i} className="timestamp inline" type="button" onClick={() => play(s.at, s.until)}>
          ▷ {span(s)}
        </button>
      ) : (
        span(s)
      ),
    );
  }
  function expressionCard(l: ViewLesson, index: number) {
    const expression = l.feedback?.expressions[index];
    if (!expression) return null;
    const learned = l.reviewed.includes(index);
    const favorite = Boolean(l.favorites?.includes(index));
    const card = `${l.id}-${index}`;
    return (
      <article className={`expression ${learned ? "learned" : ""}`} key={card}>
        <div className="expression-top">
          <span className="eyebrow">
            {expression.kind === "correction"
              ? "SAY IT BETTER"
              : expression.kind === "pronunciation"
                ? "SOUND & RHYTHM"
                : expression.kind === "comprehension"
                  ? "DID YOU CATCH THIS?"
                  : "KEEP THIS PHRASE"}
          </span>
          <span className="expression-actions">
            {tab === "lessons" && expression.at !== null ? (
              <button
                className="timestamp"
                type="button"
                onClick={() => {
                  if (expression.at !== null) play(expression.at);
                }}
              >
                ▷ {clock(expression.at)}
              </button>
            ) : tab === "phrases" ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSelected(l.id);
                  setTab("lessons");
                  setQuery("");
                }}
              >
                {l.teacher} · {dateParts(l.date).month} {dateParts(l.date).day} ↗
              </button>
            ) : null}
            {favoriteButton(favorite, () =>
              post(`/api/lessons/${l.id}/favorite`, { index, favorite: !favorite }),
            )}
          </span>
        </div>
        <p className="original">“{expression.original}”</p>
        <div className="rewrite">
          <span aria-hidden="true">↳</span>
          <p>{expression.improved}</p>
        </div>
        {expression.kind === "pronunciation" && expression.words?.length ? (
          <p className="native-examples">
            <span>ネイティブの発音を聞く</span>
            {expression.words.map((word) => (
              <button
                key={word}
                type="button"
                aria-pressed={native?.card === card && native.word === word}
                onClick={() => {
                  audio.current?.pause();
                  setNative({ card, word });
                }}
              >
                ▶ {word}
              </button>
            ))}
          </p>
        ) : null}
        {native?.card === card && <NativeExamples word={native.word} onClose={() => setNative(undefined)} />}
        <p className="meaning">{expression.meaning}</p>
        <p className="explanation">{timed(l, expression.explanation)}</p>
        {expression.confidence !== "high" && (
          <p className="confidence">
            {expression.kind === "comprehension" ? "推測の確信度" : "聞き取りの確信度"}:{" "}
            {expression.confidence === "low" ? "低め・音声で確認" : "中程度"}
          </p>
        )}
        <div className="practice">
          <span>TRY SAYING</span>
          <p>{expression.practice}</p>
        </div>
        {reviewButton(learned, () => post(`/api/lessons/${l.id}/review`, { index, reviewed: !learned }))}
      </article>
    );
  }
  /** A card for an expression the learner wrote; it turns into the form while being rewritten. */
  function ownCard(e: OwnExpression) {
    const change = (fields: Partial<OwnExpression>) => post(`/api/expressions/${e.id}`, fields);
    if (editing === e.id)
      return (
        <ExpressionForm
          key={e.id}
          initial={e}
          save={async (fields) => {
            await change(fields);
            await refresh();
            setEditing("");
          }}
          cancel={() => setEditing("")}
        />
      );
    return (
      <article className={`expression own ${e.reviewed ? "learned" : ""}`} key={e.id}>
        <div className="expression-top">
          <span className="eyebrow">{e.kind === "word" ? "MY WORD" : "MY PHRASE"}</span>
          <span className="expression-actions">
            <button type="button" className="text-button" onClick={() => setEditing(e.id)}>
              編集
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (confirm(`「${e.text}」をノートから削除しますか？`))
                  void act(() => api(`/api/expressions/${e.id}`, { method: "DELETE" }));
              }}
            >
              削除
            </button>
            {favoriteButton(e.favorite, () => change({ favorite: !e.favorite }))}
          </span>
        </div>
        <div className="rewrite">
          <span aria-hidden="true">↳</span>
          <p>{e.text}</p>
        </div>
        {e.meaning && <p className="meaning">{e.meaning}</p>}
        {e.memo && <p className="explanation">{e.memo}</p>}
        {reviewButton(e.reviewed, () => change({ reviewed: !e.reviewed }))}
      </article>
    );
  }
  /** A card for advice kept from a lesson's review, linked back to that lesson. */
  function adviceCard(a: SavedAdvice) {
    const l = lessons.find((x) => x.id === a.lessonId);
    return (
      <article className="expression advice" key={a.id}>
        <div className="expression-top">
          <span className="eyebrow">ADVICE</span>
          <span className="expression-actions">
            {l && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSelected(l.id);
                  setTab("lessons");
                  setQuery("");
                }}
              >
                {l.teacher} · {dateParts(l.date).month} {dateParts(l.date).day} ↗
              </button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (confirm("このアドバイスをノートから削除しますか？"))
                  void act(() => api(`/api/advice/${a.id}`, { method: "DELETE" }));
              }}
            >
              削除
            </button>
            {favoriteButton(a.favorite, () => post(`/api/advice/${a.id}`, { favorite: !a.favorite }))}
          </span>
        </div>
        <p className="advice-text">{l ? timed(l, a.text) : a.text}</p>
        <p className="advice-from">{adviceFrom(a.from)}</p>
      </article>
    );
  }
  /** A star beside a piece of a lesson's advice that keeps it in the phrase notebook, or takes it out. */
  function adviceStar(l: ViewLesson, text: string) {
    const kept = advice.find((a) => a.lessonId === l.id && a.text === text);
    return (
      <button
        className={`favorite-button advice-star ${kept ? "on" : ""}`}
        type="button"
        aria-label="表現ノートに追加"
        aria-pressed={Boolean(kept)}
        title={kept ? "表現ノートから外す" : "表現ノートに追加"}
        onClick={() =>
          void act(() =>
            kept
              ? api(`/api/advice/${kept.id}`, { method: "DELETE" })
              : post("/api/advice", { lessonId: l.id, text }),
          )
        }
      >
        {kept ? "★" : "☆"}
      </button>
    );
  }
  function favoriteButton(favorite: boolean, toggle: () => Promise<unknown>) {
    return (
      <button
        className={`favorite-button ${favorite ? "on" : ""}`}
        type="button"
        aria-label="お気に入り"
        aria-pressed={favorite}
        title={favorite ? "お気に入りから外す" : "お気に入りに追加"}
        onClick={() => void act(toggle)}
      >
        {favorite ? "★" : "☆"}
      </button>
    );
  }
  function reviewButton(learned: boolean, toggle: () => Promise<unknown>) {
    return (
      <button
        className={`review-button ${learned ? "checked" : ""}`}
        type="button"
        aria-pressed={learned}
        onClick={() => void act(toggle)}
      >
        {learned ? "✓ 復習済み" : "○ 声に出して復習した"}
      </button>
    );
  }

  // What an empty notebook says: how this shelf fills up, or that the filters hide what it holds.
  const [emptyTitle, emptyHint] = !entries.some((e) => category === "all" || e.category === category)
    ? category === "word"
      ? ["単語はまだありません。", "「＋ 表現を書く」で「単語」を選んで書くと、ここに集まります。"]
      : category === "advice"
        ? [
            "アドバイスはまだありません。",
            "振り返りの「次の一歩」「次のレッスンに、ひとつ持っていこう。」と、CEFRの目安の「次へ」にある ☆ を押すと、ここに集まります。",
          ]
        : [
            "ここに、あなたの表現が集まります。",
            "レッスンを分析すると、復習したい表現がこのノートに追加されます。「＋ 表現を書く」から自分で書き足すこともできます。",
          ]
    : !favoritesOnly
      ? ["復習する表現はありません。", "復習済みの表示や検索条件を変えてみてください。"]
      : favoriteCount
        ? ["一致するお気に入りはありません。", "検索条件を変えてみてください。"]
        : ["お気に入りの表現はまだありません。", "表現カードの ☆ を押すと、ここに集まります。"];

  return (
    <div className="shell">
      <aside className="sidebar" ref={sidebar}>
        <a className="brand" href={`/${location.search}`} aria-label="DMM Companion ホーム">
          <span className="brand-symbol">
            c<span>°</span>
          </span>
          <span>
            companion<small>FOR YOUR ENGLISH</small>
          </span>
        </a>
        <div className="sidebar-caption">YOUR LEARNING SPACE</div>
        <nav>
          <button
            className={tab === "lessons" ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => {
              setTab("lessons");
              setQuery("");
            }}
          >
            <span>▤</span> レッスンの振り返り <small>{lessons.length}</small>
          </button>
          <button
            className={tab === "phrases" ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => {
              setTab("phrases");
              setQuery("");
            }}
          >
            <span>⌁</span> 表現ノート <small>{expressionCount + advice.length}</small>
          </button>
          <button
            className={tab === "growth" ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => {
              setTab("growth");
              setQuery("");
            }}
          >
            <span>↗</span> 成長の記録 <small>{lessons.filter((l) => l.metrics || l.assessment).length}</small>
          </button>
        </nav>
        <div className="sidebar-write">
          {jotting ? (
            <ExpressionForm
              stayOpen
              save={async (fields) => {
                await post("/api/expressions", fields);
                await refresh();
              }}
              cancel={() => {
                setJotting(false);
                // A short screen scrolled the sidebar to show the form; the brand comes back with it.
                sidebar.current?.scrollTo({ top: 0 });
              }}
            />
          ) : (
            <button type="button" className="write-button" onClick={() => setJotting(true)}>
              <span>＋</span> 表現を書く
            </button>
          )}
        </div>
        {/* The form takes the note's place, so it fits on a laptop screen. */}
        {!jotting && (
          <div className="sidebar-note">
            <span className="small-star">✳</span>
            <p>
              言えなかったことが、
              <br />
              次は、言えることに。
            </p>
            <span>One conversation at a time.</span>
          </div>
        )}
        <div className="sidebar-bottom">
          <span className="local-dot" /> このMacに保存<small>DMM Eikaiwa · Personal companion</small>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span>
            THE CONVERSATION JOURNAL <i>／</i>{" "}
            {tab === "lessons" ? "振り返り" : tab === "phrases" ? "表現ノート" : "成長の記録"}
          </span>
          <div>
            <button type="button" className="text-button" onClick={() => setHelp(!help)}>
              使い方
            </button>
            <button
              type="button"
              className="outline-button"
              disabled={busy}
              onClick={() =>
                void act(() => (data?.canSync ? post("/api/sync", {}) : Promise.resolve(setHelp(true))))
              }
            >
              {data?.canSync ? "↻ 履歴を同期" : "ログイン設定"}
            </button>
          </div>
        </header>
        {help && (
          <div className="help-panel">
            <strong>ターミナルで一度だけログイン設定をします。</strong>
            <p>
              <code>dmm setup</code>{" "}
              を実行し、メールアドレスとパスワードを入力してください。パスワードは画面に表示されません。資格情報をこのMacに保存します。
            </p>
            <p>
              次回からは <code>dmm</code> でこのページが開きます。ログインが切れたときは、もう一度{" "}
              <code>dmm setup</code> を実行してください。
            </p>
            <p>
              保存先: <code>{data?.dataDir}</code>
            </p>
            <p>
              <code>dmm auto enable</code> で自動生成・Mac通知を開始できます。停止は{" "}
              <code>dmm auto disable</code>。
            </p>
            <a href={`/api/export?token=${encodeURIComponent(token)}`} download>
              振り返りをJSONで保存 ↗
            </a>
          </div>
        )}
        {(error || data?.status.error) && (
          <div className="notice error" role="alert">
            {error || data?.status.error}
          </div>
        )}
        <section className="hero">
          <div>
            <div className="eyebrow accent">A SMALL STEP, EVERY DAY</div>
            <h1>
              {tab === "lessons" ? (
                <>
                  会話の、その先へ<span>A little better, every conversation.</span>
                </>
              ) : (
                <>
                  あなたの言葉を、増やそう<span>Words worth keeping.</span>
                </>
              )}
            </h1>
            <p>
              {tab === "lessons"
                ? "あの日の会話を、次の「話せた」につなげる。"
                : "レッスンで出会った表現を、使える英語に。"}
            </p>
          </div>
          <div className="hero-mark" aria-hidden="true">
            <span>talk.</span>
            <span>reflect.</span>
            <span>grow ↗</span>
          </div>
        </section>
        <section className="stats" aria-label="学習の記録">
          <div>
            <span>取り込んだレッスン</span>
            <strong>
              {lessons.length}
              <small>LESSONS</small>
            </strong>
          </div>
          <div>
            <span>振り返りノート</span>
            <strong>
              {analyzed}
              <small>REFLECTIONS</small>
            </strong>
          </div>
          <div>
            <span>これから復習する表現</span>
            <strong>
              {expressionCount - reviewed}
              <small>TO PRACTICE</small>
            </strong>
          </div>
          <div className="stat-progress">
            <span>声に出して復習した表現</span>
            <strong>
              {reviewed}
              <small>REVIEWED</small>
            </strong>
          </div>
        </section>
        {data?.status.busy && (
          <output className="notice progress">
            <span className="pulse" />
            {data.status.message} <small>このページを開いたまま振り返りを待てます</small>
          </output>
        )}
        {transcribing && data && (
          <output className="notice progress">
            <span className="pulse" />
            {transcribing.teacher}先生の発言を書き起こし中（{Math.floor(data.transcription.progress * 100)}%）
            {data.transcription.queue.length > 1 && (
              <small>ほか{data.transcription.queue.length - 1}件が順番待ち</small>
            )}
          </output>
        )}
        {data?.automation?.config?.enabled && (
          <div className="notice">
            自動振り返り ON · {data.automation.config.intervalMinutes}分ごとに新しいレッスンを確認 ·
            完成したらMacに通知
            {data.automation.error && <span role="alert"> · {data.automation.error}</span>}
          </div>
        )}
        {tab === "lessons" ? (
          <>
            <div className="section-heading">
              <h2>
                Lesson journal <span>レッスンの記録</span>
              </h2>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !lessons.some((l) => l.tracks.length && !l.feedback)}
                onClick={() =>
                  void act(() =>
                    post("/api/analyze", {
                      ids: lessons.filter((l) => l.tracks.length && !l.feedback).map((l) => l.id),
                    }),
                  )
                }
              >
                録音のある未分析レッスンを振り返る ↗
              </button>
            </div>
            <div className="coverage">
              <span className={data?.coverage.complete ? "dot complete" : "dot"} />
              {data?.coverage.complete
                ? "全月の履歴を同期済み"
                : `取得範囲: ${data?.coverage.months.map((m) => `${m.slice(0, 4)}/${m.slice(4)}`).join("・") || "未取り込み"}（全履歴は未確認）`}
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => post("/api/sync", { full: true }))}
              >
                全月を同期 ↻
              </button>
            </div>
            <div className="journal">
              <section className="lesson-list" aria-label="レッスン一覧">
                <div className="filters">
                  <input
                    aria-label="レッスンを検索"
                    placeholder="講師・テーマを検索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <select aria-label="月で絞り込み" value={month} onChange={(e) => setMonth(e.target.value)}>
                    <option value="">すべての月</option>
                    {months.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                {filtered.length ? (
                  filtered.map((l) => (
                    <button
                      type="button"
                      key={l.id}
                      className={`lesson-row ${selected === l.id ? "selected" : ""}`}
                      onClick={() => setSelected(l.id)}
                      aria-pressed={selected === l.id}
                    >
                      <span className="lesson-date">
                        <small>{dateParts(l.date).month}</small>
                        <strong>{dateParts(l.date).day}</strong>
                      </span>
                      <span className="lesson-info">
                        <strong>{l.teacher}</strong>
                        <span>{l.feedback?.title || l.topic || "英会話レッスン"}</span>
                        <small className={`badge ${l.feedback ? "ready" : ""}`}>
                          {!l.attended ? "未受講" : l.recordingUnavailable ? "録音なし" : phaseLabel[l.phase]}
                          {!l.feedback && l.tracks.length ? " · 録音あり" : ""}
                        </small>
                      </span>
                      <span className="row-arrow">↗</span>
                    </button>
                  ))
                ) : (
                  <div className="list-empty">
                    {lessons.length
                      ? "一致するレッスンがありません"
                      : "DMMにログインすると、レッスンがここに並びます。"}
                  </div>
                )}
              </section>
              <section className="reflection" aria-label="選択したレッスンの振り返り" key={lesson?.id}>
                {lesson ? (
                  <>
                    <div className="reflection-meta">
                      <span className="eyebrow">YOUR REFLECTION</span>
                      <span>{dateParts(lesson.date).full}</span>
                    </div>
                    <h2>{lesson.feedback?.title || `${lesson.teacher}先生とのレッスン`}</h2>
                    <p className="teacher-line">
                      with <strong>{lesson.teacher}</strong>
                      {lesson.audio && <span> · {clock(lesson.audio.seconds)} の会話</span>}
                      {lesson.feedback && (
                        <>
                          {" · "}
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              navigator.clipboard.writeText(slackShareText(lesson)).then(
                                () => setCopied(lesson.id),
                                (e) => setError(`コピーできませんでした: ${e}`),
                              )
                            }
                          >
                            {copied === lesson.id ? "コピーしました" : "Slack用にコピー"}
                          </button>
                        </>
                      )}
                    </p>
                    {lesson.audio && (
                      <div className="player">
                        <span>LISTEN BACK</span>
                        <audio
                          ref={audio}
                          controls
                          onTimeUpdate={(e) => {
                            if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
                              stopAt.current = null;
                              e.currentTarget.pause();
                            }
                          }}
                          onSeeking={(e) => {
                            // A manual seek outside the requested span ends span playback.
                            if (stopAt.current !== null && e.currentTarget.currentTime > stopAt.current)
                              stopAt.current = null;
                          }}
                          preload="metadata"
                          src={`/api/lessons/${lesson.id}/audio?token=${encodeURIComponent(token)}`}
                        >
                          <track kind="captions" />
                        </audio>
                      </div>
                    )}
                    {(lesson.feedback || lesson.teacherTranscript) && teacherLines}
                    {lesson.feedback ? (
                      <>
                        {lesson.feedback.source === "audio_transcript" && (
                          <p className="analysis-basis">
                            録音の文字起こしから、文法・表現を振り返っています。発音の評価は含みません。
                          </p>
                        )}
                        <p className="summary">{timed(lesson, lesson.feedback.summary)}</p>
                        <div className="feedback-pair">
                          <div>
                            <h3>
                              <span>＋</span> うまくできたこと
                            </h3>
                            <ul>
                              {lesson.feedback.strengths.map((s) => (
                                <li key={s}>{timed(lesson, s)}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <h3>
                              <span>↗</span> 次の一歩
                            </h3>
                            <ul>
                              {lesson.feedback.focus.map((s) => (
                                <li key={s}>
                                  {timed(lesson, s)}
                                  {adviceStar(lesson, s)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                        <div className="expression-title">
                          <h3>次は、こう言ってみよう。</h3>
                          <span>{lesson.feedback.expressions.length} EXPRESSIONS</span>
                        </div>
                        {lesson.feedback.expressions.map((_, i) => expressionCard(lesson, i))}
                        <div className="next-lesson">
                          <span className="eyebrow">TAKE IT TO YOUR NEXT LESSON</span>
                          <h3>次のレッスンに、ひとつ持っていこう。</h3>
                          <ol>
                            {lesson.feedback.nextLesson.map((s) => (
                              <li key={s}>
                                {timed(lesson, s)}
                                {adviceStar(lesson, s)}
                              </li>
                            ))}
                          </ol>
                        </div>
                        <LessonAssessment
                          assessment={lesson.assessment}
                          error={lesson.assessmentError}
                          timed={(text) => timed(lesson, text)}
                          star={(text) => adviceStar(lesson, text)}
                        />
                        <LessonSpeaking
                          metrics={lesson.metrics}
                          error={lesson.metricsError}
                          loadTranscript={() =>
                            api<{ transcript: string; model: string }>(`/api/lessons/${lesson.id}/transcript`)
                          }
                        />
                        <details className="analysis-notes">
                          <summary>分析の補足</summary>
                          <p>{timed(lesson, lesson.feedback.speakerIdentification)}</p>
                          {lesson.feedback.uncertainties.map((s) => (
                            <p key={s}>{timed(lesson, s)}</p>
                          ))}
                          <p>
                            {lesson.model} ·{" "}
                            {lesson.analyzedAt && new Date(lesson.analyzedAt).toLocaleString("ja-JP")}
                          </p>
                        </details>
                      </>
                    ) : (
                      <div className="reflection-empty">
                        <div className="empty-art" aria-hidden="true">
                          “<span>↗</span>
                        </div>
                        <h3>
                          {lesson.attended ? "この会話から、見つけよう。" : "このレッスンは未受講です。"}
                        </h3>
                        <p>
                          {lesson.tracks.length
                            ? "録音を聞いて、あなたのための振り返りノートを作ります。"
                            : "録音を取得して、言えなかった表現や次に使いたいフレーズを見つけます。"}
                        </p>
                        {lesson.error && (
                          <div className="notice error" role="alert">
                            {lesson.error}
                          </div>
                        )}
                        <button
                          type="button"
                          className="primary-button"
                          disabled={
                            !lesson.attended || ["queued", "downloading", "listening"].includes(lesson.phase)
                          }
                          onClick={() => void act(() => post("/api/analyze", { ids: [lesson.id] }))}
                        >
                          {["queued", "downloading", "listening"].includes(lesson.phase)
                            ? phaseLabel[lesson.phase]
                            : "このレッスンを振り返る ↗"}
                        </button>
                        <small>音声の長さに応じて、数分かかります。</small>
                        {!lesson.teacherTranscript && teacherLines}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="reflection-empty">
                    <div className="empty-art">“</div>
                    <h3>あなたの会話が、学びのノートに。</h3>
                    <p>DMMにログインして、これまでのレッスンを振り返りましょう。</p>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() =>
                        void act(() =>
                          data?.canSync ? post("/api/sync", {}) : Promise.resolve(setHelp(true)),
                        )
                      }
                    >
                      ログイン設定
                    </button>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : tab === "growth" ? (
          <Growth
            lessons={lessons}
            onOpen={(id) => {
              setSelected(id);
              setTab("lessons");
              setQuery("");
            }}
          />
        ) : (
          <section className="phrase-section">
            <div className="section-heading">
              <h2>
                Phrase collection <span>{cards.length} expressions</span>
              </h2>
              <div className="phrase-filters">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={favoritesOnly}
                    onChange={(e) => setFavoritesOnly(e.target.checked)}
                  />
                  ★ お気に入りのみ（{favoriteCount}）
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={showLearned || favoritesOnly}
                    disabled={favoritesOnly}
                    onChange={(e) => setShowLearned(e.target.checked)}
                  />
                  復習済みも表示
                </label>
              </div>
            </div>
            <div className="phrase-categories">
              {(Object.keys(categories) as Category[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  className="category-chip"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {categories[c]}
                  <small>
                    {c === "all" ? entries.length : entries.filter((e) => e.category === c).length}
                  </small>
                </button>
              ))}
            </div>
            <div className="phrase-tools">
              <input
                className="phrase-search"
                aria-label="表現を検索"
                placeholder="英語・日本語で表現を検索…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {!writing && (
                <button type="button" className="outline-button" onClick={() => setWriting(true)}>
                  ＋ 表現を書く
                </button>
              )}
            </div>
            <div className="phrase-grid">
              {writing && (
                <ExpressionForm
                  kind={category === "word" ? "word" : undefined}
                  save={async (fields) => {
                    await post("/api/expressions", fields);
                    await refresh();
                    setWriting(false);
                  }}
                  cancel={() => setWriting(false)}
                />
              )}
              {cards.map(({ card }) => card())}
            </div>
            {!cards.length && !writing && (
              <div className="reflection-empty">
                <h3>{emptyTitle}</h3>
                <p>{emptyHint}</p>
              </div>
            )}
          </section>
        )}
        <footer>
          Keep talking. Keep growing.<span>Made for your next conversation.</span>
        </footer>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");
createRoot(root).render(<App />);
