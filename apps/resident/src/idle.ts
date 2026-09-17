import { useEffect, useRef } from "react";
export function useIdleReturn(ms: number, onIdle: () => void, enabled: boolean): void {
  const callback = useRef(onIdle);
  callback.current = onIdle;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => callback.current(), ms); };
    reset();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => { clearTimeout(timer); window.removeEventListener("pointerdown", reset); window.removeEventListener("keydown", reset); };
  }, [ms, enabled]);
}
