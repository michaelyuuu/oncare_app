import { useEffect, useState, type FormEvent } from "react";
import { t, type Api } from "@oncare/web-common";
import type {
  GarmentResult,
  GarmentStatus,
  LaundryFreshness,
  LaundryOverview,
  LaundrySearch,
  LaundryWarning,
  LoadState,
} from "./types";

const RESULT_LIMIT = 20;
const REQUIRED_TOOLS = new Set(["get_laundry_overview", "find_garments"]);

type Filters = {
  residentId: string;
  name: string;
  category: string;
  color: string;
  status: "" | GarmentStatus;
};

const EMPTY_FILTERS: Filters = {
  residentId: "",
  name: "",
  category: "",
  color: "",
  status: "",
};

class MalformedLaundryResponse extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function naturalNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function warnings(value: unknown): LaundryWarning[] | null {
  if (!Array.isArray(value)) return null;
  const safe: LaundryWarning[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row || typeof row.kind !== "string") return null;
    safe.push({ kind: row.kind });
  }
  return safe;
}

function freshness(value: Record<string, unknown>): LaundryFreshness | null {
  const availability = value.availability;
  const syncedAt = value.syncedAt;
  const safeWarnings = warnings(value.warnings);
  if ((availability !== "available" && availability !== "never_synced")
      || typeof value.stale !== "boolean" || safeWarnings === null) return null;
  if (availability === "never_synced") {
    if (syncedAt !== null) return null;
  } else if (!validDate(syncedAt)) return null;
  return { availability, syncedAt, stale: value.stale, warnings: safeWarnings };
}

function parseOverview(value: unknown): LaundryOverview {
  const envelope = record(value);
  const result = envelope ? record(envelope.result) : null;
  const fresh = result ? freshness(result) : null;
  if (!result || !fresh || !naturalNumber(result.total)
      || !naturalNumber(result.active) || !naturalNumber(result.lostOrDiscarded)
      || !naturalNumber(result.recentlyWashed)) {
    throw new MalformedLaundryResponse();
  }
  return {
    ...fresh,
    total: result.total,
    active: result.active,
    lostOrDiscarded: result.lostOrDiscarded,
    recentlyWashed: result.recentlyWashed,
  };
}

function parseGarment(value: unknown): GarmentResult | null {
  const garment = record(value);
  if (!garment || typeof garment.residentId !== "string"
      || typeof garment.residentName !== "string" || typeof garment.name !== "string"
      || typeof garment.category !== "string" || typeof garment.color !== "string"
      || (garment.status !== "active" && garment.status !== "lost"
        && garment.status !== "discarded")
      || !naturalNumber(garment.washCount)
      || (garment.lastSeen !== null && !validDate(garment.lastSeen))
      || !validDate(garment.syncedAt) || typeof garment.stale !== "boolean") return null;
  return {
    residentId: garment.residentId,
    residentName: garment.residentName,
    name: garment.name,
    category: garment.category,
    color: garment.color,
    status: garment.status,
    washCount: garment.washCount,
    lastSeen: garment.lastSeen,
    syncedAt: garment.syncedAt,
    stale: garment.stale,
  };
}

function parseSearch(value: unknown): LaundrySearch {
  const envelope = record(value);
  const result = envelope ? record(envelope.result) : null;
  const fresh = result ? freshness(result) : null;
  if (!result || !fresh || !Array.isArray(result.garments)
      || result.garments.length > RESULT_LIMIT) throw new MalformedLaundryResponse();
  const garments = result.garments.map(parseGarment);
  if (garments.some((garment) => garment === null)) throw new MalformedLaundryResponse();
  return { ...fresh, garments: garments as GarmentResult[] };
}

