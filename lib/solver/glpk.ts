import GLPK from "glpk.js/node";
import type { LpProblem, LpSolution, LpSolver } from "@/lib/engine/lp";

/**
 * glpk.js adapter.
 *
 * This lives OUTSIDE `lib/engine/**` deliberately. The engine must stay pure,
 * and creating a GLPK instance is async WASM initialisation. Everything
 * impure about the solver is confined to this file; the engine only ever sees
 * the `LpSolver` interface.
 *
 * Use the `glpk.js/node` entry point, not the package default — the default
 * build dispatches to a browser `Worker` and throws in Node.
 */

type Glpk = Awaited<ReturnType<typeof GLPK>>;

let instance: Glpk | null = null;

/** Initialise once and reuse. WASM startup is the expensive part. */
export async function createGlpkSolver(): Promise<LpSolver> {
  instance ??= await GLPK();
  const glpk = instance;

  return {
    solve(problem: LpProblem): LpSolution {
      const variables = new Set<string>();
      for (const name of Object.keys(problem.objective)) variables.add(name);
      for (const c of problem.constraints) {
        for (const name of Object.keys(c.coefficients)) variables.add(name);
      }

      const bounds = [...variables].map((name) => {
        const b = problem.bounds?.[name] ?? { lb: 0, ub: 1 };
        return { name, type: glpk.GLP_DB, lb: b.lb, ub: b.ub };
      });

      const lp = {
        name: "fpl",
        objective: {
          direction:
            problem.direction === "max" ? glpk.GLP_MAX : glpk.GLP_MIN,
          name: "obj",
          vars: [...variables].map((name) => ({
            name,
            coef: problem.objective[name] ?? 0,
          })),
        },
        subjectTo: problem.constraints.map((c) => ({
          name: c.name,
          vars: Object.entries(c.coefficients).map(([name, coef]) => ({
            name,
            coef,
          })),
          bnds: toBounds(glpk, c.type, c.rhs),
        })),
        binaries: problem.binaries.length > 0 ? problem.binaries : undefined,
        bounds: problem.binaries.length > 0 ? undefined : bounds,
      };

      const { result } = glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });

      return {
        status: toStatus(glpk, result.status),
        objectiveValue: result.z ?? 0,
        variables: result.vars ?? {},
        // Duals come back only for pure LPs. A MIP has none.
        duals: problem.binaries.length === 0 ? result.dual : undefined,
      };
    },
  };
}

function toBounds(glpk: Glpk, type: LpProblem["constraints"][number]["type"], rhs: number) {
  switch (type) {
    case "<=":
      return { type: glpk.GLP_UP, ub: rhs, lb: 0 };
    case ">=":
      return { type: glpk.GLP_LO, ub: 0, lb: rhs };
    case "=":
      return { type: glpk.GLP_FX, ub: rhs, lb: rhs };
  }
}

function toStatus(glpk: Glpk, status: number): LpSolution["status"] {
  if (status === glpk.GLP_OPT) return "optimal";
  if (status === glpk.GLP_NOFEAS) return "infeasible";
  if (status === glpk.GLP_UNBND) return "unbounded";
  return "other";
}
