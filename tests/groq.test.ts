import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGroqSettings, removeGroqKey, saveGroqKey, transcribeWithGroq } from "../src/groq";

const roots: string[] = [];
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "dmm-groq-"));
  roots.push(root);
  return root;
}
/** Answers each request with the next reply, keeping what was asked. */
function groq(...replies: Response[]): { url: string; key: string | null; form?: FormData }[] {
  const asked: { url: string; key: string | null; form?: FormData }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    asked.push({
      url: String(input),
      key: new Headers(init?.headers).get("authorization"),
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    return replies.shift() ?? new Response("no reply", { status: 500 });
  }) as unknown as typeof fetch;
  return asked;
}

test("Groqが受け付けたAPIキーだけを保存し、削除もできる", async () => {
  const root = temporary();
  const asked = groq(Response.json({ error: { message: "Invalid API Key" } }, { status: 401 }));
  await expect(saveGroqKey(root, "gsk_wrong")).rejects.toThrow("受け付けませんでした");
  await expect(saveGroqKey(root, "")).rejects.toThrow("入力してください");
  expect(existsSync(join(root, "groq.json"))).toBe(false);
  expect(asked).toEqual([{ url: "https://api.groq.com/openai/v1/models", key: "Bearer gsk_wrong" }]);

  groq(Response.json({ data: [] }));
  await saveGroqKey(root, "gsk_right");
  expect(readGroqSettings(root)?.apiKey).toBe("gsk_right");
  removeGroqKey(root);
  expect(readGroqSettings(root)).toBeUndefined();
});

test("単語ごとの時刻つきで書き起こしを頼み、すぐ解ける利用上限は待ってから頼み直す", async () => {
  const file = join(temporary(), "teacher.mp3");
  writeFileSync(file, "mp3");
  const asked = groq(
    new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
    Response.json({ words: [] }),
  );
  expect(await transcribeWithGroq("gsk_key", file, "Hello!")).toEqual({ words: [] });
  expect(asked.map((a) => [a.url, a.key])).toEqual([
    ["https://api.groq.com/openai/v1/audio/transcriptions", "Bearer gsk_key"],
    ["https://api.groq.com/openai/v1/audio/transcriptions", "Bearer gsk_key"],
  ]);
  const form = asked[1]?.form;
  expect(form?.get("model")).toBe("whisper-large-v3-turbo");
  expect(form?.get("response_format")).toBe("verbose_json");
  expect(form?.getAll("timestamp_granularities[]")).toEqual(["word"]);
  expect(form?.get("language")).toBe("en");
  expect(form?.get("prompt")).toBe("Hello!");
  // The upload names the file alone, not where it lies on this computer.
  expect(form && (await new Response(form).text())).toContain('filename="teacher.mp3"\r\n');
});

test("キーの誤りと、すぐには解けない利用上限は、何をすればよいかを知らせる", async () => {
  const file = join(temporary(), "teacher.mp3");
  writeFileSync(file, "mp3");
  groq(new Response("{}", { status: 401 }));
  await expect(transcribeWithGroq("gsk_key", file, "")).rejects.toThrow("dmm groqで設定し直して");
  groq(new Response("{}", { status: 429, headers: { "retry-after": "1800" } }));
  await expect(transcribeWithGroq("gsk_key", file, "")).rejects.toThrow("30分ほど待って");
  groq(Response.json({ error: { message: "file must be audio" } }, { status: 400 }));
  await expect(transcribeWithGroq("gsk_key", file, "")).rejects.toThrow("400 file must be audio");
});
