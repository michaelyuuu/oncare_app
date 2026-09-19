import { describe, expect, test, vi } from "vitest";
import { ApiError, createApi } from "../src/api";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("createApi", () => {
  test("PATCH uses authenticated JSON and preserves errors", async () => {
    const f = fakeFetch(400, { error: "bad_request" });
    const api = createApi("http://api", () => "staff-token", f);
    await expect(api.patch("/locations/standby", { x: 2 })).rejects.toMatchObject({ code: "bad_request" });
    expect(f).toHaveBeenCalledWith("http://api/locations/standby", expect.objectContaining({ method: "PATCH", body: '{"x":2}', headers: expect.objectContaining({ authorization: "Bearer staff-token" }) }));
  });
  test("adds the bearer token and parses JSON", async () => {
    const f = fakeFetch(200, { visit: { id: "v1" } });
    const api = createApi("http://api", () => "tok", f);

    await expect(api.get<{ visit: { id: string } }>("/visits/v1")).resolves.toEqual({ visit: { id: "v1" } });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("http://api/visits/v1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  test("omits the header without a token and posts JSON bodies", async () => {
    const f = fakeFetch(201, { ok: true });
    const api = createApi("http://api", () => null, f);

    await api.post("/auth/login", { username: "a", password: "b" });
    const [, init] = (f as any).mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ username: "a", password: "b" }));
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("throws ApiError with the server's error code on non-2xx", async () => {
    const api = createApi("http://api", () => null, fakeFetch(409, { error: "resident_unavailable" }));

    await expect(api.post("/visits", {})).rejects.toMatchObject({ status: 409, code: "resident_unavailable" });
    await expect(api.post("/visits", {})).rejects.toBeInstanceOf(ApiError);
  });

  test("preserves ApiError for non-JSON error responses", async () => {
    const fetchText = vi.fn(async () => new Response("gateway unavailable", { status: 502 })) as unknown as typeof fetch;
    const api = createApi("http://api", () => null, fetchText);

    await expect(api.get("/health")).rejects.toMatchObject({ status: 502, code: "http_error" });
    await expect(api.get("/health")).rejects.toBeInstanceOf(ApiError);
  });

  test("del sends DELETE with the bearer token and no body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'));
    const api = createApi("http://api", () => "jwt", fetchImpl as unknown as typeof fetch);
    expect(await api.del("/admin/family-links/l1")).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("http://api/admin/family-links/l1", { method: "DELETE", headers: { accept: "application/json", authorization: "Bearer jwt" } });
  });
});
