import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DpapiLogin, KeychainLogin } from "../src/saved-login";

test.skipIf(process.platform !== "darwin")(
  "キーチェーンに保存したログイン情報を記号・非ASCIIも含めて復元・削除する",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dmm-keychain-"));
    const keychain = new KeychainLogin(root);
    try {
      expect(await keychain.recall()).toBeUndefined();
      await keychain.remember({ email: "old@example.com", password: "old" });
      const identity = { email: "user+dmm@example.com", password: `p"a ss\\wörd' $(x)` };
      await keychain.remember(identity);
      expect(await keychain.recall()).toEqual(identity);
      expect(await new KeychainLogin(join(root, "other")).recall()).toBeUndefined();
      await keychain.forget();
      expect(await keychain.recall()).toBeUndefined();
    } finally {
      await keychain.forget();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "DPAPIで暗号化したログイン情報を記号・非ASCIIも含めて復元・削除する",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dmm-dpapi-"));
    const saved = new DpapiLogin(root);
    try {
      expect(await saved.recall()).toBeUndefined();
      await saved.remember({ email: "old@example.com", password: "old" });
      const identity = { email: "user+dmm@example.com", password: `p"a ss\\wörd' $(x)` };
      await saved.remember(identity);
      expect(readFileSync(join(root, "saved-login.json"), "utf8")).not.toContain("user+dmm");
      expect(await saved.recall()).toEqual(identity);
      expect(await new DpapiLogin(join(root, "other")).recall()).toBeUndefined();
      await saved.forget();
      expect(await saved.recall()).toBeUndefined();
    } finally {
      await saved.forget();
      rmSync(root, { recursive: true, force: true });
    }
  },
  // Each DPAPI call starts PowerShell, which takes a second or two.
  30_000,
);
