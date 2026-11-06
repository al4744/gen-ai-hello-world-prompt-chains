"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const successFlags = ["created", "updated", "step_created", "step_updated", "step_deleted"];
const DismissSuccess = createContext(() => {});

export function useDismissChainSuccess() {
  return useContext(DismissSuccess);
}

export default function ChainSuccessNotice({ message, children }: { message: string | null; children: ReactNode }) {
  const { bfcacheId } = useRouter();
  // A fresh redirect to the same chain must show its new confirmation, even
  // when Next preserves client state with Activity. Never remount the steps.
  const noticeId = `${bfcacheId}:${message}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismiss = useCallback(() => setDismissed(noticeId), [noticeId]);

  useEffect(() => {
    if (!message) return;
    const url = new URL(window.location.href);
    const hadFlags = successFlags.some(flag => url.searchParams.has(flag));
    successFlags.forEach(flag => url.searchParams.delete(flag));
    // Consume only notification flags. Keep the redirect destination, unrelated
    // parameters and step anchor, without another request, history entry or scroll.
    if (hadFlags) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    // Click also covers keyboard activation. Avoid pointerdown dismissal: a
    // layout shift between pointerdown and pointerup could swallow a click.
    document.addEventListener("click", dismiss, true);
    window.addEventListener("popstate", dismiss);
    window.addEventListener("pagehide", dismiss);
    return () => {
      document.removeEventListener("click", dismiss, true);
      window.removeEventListener("popstate", dismiss);
      window.removeEventListener("pagehide", dismiss);
    };
  }, [message, dismiss]);

  return <DismissSuccess.Provider value={dismiss}>
    {message && dismissed !== noticeId && <p role="status" className="feedback-success mb-5">{message}</p>}
    {children}
  </DismissSuccess.Provider>;
}
