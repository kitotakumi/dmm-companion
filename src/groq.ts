import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { atomicJson } from "./store";

export const groqSettingsSchema = z.object({
  version: z.literal(1),
  apiKey: z.string().min(1),
  savedAt: z.iso.datetime(),
});
export type GroqSettings = z.infer<typeof groqSettingsSchema>;

/** The Whisper model Groq transcribes with: large-v3 made faster by a smaller decoder. */
export const groqWhisper = "whisper-large-v3-turbo";

const api = "https://api.groq.com/openai/v1";
const settingsPath = (root: string) => join(root, "groq.json");

/** Reads the settings on every use, so `dmm groq` takes effect in a running app. */
export function readGroqSettings(root: string): GroqSettings | undefined {
  const path = settingsPath(root);
  return existsSync(path) ? groqSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

/** Asks Groq about the key first, so only a key Groq accepts is saved. */
export async function saveGroqKey(root: string, apiKey: string): Promise<void> {
  if (!apiKey || /\s/.test(apiKey)) throw new Error("GroqのAPIキーを入力してください。");
  const response = await fetch(`${api}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401)
    throw new Error("GroqがこのAPIキーを受け付けませんでした。キーを確かめてください。");
  if (!response.ok) throw new Error(`Groqにキーを確認できませんでした (${response.status})。`);
  atomicJson(settingsPath(root), { version: 1, apiKey, savedAt: new Date().toISOString() });
}

export function removeGroqKey(root: string): void {
  rmSync(settingsPath(root), { force: true });
}

/** How many times a request is sent before its failure is reported. */
const attempts = 3;

/**
 * Transcribes an English recording with Groq's Whisper, timing each word on the recording, and returns
 * Groq's answer. A dropped connection or a failure on Groq's side is retried, and so is a
 * rate limit that lifts within two minutes; a longer one is reported with how long to wait.
 */
export async function transcribeWithGroq(apiKey: string, file: string, prompt: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("file", Bun.file(file), basename(file));
    form.append("model", groqWhisper);
    form.append("language", "en");
    form.append("temperature", "0");
    form.append("prompt", prompt);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    let response: Response;
    try {
      response = await fetch(`${api}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (error) {
      if (attempt >= attempts)
        throw new Error(`Groqに接続できませんでした: ${error instanceof Error ? error.message : error}`);
      await Bun.sleep(attempt * 15_000);
      continue;
    }
    if (response.ok) return response.json();
    const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
    const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 15_000;
    if (attempt < attempts && (response.status >= 500 || (response.status === 429 && wait <= 120_000))) {
      await Bun.sleep(wait);
      continue;
    }
    throw new Error(groqError(response.status, retryAfter, await response.text()));
  }
}

function groqError(status: number, retryAfter: number, body: string): string {
  if (status === 401) return "GroqのAPIキーが無効です。dmm groqで設定し直してください。";
  if (status === 413) return "先生の録音がGroqに送れる大きさを超えています。";
  if (status === 429)
    return Number.isFinite(retryAfter)
      ? `Groqの利用上限に達しました。${Math.ceil(retryAfter / 60)}分ほど待ってから再実行してください。`
      : "Groqの利用上限に達しました。しばらく待ってから再実行してください。";
  let message = body;
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    // not JSON; the body itself is the message
  }
  return `Groqが書き起こしを受け付けませんでした (${status} ${message.slice(0, 200)})。`;
}
