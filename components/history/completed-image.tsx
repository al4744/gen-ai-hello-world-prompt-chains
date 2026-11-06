"use client";
import Image from "next/image";
import { useState } from "react";
import { completedMediaHref } from "@/lib/history/model";

export default function CompletedImage({ runId, alt, full = false }: { runId: string; alt: string; full?: boolean }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const src = `${completedMediaHref(runId)}${attempt ? `?attempt=${attempt}` : ""}`;
  if (failed) return <div role="status" className="flex min-h-56 flex-col items-center justify-center gap-3 bg-panel p-5 text-center text-sm leading-6 text-muted">
    <p>The saved image could not be loaded. Your generation record is still available.</p>
    <button type="button" className="button-secondary" onClick={() => { setAttempt(value => value + 1); setFailed(false); }}>Try image again</button>
  </div>;
  return full ? <Image src={src} alt={alt} width={1200} height={1600} unoptimized loading="eager" className="h-auto w-full" onError={() => setFailed(true)} />
    : <div className="relative aspect-[4/3] bg-panel"><Image src={src} alt={alt} fill unoptimized loading="lazy" sizes="(min-width: 1280px) 28vw, (min-width: 640px) 45vw, 90vw" className="object-contain p-2" onError={() => setFailed(true)} /></div>;
}
