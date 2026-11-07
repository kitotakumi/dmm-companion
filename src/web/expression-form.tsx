import { type ChangeEvent, useEffect, useRef, useState } from "react";
import type { OwnExpression } from "../domain";

type Fields = Pick<OwnExpression, "kind" | "text" | "meaning" | "memo">;
type Kind = Fields["kind"];
const kinds: Record<Kind, { label: string; text: string; meaning: string }> = {
  sentence: { label: "文章", text: "例: It can be.", meaning: "例: そういうこともある" },
  word: { label: "単語", text: "例: relieved", meaning: "例: ほっとした" },
};

/** Writes an expression of the learner's own into the phrase notebook, or rewrites one. */
export function ExpressionForm({
  initial,
  kind = "sentence",
  stayOpen,
  save,
  cancel,
}: {
  initial?: Fields;
  /** What a new expression is until the learner picks the other kind. */
  kind?: Kind;
  /** Keeps the form open after each save, emptied for the next expression of the same kind. */
  stayOpen?: boolean;
  /** Saves the fields; when it rejects, the form stays open with the reason. */
  save: (fields: Fields) => Promise<void>;
  cancel: () => void;
}) {
  const [fields, setFields] = useState<Fields>({
    kind: initial?.kind ?? kind,
    text: initial?.text ?? "",
    meaning: initial?.meaning ?? "",
    memo: initial?.memo ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    text.current?.focus();
    // A form that opens partly out of view, as in the sidebar on a short screen, is scrolled into view.
    form.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const field = (name: "text" | "meaning" | "memo") => ({
    value: fields[name],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setFields((current) => ({ ...current, [name]: e.target.value })),
  });
  return (
    <form
      ref={form}
      className="expression own-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        setFailure("");
        setSaved("");
        save(fields).then(
          () => {
            if (!stayOpen) return;
            setSaved(fields.text.trim());
            setFields({ kind: fields.kind, text: "", meaning: "", memo: "" });
            setSaving(false);
            text.current?.focus();
          },
          (error: Error) => {
            setFailure(error.message);
            setSaving(false);
          },
        );
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.requestSubmit();
      }}
    >
      <div className="own-form-top">
        <span className="eyebrow">
          {initial ? `EDIT YOUR ${fields.kind === "word" ? "WORD" : "PHRASE"}` : "WRITE YOUR OWN"}
        </span>
        <span className="own-kinds">
          {(["sentence", "word"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={fields.kind === k}
              onClick={() => setFields((current) => ({ ...current, kind: k }))}
            >
              {kinds[k].label}
            </button>
          ))}
        </span>
      </div>
      <label>
        英語の表現
        <textarea
          ref={text}
          className="own-text"
          rows={2}
          maxLength={500}
          required
          placeholder={kinds[fields.kind].text}
          {...field("text")}
        />
      </label>
      <label>
        意味（任意）
        <input maxLength={1000} placeholder={kinds[fields.kind].meaning} {...field("meaning")} />
      </label>
      <label>
        メモ（任意）
        <textarea rows={3} maxLength={2000} placeholder="出会った場面や使い方など" {...field("memo")} />
      </label>
      {failure && <p className="speaking-error">{failure}</p>}
      {saved && <output className="own-saved">✓ 「{saved}」をノートに追加しました</output>}
      <div className="own-form-actions">
        <small>Ctrl+Enterでも{initial ? "保存" : "追加"}できます</small>
        <button type="button" className="outline-button" onClick={cancel}>
          {stayOpen ? "閉じる" : "キャンセル"}
        </button>
        <button type="submit" className="primary-button" disabled={saving || !fields.text.trim()}>
          {initial ? "保存する" : "ノートに追加"}
        </button>
      </div>
    </form>
  );
}
