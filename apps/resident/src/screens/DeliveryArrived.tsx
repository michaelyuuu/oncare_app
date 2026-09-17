import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function DeliveryArrived({ itemLabel, onReceived }: { itemLabel: string; onReceived: () => void }) {
  return <section className="screen screen--delivery"><h1>{t("resident.delivery.title", { item: itemLabel })}</h1><BigButton onClick={onReceived}>{t("resident.delivery.received")}</BigButton></section>;
}
