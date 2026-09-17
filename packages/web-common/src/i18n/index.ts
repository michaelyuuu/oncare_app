import en from "./en.json";

export type Locale = "en";

const tables: Record<Locale, Record<string, string>> = { en };
let current: Locale = "en";

export function setLocale(locale: Locale): void {
  current = locale;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const raw = tables[current][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, variable: string) => variable in vars ? String(vars[variable]) : `{${variable}}`);
}
