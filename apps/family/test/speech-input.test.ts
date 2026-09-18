import { afterEach, expect, test, vi } from "vitest";
import { startDictation } from "../src/speech-input";

afterEach(() => vi.unstubAllGlobals());

test("release stops capture while preserving the browser's final transcript", () => {
  let recognition: any;
  class Recognition {
    lang = ""; interimResults = true; maxAlternatives = 0; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn();
    constructor() { recognition = this; }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  const onResult = vi.fn();
  const onEnd = vi.fn();
  const handle = startDictation("en-US", onResult, onEnd)!;

  handle.stop();
  recognition.onresult({ results: [[{ transcript: "bring tissues" }]] });
  recognition.onend();

  expect(onResult).toHaveBeenCalledWith("bring tissues");
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(recognition.stop).toHaveBeenCalledTimes(1);
});
