import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * glpk.js must not be bundled.
   *
   * It is a WASM module that resolves `glpk.wasm` relative to its own file at
   * runtime. Bundling rewrites that path into `/_next/static/media/…`, which
   * does not exist on the server, and the solver throws ENOENT the first time
   * anything asks it to solve.
   *
   * That failure is invisible until a screen actually reaches the optimiser —
   * both decision screens short-circuit before it while there is no gameweek
   * history — so it stayed hidden until the preview harness forced the path to
   * run. Marking the package external leaves it in node_modules, where its own
   * relative path is correct.
   */
  serverExternalPackages: ["glpk.js"],

  /**
   * Club shirts for the pitch, from FPL's own static assets.
   *
   * Narrowed to the shirt path rather than the whole host, so the image
   * optimiser cannot be pointed at anything else on it. See lib/fpl/shirts.ts
   * for why shirts and not player photos.
   */
  images: {
    remotePatterns: [
      new URL("https://fantasy.premierleague.com/dist/img/shirts/standard/**"),
    ],
  },
};

export default nextConfig;
