import { describe, expect, test } from "vitest";
import { OpenAIRealtimeProvider, REALTIME_TOOL_DEFINITIONS } from "../src/services/voice";

describe("OpenAI Realtime tool schema", () => {
  test("declares every assistant tool as a function", async () => {
    let body = "";
    const provider = new OpenAIRealtimeProvider({
      apiKey: "server-secret",
      request: async (request) => {
        body = request.body;
        return { status: 200, body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" };
      },
    });

    await provider.createCall("v=0\r\n");
    const session = JSON.parse(body.match(/\r\n\r\n({.*})\r\n--/s)![1]!);
    expect(session.tools).toEqual(expect.arrayContaining(
      REALTIME_TOOL_DEFINITIONS.map((tool) => expect.objectContaining({ name: tool.name, type: "function" })),
    ));
  });
});
