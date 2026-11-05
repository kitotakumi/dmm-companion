import { closeSync, openSync } from "node:fs";

export class CommandError extends Error {
  constructor(
    executable: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${executable} が失敗しました (${exitCode}): ${stderr.slice(-700)}`);
  }
}

export async function command(
  args: string[],
  options: { cwd?: string; timeout?: number; log?: string; onStderr?: (line: string) => void } = {},
): Promise<string> {
  const executable = args[0];
  if (!executable || !Bun.which(executable))
    throw new Error(`${executable} が見つかりません。インストールしてPATHを確認してください。`);
  const fd = options.log ? openSync(options.log, "w", 0o600) : undefined;
  let timedOut = false;
  const child = Bun.spawn(args, { cwd: options.cwd, stdin: "ignore", stdout: fd ?? "pipe", stderr: "pipe" });
  const terminate = () => {
    kill(child);
  };
  process.once("exit", terminate);
  const timer = setTimeout(() => {
    timedOut = true;
    kill(child);
  }, options.timeout ?? 180_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
      options.onStderr ? lines(child.stderr, options.onStderr) : new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`${executable} が制限時間を超えました。保存済みデータから再実行できます。`);
    if (exitCode !== 0) throw new CommandError(executable, exitCode, stdout, stderr);
    return options.log ? Bun.file(options.log).text() : stdout;
  } finally {
    process.removeListener("exit", terminate);
    clearTimeout(timer);
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Ends the child. A process killed on Windows leaves the ones it started running (the Python that
 * `uv run` starts, for one), so there the whole tree is ended.
 */
function kill(child: { pid: number; kill(): void }): void {
  if (process.platform !== "win32") child.kill();
  else
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
}

/** The stream's text, handing each line to `onLine` as soon as it is complete. */
async function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let from = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    text += decoder.decode(read.value, { stream: true });
    for (let end = text.indexOf("\n", from); end !== -1; end = text.indexOf("\n", from)) {
      onLine(text.slice(from, end).trimEnd());
      from = end + 1;
    }
  }
  return text + decoder.decode();
}
