export type StreamKind = "hls" | "dash" | "native";

/** Detect the streaming engine to use from a source URL. */
export function detectStreamKind(src: string): StreamKind {
  const path = src.split("?")[0].toLowerCase();
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  return "native"; // mp4, webm, ogg, mov, …
}
