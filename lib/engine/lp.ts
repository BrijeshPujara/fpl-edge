/**
 * A minimal linear-programming interface.
 *
 * `lib/engine/**` must be pure — no I/O, no async initialisation. glpk.js is a
 * WASM module that needs both, so the engine never imports it. Instead the
 * caller passes in an object satisfying this interface, adapted from glpk.js at
 * the boundary (`lib/solver/glpk.ts`).
 *
 * That keeps the optimiser deterministic and unit-testable with a fake solver,
 * and means swapping solvers later touches one adapter rather than the engine.
 */

export type ConstraintType = "<=" | ">=" | "=";

export interface LpConstraint {
  /** Must be unique — duals are returned keyed by this name. */
  name: string;
  /** Variable name to coefficient. Omitted variables have coefficient zero. */
  coefficients: Record<string, number>;
  type: ConstraintType;
  rhs: number;
}

export interface LpProblem {
  direction: "max" | "min";
  /** Variable name to objective coefficient. */
  objective: Record<string, number>;
  constraints: LpConstraint[];
  /**
   * Variables restricted to {0,1}. When empty the problem is a pure LP and the
   * solver is expected to return duals.
   */
  binaries: string[];
  /** Bounds for non-binary variables. Defaults to [0,1] when absent. */
  bounds?: Record<string, { lb: number; ub: number }>;
}

export interface LpSolution {
  status: "optimal" | "infeasible" | "unbounded" | "other";
  objectiveValue: number;
  variables: Record<string, number>;
  /**
   * Dual value per constraint name. Populated only for LP relaxations —
   * a mixed-integer programme has no meaningful duals.
   */
  duals?: Record<string, number>;
}

export interface LpSolver {
  solve(problem: LpProblem): LpSolution;
}
