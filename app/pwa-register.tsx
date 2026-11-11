"use client";

import { useEffect } from "react";
import { prepareOfflineLutPack } from "../lib/lut-loader.js";

export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      window.requestAnimationFrame(() => window.setTimeout(async () => {
        try {
          const registration = await navigator.serviceWorker.register("/sw.js?v=60");
          const probe = (window as typeof window & {
            __SEE_BOOT__?: { events: Array<{ label: string; time: number; detail: string }> };
          }).__SEE_BOOT__;
          probe?.events.push({ label: "LUT preparation start", time: performance.now(), detail: "" });
          await prepareOfflineLutPack(registration);
        } catch {
          // The app remains fully usable online if registration is unavailable.
        }
      }, 0));
    }
  }, []);

  return null;
}
