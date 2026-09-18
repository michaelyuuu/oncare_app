type RecognitionEvent = { results?: ArrayLike<ArrayLike<{ transcript?: unknown }>> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const speechGlobal = globalThis as typeof globalThis & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition;
}

export function dictationAvailable(): boolean {
  return Boolean(recognitionConstructor());
}

export function startDictation(
  lang: string,
  onResult: (text: string) => void,
  onEnd: () => void,
): { stop(): void } | null {
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;
  const recognition = new Recognition();
  let ended = false;
  let stopping = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    onEnd();
  };
  recognition.lang = lang;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (typeof transcript === "string" && transcript.trim()) onResult(transcript.trim());
  };
  recognition.onend = finish;
  recognition.onerror = finish;
  recognition.start();
  return {
    stop() {
      if (stopping || ended) return;
      stopping = true;
      recognition.stop();
    },
  };
}
