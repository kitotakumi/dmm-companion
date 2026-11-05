import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoginIdentity } from "./prompt";
import { atomicJson, hash } from "./store";

/** The password entered at dmm setup, kept so an expired session can sign in again without the user. */
export type SavedLogin = {
  readonly available: boolean;
  remember(identity: LoginIdentity): Promise<void>;
  recall(): Promise<LoginIdentity | undefined>;
  forget(): Promise<void>;
};

const ITEM_NOT_FOUND = 44;

/** macOS login keychain item, one per data directory. Only /usr/bin/security reads or writes it. */
export class KeychainLogin implements SavedLogin {
  readonly available = process.platform === "darwin";
  private readonly service: string;
  constructor(root: string) {
    this.service = `com.dmm-companion.login.${hash(resolve(root)).slice(0, 12)}`;
  }
  async remember(identity: LoginIdentity): Promise<void> {
    await this.forget();
    // Hex keeps the secret out of argv quoting and out of `ps`; the item stores hex so -w reads back unambiguously.
    const secret = Buffer.from(identity.password, "utf8").toString("hex");
    const account = Buffer.from(identity.email, "utf8").toString("hex");
    const { exitCode, stderr } = await this.security(
      ["-i"],
      `add-generic-password -s ${this.service} -a ${account} -l "DMM Companion" -w ${secret}\n`,
    );
    if (exitCode !== 0 || stderr.trim())
      throw new Error(`パスワードをキーチェーンに保存できませんでした: ${stderr.trim()}`);
  }
  async recall(): Promise<LoginIdentity | undefined> {
    const item = await this.security(["find-generic-password", "-s", this.service]);
    if (item.exitCode === ITEM_NOT_FOUND) return undefined;
    const account = /"acct"<blob>="([0-9a-f]+)"/.exec(item.stdout)?.[1];
    if (item.exitCode !== 0 || !account) throw new Error("キーチェーンの保存済みログイン情報を読めません。");
    const secret = await this.security(["find-generic-password", "-s", this.service, "-w"]);
    if (secret.exitCode !== 0) throw new Error("キーチェーンの保存済みパスワードを読めません。");
    return {
      email: Buffer.from(account, "hex").toString("utf8"),
      password: Buffer.from(secret.stdout.trim(), "hex").toString("utf8"),
    };
  }
  async forget(): Promise<void> {
    while (true) {
      const { exitCode } = await this.security(["delete-generic-password", "-s", this.service]);
      if (exitCode === ITEM_NOT_FOUND) return;
      if (exitCode !== 0) throw new Error("キーチェーンの保存済みパスワードを削除できません。");
    }
  }
  private async security(args: string[], input?: string) {
    if (!this.available) throw new Error("パスワードの保存はmacOSのキーチェーンでのみ利用できます。");
    const child = Bun.spawn(["/usr/bin/security", ...args], {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

/**
 * Windows: a file in the data directory, encrypted with DPAPI so only this Windows user on this
 * machine can decrypt it. The secret passes through stdin as base64, never through argv.
 */
export class DpapiLogin implements SavedLogin {
  readonly available = process.platform === "win32";
  private readonly file: string;
  private readonly entropy: string;
  constructor(root: string) {
    this.file = join(resolve(root), "saved-login.json");
    this.entropy = `com.dmm-companion.login.${hash(resolve(root)).slice(0, 12)}`;
  }
  async remember(identity: LoginIdentity): Promise<void> {
    const sealed = await this.dpapi(
      "Protect",
      Buffer.from(JSON.stringify(identity), "utf8").toString("base64"),
    );
    atomicJson(this.file, { version: 1, sealed });
  }
  async recall(): Promise<LoginIdentity | undefined> {
    if (!existsSync(this.file)) return undefined;
    const { sealed } = JSON.parse(readFileSync(this.file, "utf8")) as { sealed?: string };
    if (!sealed) throw new Error("保存済みのログイン情報を読めません。");
    const plain = await this.dpapi("Unprotect", sealed);
    return JSON.parse(Buffer.from(plain, "base64").toString("utf8")) as LoginIdentity;
  }
  async forget(): Promise<void> {
    rmSync(this.file, { force: true });
  }
  private async dpapi(operation: "Protect" | "Unprotect", base64: string): Promise<string> {
    if (!this.available) throw new Error("DPAPIによるパスワードの保存はWindowsでのみ利用できます。");
    const script = [
      "Add-Type -AssemblyName System.Security",
      "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
      `$entropy = [Text.Encoding]::UTF8.GetBytes('${this.entropy}')`,
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}($data, $entropy, 'CurrentUser'))`,
    ].join("\n");
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdin: new TextEncoder().encode(base64), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0 || !stdout.trim())
      throw new Error(
        operation === "Protect"
          ? "パスワードを暗号化して保存できませんでした。"
          : "保存済みのパスワードを復号できません。dmm setupを再実行してください。",
      );
    return stdout.trim();
  }
}

/** Where this OS keeps the password; on other OSes the store is unavailable. */
export function savedLoginFor(root: string): SavedLogin {
  return process.platform === "win32" ? new DpapiLogin(root) : new KeychainLogin(root);
}
