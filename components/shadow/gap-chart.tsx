"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * The cumulative gap between the shadow and the manager, against the band luck
 * alone would stay inside.
 *
 * One series, so no legend — the section label names it. The band is the
 * point of the chart, not decoration: a line wandering inside it is what a
 * system with no edge looks like, and without it every early lead reads as a
 * verdict. The weekly table beneath carries every value, so the hover layer
 * enhances and never gates.
 *
 * Drawn at the container's real pixel width rather than scaled from a fixed
 * viewBox. Scaling made the axis text twice the app's type size on a desktop
 * panel and unreadably small on a phone; one unit per pixel keeps it at 11px
 * everywhere.
 */

export interface GapPoint {
  gw: number;
  gap: number;
  cumulative: number;
  band: number | null;
}

const HEIGHT = 200;
const PAD = { top: 16, right: 44, bottom: 26, left: 40 };
/** Minimum horizontal room per gameweek label before labels are thinned. */
const LABEL_SPACING = 44;

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

export function GapChart({ points }: { points: GapPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const extent = Math.max(
    10,
    ...points.map((p) => Math.abs(p.cumulative)),
    ...points.map((p) => p.band ?? 0),
  );
  // A clean tick at a multiple of 5, with headroom so the end label clears.
  const yMax = Math.ceil((extent * 1.15) / 5) * 5;

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH / 2 - (v / yMax) * (plotH / 2);

  // Every k-th label, always including the last, so a phone shows a readable
  // axis rather than twelve overlapping ones.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / LABEL_SPACING))));
  const last = points.length - 1;
  const labelled = (i: number) => i === last || (last - i) % labelEvery === 0;

  const bandPath =
    points.filter((p) => p.band !== null).length > 1
      ? [
          ...points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.band ?? 0)}`),
          ...points
            .map((p, i) => ({ p, i }))
            .reverse()
            .map(({ p, i }) => `L${x(i)},${y(-(p.band ?? 0))}`),
          "Z",
        ].join(" ")
      : null;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.cumulative)}`)
    .join(" ");

  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    }
    setActive(best);
  };

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowRight") setActive((i) => Math.min(last, (i ?? -1) + 1));
    if (event.key === "ArrowLeft") setActive((i) => Math.max(0, (i ?? last + 1) - 1));
  };

  const point = active === null ? null : points[active];
  const marker = active ?? last;

  return (
    <div ref={container} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block max-w-full touch-pan-y outline-none focus-visible:outline-1 focus-visible:outline-edge-strong"
        role="img"
        aria-label={`Cumulative gap after ${points.length} scored gameweek${points.length === 1 ? "" : "s"}: ${signed(points[last].cumulative)} points to the engine. Use the arrow keys for each week.`}
        tabIndex={0}
        onPointerMove={nearest}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((i) => i ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        {[-yMax, 0, yMax].map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--border-strong)" : "var(--border-subtle)"}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="font-mono"
              fontSize={11}
              fill="var(--text-muted)"
            >
              {signed(tick)}
            </text>
          </g>
        ))}

        {bandPath ? (
          <path d={bandPath} fill="var(--accent)" fillOpacity={0.1} stroke="none" />
        ) : null}

        {points.map((p, i) =>
          labelled(i) ? (
            <text
              key={p.gw}
              x={x(i)}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="font-mono"
              fontSize={11}
              fill="var(--text-muted)"
            >
              GW{p.gw}
            </text>
          ) : null,
        )}

        {active !== null ? (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
            stroke="var(--border-strong)"
            strokeWidth={1}
          />
        ) : null}

        {points.length > 1 ? (
          <path
            d={linePath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* The marker follows the pointer; the end label is the only direct label. */}
        <circle
          cx={x(marker)}
          cy={y(points[marker].cumulative)}
          r={4}
          fill="var(--accent)"
          stroke="var(--surface-panel)"
          strokeWidth={2}
        />
        <text
          x={x(last) + 10}
          y={y(points[last].cumulative)}
          dominantBaseline="middle"
          className="font-mono"
          fontSize={12}
          fill="var(--text-primary)"
        >
          {signed(points[last].cumulative)}
        </text>
      </svg>

      {point !== null && active !== null ? (
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap border border-edge-strong bg-panel px-2.5 py-1.5 font-mono text-micro"
          style={{
            left: x(active),
            transform: active > last / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="text-primary">{signed(point.cumulative)} overall</div>
          <div className="text-muted">
            GW{point.gw} · {signed(point.gap)} that week
          </div>
          {point.band !== null ? (
            <div className="text-muted">luck band ±{Math.round(point.band)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
