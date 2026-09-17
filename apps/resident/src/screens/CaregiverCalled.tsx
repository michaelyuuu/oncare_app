import { t } from "@oncare/web-common";
export function CaregiverCalled() { return <section className="screen screen--caregiver"><svg className="confirmation" aria-hidden="true" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45"/><path d="m26 50 16 16 32-34"/></svg><h1>{t("resident.caregiver.title")}</h1></section>; }
