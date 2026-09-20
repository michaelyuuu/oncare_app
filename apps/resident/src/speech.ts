export function speak(text: string, lang = "en-US"): void {
  if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
  try {
    stopSpeaking();
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = lang;
    speechSynthesis.speak(utterance);
  } catch { /* Speech is best effort on kiosk browsers. */ }
}

export function stopSpeaking(): void {
  try { globalThis.speechSynthesis?.cancel(); } catch { /* Speech is best effort on kiosk browsers. */ }
}
