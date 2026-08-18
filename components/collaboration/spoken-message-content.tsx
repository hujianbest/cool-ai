"use client";

import { useEffect, useRef, useState } from "react";

type SpokenSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string; text: string };

function excerpt(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function splitSpokenMessageText(text: string): SpokenSegment[] {
  const fence = /```([^\n]*)\n([\s\S]*?)\n```/g;
  const segments: SpokenSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(fence)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const prose = text.slice(cursor, start).trim();
      if (prose) segments.push({ kind: "text", text: prose });
    }
    segments.push({
      kind: "code",
      language: match[1]?.trim() ?? "",
      text: match[2] ?? "",
    });
    cursor = start + match[0].length;
  }
  const trailing = text.slice(cursor).trim();
  if (trailing) segments.push({ kind: "text", text: trailing });
  if (segments.length === 0 && text) {
    segments.push({ kind: "text", text });
  }
  return segments;
}

export function SpokenMessageContent({ text }: { text: string }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segments = splitSpokenMessageText(text);

  useEffect(() => {
    return () => {
      if (copiedResetRef.current !== null) {
        clearTimeout(copiedResetRef.current);
      }
    };
  }, []);

  async function copyCode(index: number, code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopiedIndex(index);
    if (copiedResetRef.current !== null) {
      clearTimeout(copiedResetRef.current);
    }
    copiedResetRef.current = setTimeout(() => {
      setCopiedIndex((current) => (current === index ? null : current));
      copiedResetRef.current = null;
    }, 2000);
  }

  return (
    <div className="msg-content">
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return <p key={`text-${index}`}>{segment.text}</p>;
        }
        const copied = copiedIndex === index;
        return (
          <div className="msg-code" key={`code-${index}`}>
            <div className="msg-code-toolbar">
              {segment.language ? (
                <span className="msg-code-lang">{segment.language}</span>
              ) : null}
              <button
                aria-label={
                  copied ? "已复制代码" : `复制代码：${excerpt(segment.text)}`
                }
                className="msg-code-copy"
                onClick={() => {
                  void copyCode(index, segment.text);
                }}
                type="button"
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <pre>
              <code>{segment.text}</code>
            </pre>
          </div>
        );
      })}
    </div>
  );
}
