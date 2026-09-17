import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function Incoming({ callerName, onAnswer, onDecline, disabled = false }: { callerName: string; onAnswer: () => void; onDecline: () => void; disabled?: boolean }) {
  return <section className="screen screen--incoming">
    <svg viewBox="0 0 120 128" className="portrait portrait--xl" aria-hidden="true"><circle cx="60" cy="44" r="25" fill="#89734e"/><path d="M12 128v-12a48 48 0 0 1 96 0v12" fill="#89734e"/></svg>
    <h1>{t("resident.incoming.title", { name: callerName })}</h1>
    <BigButton onClick={onAnswer} disabled={disabled}>{t("resident.incoming.answer")}</BigButton>
    <button type="button" className="quiet-button" onClick={onDecline} disabled={disabled}>{t("resident.incoming.decline")}</button>
  </section>;
}
