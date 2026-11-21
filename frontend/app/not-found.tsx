import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink px-6 text-center text-bone">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-curtain">
        404
      </p>
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        That title isn&apos;t here.
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-muted">
        The id in the URL doesn&apos;t point to a playable title. Check the TMDB id
        or start again from the studio.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-bone transition hover:bg-white/[0.08]"
      >
        Back to the studio
      </Link>
    </main>
  );
}
