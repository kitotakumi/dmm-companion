import { type ChangeEvent, useEffect, useRef, useState } from "react";
import type { OwnExpression } from "../domain";

type Fields = Pick<OwnExpression, "text" | "meaning" | "memo">;
const blank: Fields = { text: "", meaning: "", memo: "" };

/** Writes an expression of the learner's own into the phrase notebook, or rewrites one. */
export function ExpressionForm({
  initial,
  stayOpen,
  save,
  cancel,
}: {
  initial?: Fields;
  /** Keeps the form open after each save, emptied for the next expression. */
  stayOpen?: boolean;
  /** Saves the fields; when it rejects, the form stays open with the reason. */
  save: (fields: Fields) => Promise<void>;
  cancel: () => void;
}) {
  const [fields, setFields] = useState<Fields>({
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
  const field = (name: keyof Fields) => ({
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
            setFields(blank);
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
      <span className="eyebrow">{initial ? "EDIT YOUR PHRASE" : "WRITE YOUR OWN"}</span>
      <label>
        英語の表現
        <textarea
          ref={text}
          className="own-text"
          rows={2}
          maxLength={500}
          required
          placeholder="例: It can be."
          {...field("text")}
        />
      </label>
      <label>
        意味（任意）
        <input maxLength={1000} placeholder="例: そういうこともある" {...field("meaning")} />
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
