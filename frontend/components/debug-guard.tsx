"use client";

import { useEffect } from "react";
import { installDebugGuard } from "@/lib/debug-guard";

/** Installs the devtools/debugger guard for every page in the app. */
export function DebugGuard() {
  useEffect(() => installDebugGuard(), []);
  return null;
}
