/**
 * Stub for the `server-only` package under Vitest.
 *
 * `server-only` resolves to a module that throws on import outside a React
 * Server Component, which is exactly what makes it useful in the app and
 * exactly what breaks it in a plain Node test runner. Aliasing it to this
 * empty module lets server modules be unit-tested directly.
 *
 * This does not weaken the guarantee: the real package is still what Next
 * resolves during `next build`, which is where the guard has to hold.
 */
export {};
