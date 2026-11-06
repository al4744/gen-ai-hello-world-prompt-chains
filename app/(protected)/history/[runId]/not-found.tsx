import Link from "next/link";

export default function GenerationNotFound() {
  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8"><h1 className="text-3xl font-bold tracking-tight">Generation not found</h1>
    <p className="mt-3 text-sm leading-6 text-muted">This run does not have a verified completed generation available.</p><Link href="/history" prefetch={false} className="button-secondary mt-5">Back to History</Link></div>;
}
