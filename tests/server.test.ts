import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../src/coach";
import { serve } from "../src/server";
import { Store } from "../src/store";
import { noSavedLogin } from "./fakes";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("ローカルAPIの認証・Origin検証と音声Range配信", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.saveCredentials({ bearer: "Bearer private-credential" });
  await Bun.write(store.path("audio", "test.mp3"), new Uint8Array([0, 1, 2, 3, 4, 5]));
  store.merge({
    id: "test",
    date: "2026-01-01",
    teacher: "Teacher",
    topic: "",
    attended: true,
    tracks: [],
    phase: "idle",
    reviewed: [],
    audio: { file: "audio/test.mp3", seconds: 1, origin: "2026-01-01" },
  });
  const { server, url } = serve(new Companion(store, "gemini-test", noSavedLogin, "gemini-test"), 0);
  cleanups.push(() => {
    void server.stop(true);
  });
  const base = new URL(url);
  const headers = { "x-companion-token": base.hash.slice(1) };
  expect((await fetch(`${base.origin}/api/library`)).status).toBe(401);
  expect(
    (
      await fetch(`${base.origin}/api/sync`, {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.test" },
      })
    ).status,
  ).toBe(403);
  const library = await fetch(`${base.origin}/api/library`, { headers });
  expect(library.status).toBe(200);
  expect(await library.text()).not.toContain("private-credential");
  const audio = await fetch(`${base.origin}/api/lessons/test/audio`, {
    headers: { ...headers, Range: "bytes=2-4" },
  });
  expect(audio.status).toBe(206);
  expect(audio.headers.get("Content-Range")).toBe("bytes 2-4/6");
  expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([2, 3, 4]);
  expect(
    (await fetch(`${base.origin}/api/lessons/test/audio`, { headers: { ...headers, Range: "bytes=20-30" } }))
      .status,
  ).toBe(416);
  expect((await fetch(`${base.origin}/api/setup`, { method: "POST", headers, body: "{}" })).status).toBe(400);
  expect(statSync(store.path("credentials.json")).mode & 0o777).toBe(0o600);
  expect(statSync(root).mode & 0o777).toBe(0o700);
});

test("表現のお気に入りを登録・解除して保存し、不正な番号は拒否する", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const expression = {
    kind: "expression",
    at: null,
    original: "It is good",
    improved: "It sounds great.",
    meaning: "いいね",
    explanation: "相づち",
    practice: "That sounds great.",
    confidence: "high",
  } as const;
  store.merge({
    id: "test",
    date: "2026-01-01",
    teacher: "Teacher",
    topic: "",
    attended: true,
    tracks: [],
    phase: "done",
    reviewed: [],
    feedback: {
      source: "native_audio",
      title: "Practice",
      summary: "Summary",
      speakerIdentification: "Identified",
      strengths: ["Clear"],
      focus: ["Tense"],
      expressions: [expression, expression],
      nextLesson: ["Practice"],
      uncertainties: [],
    },
  });
  const { server, url } = serve(new Companion(store, "gemini-test", noSavedLogin, "gemini-test"), 0);
  cleanups.push(() => {
    void server.stop(true);
  });
  const base = new URL(url);
  const headers = { "x-companion-token": base.hash.slice(1), "Content-Type": "application/json" };
  const favorite = (body: unknown) =>
    fetch(`${base.origin}/api/lessons/test/favorite`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  expect((await favorite({ index: 1, favorite: true })).status).toBe(200);
  expect((await favorite({ index: 1, favorite: true })).status).toBe(200);
  expect(new Store(root).lesson("test").favorites).toEqual([1]);
  const exported = (await (await fetch(`${base.origin}/api/export`, { headers })).json()) as {
    lessons: { favorites: number[] }[];
  };
  expect(exported.lessons[0]?.favorites).toEqual([1]);

  expect((await favorite({ index: 2, favorite: true })).status).toBe(400);
  expect((await favorite({ index: -1, favorite: true })).status).toBe(400);
  expect((await favorite({ index: 0, favorite: "yes" })).status).toBe(400);
  expect((await favorite({ index: 1, favorite: false })).status).toBe(200);
  expect(new Store(root).lesson("test").favorites).toEqual([]);
});

test("先生の発言の書き起こしは振り返りの途中でも受け付け、1件ずつ進めて失敗を残す", async () => {
  const root = mkdtempSync(join(tmpdir(), "dmm-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const recorded = (id: string) => ({
    id,
    date: "2026-01-01",
    teacher: "Teacher",
    topic: "",
    attended: true,
    tracks: [
      { id: `${id}-teacher`, role: "Teacher" as const, start: "2026-01-01T00:00:00Z", mime: "", chunks: [] },
    ],
    phase: "idle" as const,
    reviewed: [],
    audio: { file: `audio/${id}.mp3`, seconds: 60, origin: "2026-01-01T00:00:00Z" },
  });
  store.merge(recorded("a"));
  store.merge(recorded("b"));
  store.merge({ ...recorded("unrestored"), audio: undefined });
  const finish: (() => void)[] = [];
  const companion = new Companion(
    store,
    "gemini-test",
    noSavedLogin,
    "gemini-test",
    (_, lesson, progress) => {
      progress(0.5);
      return new Promise<void>((resolve, reject) => {
        finish.push(() => {
          if (lesson.id === "b") return reject(new Error("uvが見つかりません。"));
          lesson.teacherTranscript = { model: "large-v3-turbo", transcribedAt: "2026-01-01", lines: 1 };
          resolve();
        });
      });
    },
  );
  const { server, url } = serve(companion, 0);
  cleanups.push(() => {
    void server.stop(true);
  });
  const base = new URL(url);
  const headers = { "x-companion-token": base.hash.slice(1), "Content-Type": "application/json" };
  const transcribe = (ids: unknown) =>
    fetch(`${base.origin}/api/transcribe`, { method: "POST", headers, body: JSON.stringify({ ids }) });
  const transcription = async () =>
    ((await (await fetch(`${base.origin}/api/library`, { headers })).json()) as { transcription: unknown })
      .transcription;
  const settled = async (calls: number) => {
    while (finish.length < calls || (calls === 0 && companion.transcription.queue.length)) await Bun.sleep(5);
  };

  companion.status.busy = true; // a review is being written
  const response = await transcribe(["a", "b", "unrestored"]);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ queued: 2 });
  expect(await transcription()).toEqual({ queue: ["a", "b"], progress: 0.5 });
  expect(finish).toHaveLength(1);
  finish[0]?.();
  await settled(2);
  expect(await transcription()).toEqual({ queue: ["b"], progress: 0.5 });
  finish[1]?.();
  await settled(0);
  expect(store.lesson("a").teacherTranscript?.lines).toBe(1);
  expect(store.lesson("b").teacherTranscriptError).toBe("uvが見つかりません。");

  expect(await (await transcribe(["a"])).json()).toEqual({ queued: 0 });
  expect(await (await transcribe(["b"])).json()).toEqual({ queued: 1 });
  expect(store.lesson("b").teacherTranscriptError).toBeUndefined();
  await settled(3);
  finish[2]?.();
  await settled(0);
  expect((await transcribe("a")).status).toBe(400);
  expect((await transcribe(["../a"])).status).toBe(400);
});
