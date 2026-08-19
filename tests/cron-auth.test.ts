import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeCron } from "@/lib/cron/auth";

const SECRET = "a".repeat(64);

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/cron/sync-static", { headers });
}

describe("authorizeCron", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("accepts a bearer token", () => {
    expect(authorizeCron(request({ authorization: `Bearer ${SECRET}` })))
      .toEqual({ ok: true });
  });

  it("accepts the bare header, for manual and CI triggers", () => {
    expect(authorizeCron(request({ "x-cron-secret": SECRET }))).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong secret of the same length", () => {
    const wrong = "b".repeat(64);
    const result = authorizeCron(request({ authorization: `Bearer ${wrong}` }));
    expect(result).toEqual({ ok: false, status: 401, message: "Unauthorized." });
  });

  it("rejects a request with no credentials", () => {
    expect(authorizeCron(request())).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a correct prefix, so a partial guess earns nothing", () => {
    const prefix = SECRET.slice(0, 32);
    expect(authorizeCron(request({ "x-cron-secret": prefix }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("denies rather than allows when CRON_SECRET is unset", () => {
    // An unconfigured deployment must be closed, not open. This is the test
    // that stops a refactor from turning a missing secret into a free pass.
    delete process.env.CRON_SECRET;
    expect(authorizeCron(request({ "x-cron-secret": "anything" })))
      .toMatchObject({ ok: false, status: 503 });
  });
});
