export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(`${status} ${code}`);
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

export function createApi(baseUrl: string, getToken: () => string | null, fetchImpl: typeof fetch = fetch): Api {
  async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseText = await response.text();
    let json: unknown = null;
    if (responseText) {
      try {
        json = JSON.parse(responseText);
      } catch {
        if (!response.ok) throw new ApiError(response.status, "http_error");
        throw new Error("Expected a JSON response");
      }
    }
    if (!response.ok) {
      const errorCode = typeof json === "object" && json !== null && "error" in json && typeof json.error === "string"
        ? json.error
        : "http_error";
      throw new ApiError(response.status, errorCode);
    }
    return json as T;
  }

  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body), patch: (path, body) => call("PATCH", path, body) };
}
