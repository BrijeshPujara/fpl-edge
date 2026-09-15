"use client";

import Image from "next/image";
import { useState } from "react";
import { shirtUrl } from "@/lib/fpl/shirts";

/**
 * A player's club shirt, with a plain outline when the club or image is
 * unknown.
 *
 * Client-side only because the fallback needs to observe a failed load.
 * Decorative: the name label beside it is what a screen reader should read.
 */
export function PlayerShirt({
  teamCode,
  goalkeeper,
  className,
}: {
  /** Null when the club's code is not known, e.g. in the preview harness. */
  teamCode: number | null;
  goalkeeper: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (teamCode === null || failed) {
    return (
      <svg aria-hidden viewBox="0 0 110 145" className={className}>
        <path
          d="M36 12 16 22 2 52l20 10 10-12v83h46V50l10 12 20-10-14-30-20-10c-4 10-11 15-19 15s-15-5-19-15z"
          fill="var(--surface-track-strong)"
        />
      </svg>
    );
  }

  return (
    <Image
      src={shirtUrl(teamCode, goalkeeper)}
      alt=""
      width={110}
      height={145}
      className={className}
      onError={() => setFailed(true)}
      // An image that fails before hydration never reaches `onError` — the
      // browser fires the event while React is not yet listening — so the
      // element is also checked the moment it attaches.
      ref={(img) => {
        if (img && img.complete && img.naturalWidth === 0) setFailed(true);
      }}
    />
  );
}
