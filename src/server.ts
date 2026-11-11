import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AutomaticReviews } from "./automation";
import type { Companion } from "./coach";
import { type Lesson, type OwnExpression, ownExpressionFields, type SavedAdvice, safeError } from "./domain";
import type { RecordsSync } from "./records";
import index from "./web/index.html";

/** A change to an expression the learner wrote: rewritten fields, or its reviewed and favorite marks. */
const ownExpressionChange = z
  .strictObject({ ...ownExpressionFields.shape, reviewed: z.boolean(), favorite: z.boolean() })
  .partial();
/** Advice to keep in the notebook: the lesson, and the advice as its review words it. */
const adviceToKeep = z.strictObject({ lessonId: z.string(), text: z.string() });
const adviceChange = z.strictObject({ favorite: z.boolean() });

/** The advice a lesson's review gives, with where it gives it. */
function adviceIn(lesson: Lesson): Pick<SavedAdvice, "from" | "text">[] {
  return [
    ...(lesson.feedback?.focus ?? []).map((text) => ({ from: "focus" as const, text })),
    ...(lesson.feedback?.nextLesson ?? []).map((text) => ({ from: "nextLesson" as const, text })),
    ...(lesson.assessment?.criteria ?? []).map((c) => ({ from: c.criterion, text: c.nextStep })),
  ];
}

