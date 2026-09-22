import { useState } from "react";

export function AssistantActionConfirmation({
  actionId,
  summary,
  expiresAt,
  onConfirm,
  onCancel,
}: {
  actionId: string;
  summary: string;
  expiresAt: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const expiry = new Date(expiresAt);
  const expiryLabel = Number.isNaN(expiry.getTime())
    ? expiresAt
    : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(expiry);

  const choose = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return <div
    className="communication-fallback"
    role="group"
    aria-label="Visit scheduling confirmation"
    data-action-id={actionId}
    style={{ bottom: "92px", zIndex: 7, gap: "14px", padding: "18px" }}
  >
    <p style={{ margin: 0, color: "var(--communication-ink)", fontSize: "clamp(18px, 2.2vw, 24px)", fontWeight: 800, lineHeight: 1.35 }}>
      {summary}
    </p>
    <p style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>
      Expires at <time dateTime={expiresAt}>{expiryLabel}</time>
    </p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" }}>
      <button
        type="button"
        className="communication-solid"
        style={{ minWidth: 0, minHeight: "64px" }}
        disabled={busy}
        onClick={() => void choose(onConfirm)}
      >
        Confirm
      </button>
      <button
        type="button"
        className="communication-solid"
        style={{ minWidth: 0, minHeight: "64px", background: "#6f625a" }}
        disabled={busy}
        onClick={() => void choose(onCancel)}
      >
        Cancel
      </button>
    </div>
  </div>;
}
