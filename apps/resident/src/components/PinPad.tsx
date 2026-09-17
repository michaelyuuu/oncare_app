import { useState } from "react";
import { t } from "@oncare/web-common";
export function PinPad({ onSubmit, disabled }: { onSubmit: (pin: string) => void; disabled: boolean }) {
  const [pin, setPin] = useState("");
  const press = (digit: string) => {
    if (disabled) return;
    const next = pin + digit;
    if (next.length === 4) { setPin(""); onSubmit(next); } else setPin(next);
  };
  return <div className="pin-pad" role="group" aria-label={t("resident.settings.pin_label")}>
    <output className="pin-dots" aria-label={t("resident.settings.pin_digits", { count: pin.length })}>{t("resident.settings.pin_mask", { dots: "●".repeat(pin.length) })}</output>
    {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "backspace"].map((digit) => digit === "" ? <span key="spacer"/> : <button type="button" className="pin-key" disabled={disabled} key={digit} aria-label={t(`resident.settings.key.${digit}`)} onClick={() => digit === "backspace" ? setPin(pin.slice(0, -1)) : press(digit)}>{t(`resident.settings.key.${digit}`)}</button>)}
  </div>;
}