export function serve(
  companion: Companion,
  port: number,
  automatic?: AutomaticReviews,
  records?: RecordsSync,
) {
  const token = randomBytes(24).toString("hex");
  const store = companion.store;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    maxRequestBodySize: 512 * 1024 * 1024,
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      const supplied = Buffer.from(
        request.headers.get("x-companion-token") ?? url.searchParams.get("token") ?? "",
      );
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
        return new Response("Unauthorized", { status: 401 });
      const origin = request.headers.get("origin");
      if (origin && origin !== server.url.origin) return new Response("Forbidden", { status: 403 });
      try {
        if (url.pathname === "/api/automation/run" && request.method === "POST" && automatic) {
          if (!automatic.snapshot().config?.enabled)
            return Response.json({ error: "先にdmm auto enableを実行してください。" }, { status: 409 });
          if (companion.status.busy || automatic.snapshot().running)
            return Response.json({ error: "現在の処理が終わってから実行してください。" }, { status: 409 });
          void automatic.run(true);
          return Response.json({ ok: true }, { status: 202 });
        }
        if (url.pathname === "/api/library" && request.method === "GET")
          return Response.json(
            {
              ...store.library,
              lessons: store.library.lessons.map((l) => ({
                ...l,
                tracks: l.tracks.map((t) => ({
                  id: t.id,
                  role: t.role,
                  start: t.start,
                  chunks: t.chunks.length,
                })),
                audio: l.audio ? { seconds: l.audio.seconds } : undefined,
              })),
              status: companion.status,
              transcription: companion.transcription,
              model: companion.model,
              dataDir: store.root,
              canSync: Boolean(store.credentials().dmmCookie),
              automation: automatic?.snapshot(),
              records: records?.snapshot(),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        if (url.pathname === "/api/setup" && request.method === "POST") {
          if (companion.status.busy)
            return Response.json({ error: "処理が終わってからログインしてください。" }, { status: 409 });
          const identity = (await request.json()) as { email?: unknown; password?: unknown };
          if (
            typeof identity.email !== "string" ||
            typeof identity.password !== "string" ||
            !identity.email ||
            !identity.password
          )
            return Response.json({ error: "ターミナルで dmm setup を実行してください。" }, { status: 400 });
          void companion.setup({ email: identity.email, password: identity.password });
          return Response.json({ ok: true }, { status: 202 });
        }
        if (url.pathname === "/api/sync" && request.method === "POST") {
          if (companion.status.busy)
            return Response.json({ error: "現在の処理が終わってから同期してください。" }, { status: 409 });
          const body = (await request.json()) as { full?: unknown };
          void companion.sync(body.full === true);
          return Response.json({ ok: true }, { status: 202 });
        }
        const catchUp = /^\/api\/(measure|assess)$/.exec(url.pathname);
        if (catchUp?.[1] && request.method === "POST") {
          if (companion.status.busy)
            return Response.json({ error: "現在の処理が終わってから計測してください。" }, { status: 409 });
          const body = (await request.json()) as { ids?: unknown };
          const ids =
            body.ids === undefined
              ? store.library.lessons.map((l) => l.id)
              : Array.isArray(body.ids) &&
                  body.ids.every((id) => typeof id === "string" && /^[\w-]+$/.test(id))
                ? (body.ids as string[])
                : undefined;
          if (!ids) return Response.json({ error: "idsが不正です。" }, { status: 400 });
          void (catchUp[1] === "measure" ? companion.measureAll(ids) : companion.assessAll(ids)).catch(
            (error) => {
              companion.status.error = safeError(error);
            },
          );
          return Response.json({ ok: true }, { status: 202 });
        }
        // Transcribing runs beside reviews and syncs, so it is accepted while they run.
        if (url.pathname === "/api/transcribe" && request.method === "POST") {
          const body = (await request.json()) as { ids?: unknown };
          if (
            !Array.isArray(body.ids) ||
            !body.ids.every((id) => typeof id === "string" && /^[\w-]+$/.test(id))
          )
            return Response.json({ error: "idsが不正です。" }, { status: 400 });
          return Response.json({ queued: companion.transcribe(body.ids) }, { status: 202 });
        }
        if (url.pathname === "/api/analyze" && request.method === "POST") {
          const body: unknown = await request.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("ids" in body) ||
            !Array.isArray(body.ids) ||
            !body.ids.every((id) => typeof id === "string")
          )
            return Response.json({ error: "idsが不正です。" }, { status: 400 });
          return Response.json({ queued: companion.enqueue(body.ids) }, { status: 202 });
        }
        const transcript = /^\/api\/lessons\/([\w-]+)\/transcript$/.exec(url.pathname);
        if (transcript?.[1] && request.method === "GET") {
          const file = Bun.file(store.path("analyses", `${store.lesson(transcript[1]).id}.learner.json`));
          if (!(await file.exists()))
            return Response.json({ error: "書き起こしがありません。" }, { status: 404 });
          const saved = (await file.json()) as { transcript: string; model: string };
          return Response.json({ transcript: saved.transcript, model: saved.model });
        }
        const teacher = /^\/api\/lessons\/([\w-]+)\/teacher$/.exec(url.pathname);
        if (teacher?.[1] && request.method === "GET") {
          const file = Bun.file(store.path("analyses", `${store.lesson(teacher[1]).id}.teacher.json`));
          if (!(await file.exists()))
            return Response.json({ error: "先生の発言の書き起こしがありません。" }, { status: 404 });
          const saved = (await file.json()) as { lines: unknown; model: string };
          return Response.json({ lines: saved.lines, model: saved.model });
        }
        const review = /^\/api\/lessons\/([\w-]+)\/review$/.exec(url.pathname);
        if (review?.[1] && request.method === "POST") {
          const lesson = store.lesson(review[1]);
          const body = (await request.json()) as { index?: number; reviewed?: boolean };
          if (
            !Number.isInteger(body.index) ||
            body.index === undefined ||
            body.index < 0 ||
            body.index >= (lesson.feedback?.expressions.length ?? 0) ||
            typeof body.reviewed !== "boolean"
          )
            return Response.json({ error: "復習項目が不正です。" }, { status: 400 });
          lesson.reviewed = body.reviewed
            ? [...new Set([...lesson.reviewed, body.index])]
            : lesson.reviewed.filter((i) => i !== body.index);
          store.save();
          return Response.json({ ok: true });
        }
        const favorite = /^\/api\/lessons\/([\w-]+)\/favorite$/.exec(url.pathname);
        if (favorite?.[1] && request.method === "POST") {
          const lesson = store.lesson(favorite[1]);
          const body = (await request.json()) as { index?: number; favorite?: boolean };
          if (
            !Number.isInteger(body.index) ||
            body.index === undefined ||
            body.index < 0 ||
            body.index >= (lesson.feedback?.expressions.length ?? 0) ||
            typeof body.favorite !== "boolean"
          )
            return Response.json({ error: "お気に入りの項目が不正です。" }, { status: 400 });
          const favorites = lesson.favorites ?? [];
          lesson.favorites = body.favorite
            ? [...new Set([...favorites, body.index])]
            : favorites.filter((i) => i !== body.index);
          store.save();
          return Response.json({ ok: true });
        }
        if (url.pathname === "/api/expressions" && request.method === "POST") {
          const fields = ownExpressionFields.safeParse(await request.json());
          if (!fields.success) return Response.json({ error: "表現の入力が不正です。" }, { status: 400 });
          // A written expression starts among the favorites; its star comes off like any other.
          const expression: OwnExpression = {
            id: randomUUID(),
            ...fields.data,
            createdAt: new Date().toISOString(),
            reviewed: false,
            favorite: true,
          };
          store.library.ownExpressions = [...(store.library.ownExpressions ?? []), expression];
          store.save();
          return Response.json(expression, { status: 201 });
        }
        const own = /^\/api\/expressions\/([\w-]+)$/.exec(url.pathname);
        if (own?.[1] && (request.method === "POST" || request.method === "DELETE")) {
          const expressions = store.library.ownExpressions ?? [];
          const expression = expressions.find((e) => e.id === own[1]);
          if (!expression) return Response.json({ error: "表現が見つかりません。" }, { status: 404 });
          if (request.method === "DELETE")
            store.library.ownExpressions = expressions.filter((e) => e !== expression);
          else {
            const change = ownExpressionChange.safeParse(await request.json());
            if (!change.success) return Response.json({ error: "表現の変更が不正です。" }, { status: 400 });
            Object.assign(expression, change.data);
          }
          store.save();
          return Response.json({ ok: true });
        }
        if (url.pathname === "/api/advice" && request.method === "POST") {
          const body = adviceToKeep.safeParse(await request.json());
          if (!body.success) return Response.json({ error: "アドバイスの指定が不正です。" }, { status: 400 });
          const { lessonId, text } = body.data;
          const lesson = store.library.lessons.find((l) => l.id === lessonId);
          const from = lesson && adviceIn(lesson).find((a) => a.text === text)?.from;
          if (!from) return Response.json({ error: "アドバイスが見つかりません。" }, { status: 404 });
          const kept = store.library.savedAdvice ?? [];
          const already = kept.find((a) => a.lessonId === lessonId && a.text === text);
          if (already) return Response.json(already);
          // Kept advice starts among the favorites, as the learner's own expressions do.
          const advice: SavedAdvice = {
            id: randomUUID(),
            lessonId,
            from,
            text,
            savedAt: new Date().toISOString(),
            favorite: true,
          };
          store.library.savedAdvice = [...kept, advice];
          store.save();
          return Response.json(advice, { status: 201 });
        }
        const keptAdvice = /^\/api\/advice\/([\w-]+)$/.exec(url.pathname);
        if (keptAdvice?.[1] && (request.method === "POST" || request.method === "DELETE")) {
          const kept = store.library.savedAdvice ?? [];
          const advice = kept.find((a) => a.id === keptAdvice[1]);
          if (!advice) return Response.json({ error: "アドバイスが見つかりません。" }, { status: 404 });
          if (request.method === "DELETE") store.library.savedAdvice = kept.filter((a) => a !== advice);
          else {
            const change = adviceChange.safeParse(await request.json());
            if (!change.success)
              return Response.json({ error: "アドバイスの変更が不正です。" }, { status: 400 });
            advice.favorite = change.data.favorite;
          }
          store.save();
          return Response.json({ ok: true });
        }
        const audio = /^\/api\/lessons\/([\w-]+)\/audio$/.exec(url.pathname);
        if (audio?.[1] && request.method === "GET") {
          const lesson = store.lesson(audio[1]);
          if (!lesson.audio) return new Response("Audio not ready", { status: 404 });
          const file = Bun.file(store.path(lesson.audio.file));
          const range = request.headers.get("range");
          const headers = {
            "Content-Type": "audio/mpeg",
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
          };
          if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!match)
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${file.size}` },
              });
            const start = Number(match[1]);
            const end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
            if (start > end || start >= file.size)
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${file.size}` },
              });
            return new Response(file.slice(start, end + 1), {
              status: 206,
              headers: {
                ...headers,
                "Content-Range": `bytes ${start}-${end}/${file.size}`,
                "Content-Length": String(end - start + 1),
              },
            });
          }
          return new Response(file, { headers });
        }
        if (url.pathname === "/api/export" && request.method === "GET") {
          return Response.json(
            {
              exportedAt: new Date().toISOString(),
              lessons: store.library.lessons.map((l) => ({
                id: l.id,
                date: l.date,
                teacher: l.teacher,
                feedback: l.feedback,
                reviewed: l.reviewed,
                favorites: l.favorites ?? [],
              })),
              ownExpressions: store.library.ownExpressions ?? [],
              savedAdvice: store.library.savedAdvice ?? [],
            },
            {
              headers: {
                "Content-Disposition": 'attachment; filename="dmm-review.json"',
                "Cache-Control": "no-store",
              },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        return Response.json({ error: safeError(error) }, { status: 400 });
      }
    },
  });
  // A new launch must not reuse an HTML shell that points at a previous binary's assets.
  return { server, url: `${server.url}?session=${randomBytes(8).toString("hex")}#${token}` };
}