function validateTools(value: unknown): void {
  const catalog = record(value);
  if (!catalog || !Array.isArray(catalog.tools)) throw new MalformedLaundryResponse();
  const names = new Set(catalog.tools.map((tool) => record(tool)?.name));
  if ([...REQUIRED_TOOLS].some((name) => !names.has(name))) {
    throw new MalformedLaundryResponse();
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function requestStatus(error: unknown): number | null {
  const value = record(error);
  return value && typeof value.status === "number" ? value.status : null;
}

function warningText(kind: string): string {
  const known: Record<string, string> = {
    wash_history_unavailable: "admin.laundry.warning.wash_history",
    station_unavailable: "admin.laundry.warning.station",
    invalid_data: "admin.laundry.warning.invalid",
    station_identity_mismatch: "admin.laundry.warning.identity",
  };
  return t(known[kind] ?? "admin.laundry.warning.other");
}

function FreshnessRail({ value, label }: {
  value: LoadState<LaundryFreshness>;
  label: string;
}) {
  let state = t("admin.laundry.freshness.checking");
  let time = t("admin.laundry.freshness.pending");
  let tone = "";
  if (value.kind === "error") {
    state = t("admin.laundry.freshness.unavailable");
    time = t("admin.laundry.freshness.unknown");
    tone = " freshness-problem";
  } else if (value.kind === "ready") {
    if (value.value.availability === "never_synced") {
      state = t("admin.laundry.freshness.never");
      time = t("admin.laundry.freshness.no_time");
      tone = " freshness-problem";
    } else {
      state = value.value.stale
        ? t("admin.laundry.freshness.stale")
        : t("admin.laundry.freshness.current");
      time = formatTime(value.value.syncedAt!);
      tone = value.value.stale ? " freshness-problem" : "";
    }
  }
  return <div className={`laundry-freshness${tone}`} aria-label={label}>
    <strong>{state}</strong>
    <span>{time}</span>
  </div>;
}

function SafeWarnings({ items }: { items: LaundryWarning[] }) {
  if (items.length === 0) return null;
  return <ul className="laundry-warnings">
    {items.map((warning, index) => <li key={`${warning.kind}-${index}`}>
      {warningText(warning.kind)}
    </li>)}
  </ul>;
}

export function LaundryAI({ api }: { api: Api }) {
  const [overview, setOverview] = useState<LoadState<LaundryOverview>>({ kind: "loading" });
  const [search, setSearch] = useState<LoadState<LaundrySearch>>({ kind: "idle" });
  const [assistant, setAssistant] = useState<LoadState<string>>({ kind: "idle" });
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [question, setQuestion] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<unknown>("/tools"),
      api.post<unknown>("/tools/get_laundry_overview/invoke", {}),
    ]).then(([catalog, response]) => {
      validateTools(catalog);
      const value = parseOverview(response);
      if (active) setOverview({ kind: "ready", value });
    }).catch((error: unknown) => {
      if (!active) return;
      setOverview({
        kind: "error",
        message: error instanceof MalformedLaundryResponse
          ? t("admin.laundry.error.malformed")
          : t("admin.laundry.error.overview"),
      });
    });
    return () => { active = false; };
  }, [api]);

  function changeFilter(name: keyof Filters, value: string) {
    setFilters((current) => ({ ...current, [name]: value } as Filters));
  }

  async function findGarments(event: FormEvent) {
    event.preventDefault();
    setSearch({ kind: "loading" });
    const body = Object.fromEntries(Object.entries(filters)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value !== ""));
    try {
      const response = await api.post<unknown>("/tools/find_garments/invoke", body);
      setSearch({ kind: "ready", value: parseSearch(response) });
    } catch (error) {
      setSearch({
        kind: "error",
        message: error instanceof MalformedLaundryResponse
          ? t("admin.laundry.error.malformed_search")
          : t("admin.laundry.error.search"),
      });
    }
  }

  async function askAssistant(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setAssistant({ kind: "loading" });
    try {
      const response = record(await api.post<unknown>("/admin/laundry/ask", {
        question: trimmed,
      }));
      if (!response || typeof response.answer !== "string") {
        throw new MalformedLaundryResponse();
      }
      setAssistant({ kind: "ready", value: response.answer });
    } catch (error) {
      setAssistant({
        kind: "error",
        message: requestStatus(error) === 503
          ? t("admin.laundry.assistant.unavailable")
          : t("admin.laundry.assistant.error"),
      });
    }
  }

  return <section className="laundry-ai" aria-labelledby="laundry-ai-title">
    <header className="laundry-heading">
      <div>
        <h2 id="laundry-ai-title">{t("admin.laundry.title")}</h2>
        <p>{t("admin.laundry.intro")}</p>
      </div>
      <FreshnessRail value={overview} label={t("admin.laundry.freshness.overview_aria")} />
    </header>

    {overview.kind === "loading" && <p role="status">{t("admin.laundry.loading")}</p>}
    {overview.kind === "error" && <p role="alert">{overview.message}</p>}
    {overview.kind === "ready" && <div className="laundry-overview-notices"
      role="status" aria-live="polite" aria-atomic="true"
      aria-label={t("admin.laundry.notices.aria")}>
        {overview.value.availability === "never_synced"
          ? <p className="laundry-notice">{t("admin.laundry.never_synced")}</p>
          : <>
            {overview.value.stale
              && <p className="laundry-notice">{t("admin.laundry.stale")}</p>}
            {overview.value.total === 0
              && <p className="laundry-empty">{t("admin.laundry.zero")}</p>}
          </>}
        <SafeWarnings items={overview.value.warnings} />
      </div>}

    <form className="laundry-question" onSubmit={(event) => void askAssistant(event)}>
      <label htmlFor="laundry-question">{t("admin.laundry.question.label")}</label>
      <div>
        <input id="laundry-question" value={question} maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={t("admin.laundry.question.placeholder")} />
        <button disabled={!question.trim() || assistant.kind === "loading"}>
          {assistant.kind === "loading" ? t("admin.laundry.question.asking") : t("admin.laundry.question.ask")}
        </button>
      </div>
      {assistant.kind === "ready" && <p className="laundry-answer">{assistant.value}</p>}
      {assistant.kind === "error" && <p className="laundry-assistant-error" role="status">
        {assistant.message}
      </p>}
    </form>

    {overview.kind === "ready" && <dl className="laundry-ledger" aria-label={t("admin.laundry.metrics.aria")}>
      <div><dt>{t("admin.laundry.metrics.total")}</dt><dd>{overview.value.total}</dd></div>
      <div><dt>{t("admin.laundry.metrics.active")}</dt><dd>{overview.value.active}</dd></div>
      <div><dt>{t("admin.laundry.metrics.lost")}</dt><dd>{overview.value.lostOrDiscarded}</dd></div>
      <div><dt>{t("admin.laundry.metrics.washed")}</dt><dd>{overview.value.recentlyWashed}</dd></div>
    </dl>}

    <form className="laundry-filters" onSubmit={(event) => void findGarments(event)}>
      <label>{t("admin.laundry.filters.resident")}<input value={filters.residentId}
        onChange={(event) => changeFilter("residentId", event.target.value)} /></label>
      <label>{t("admin.laundry.filters.name")}<input value={filters.name} maxLength={100}
        onChange={(event) => changeFilter("name", event.target.value)} /></label>
      <label>{t("admin.laundry.filters.category")}<input value={filters.category} maxLength={50}
        onChange={(event) => changeFilter("category", event.target.value)} /></label>
      <label>{t("admin.laundry.filters.color")}<input value={filters.color} maxLength={50}
        onChange={(event) => changeFilter("color", event.target.value)} /></label>
      <label>{t("admin.laundry.filters.status")}<select value={filters.status}
        onChange={(event) => changeFilter("status", event.target.value)}>
        <option value="">{t("admin.laundry.filters.any_status")}</option>
        <option value="active">{t("admin.laundry.status.active")}</option>
        <option value="lost">{t("admin.laundry.status.lost")}</option>
        <option value="discarded">{t("admin.laundry.status.discarded")}</option>
      </select></label>
      <button disabled={search.kind === "loading"}>
        {search.kind === "loading" ? t("admin.laundry.filters.finding") : t("admin.laundry.filters.find")}
      </button>
    </form>

    <div className="laundry-results" aria-live="polite">
      {search.kind === "idle" && <p className="laundry-empty">{t("admin.laundry.results.start")}</p>}
      {search.kind === "error" && <p role="alert">{search.message}</p>}
      {search.kind === "ready" && <>
        <div className="laundry-search-freshness">
          <FreshnessRail value={{ kind: "ready", value: search.value }}
            label={t("admin.laundry.freshness.search_aria")} />
        </div>
        <SafeWarnings items={search.value.warnings} />
        {search.value.availability === "never_synced"
          ? <p className="laundry-notice">{t("admin.laundry.never_synced")}</p>
          : search.value.garments.length === 0
            ? <p className="laundry-empty">{t("admin.laundry.results.empty")}</p>
            : <>
              <p className="laundry-result-count">{search.value.garments.length === RESULT_LIMIT
                ? t("admin.laundry.results.limit")
                : t("admin.laundry.results.count", { count: search.value.garments.length })}</p>
              <div className="table-scroll"><table>
                <caption>{t("admin.laundry.results.caption")}</caption>
                <thead><tr>
                  <th>{t("admin.laundry.table.resident")}</th>
                  <th>{t("admin.laundry.table.garment")}</th>
                  <th>{t("admin.laundry.table.details")}</th>
                  <th>{t("admin.laundry.table.status")}</th>
                  <th>{t("admin.laundry.table.washes")}</th>
                  <th>{t("admin.laundry.table.last_seen")}</th>
                  <th>{t("admin.laundry.table.freshness")}</th>
                </tr></thead>
                <tbody>{search.value.garments.map((garment, index) => <tr key={`${garment.residentId}-${garment.name}-${index}`}>
                  <td>{garment.residentName}</td>
                  <td>{garment.name}</td>
                  <td>{garment.color}, {garment.category}</td>
                  <td>{t(`admin.laundry.status.${garment.status}`)}</td>
                  <td>{garment.washCount}</td>
                  <td>{garment.lastSeen ? formatTime(garment.lastSeen) : t("admin.laundry.table.not_seen")}</td>
                  <td>{garment.stale ? t("admin.laundry.freshness.stale") : t("admin.laundry.freshness.current")}<br />
                    <time dateTime={garment.syncedAt}>{formatTime(garment.syncedAt)}</time></td>
                </tr>)}</tbody>
              </table></div>
            </>}
      </>}
    </div>
  </section>;
}
