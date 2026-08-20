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
};

export default nextConfig;
