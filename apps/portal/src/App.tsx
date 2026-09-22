export interface PortalUrls {
  resident: string;
  family: string;
  staff: string;
}

interface AppProps {
  demo?: boolean;
  urls: PortalUrls;
}

const roles = [
  { key: "resident", label: "Resident", detail: "Daily support, calls, and care updates" },
  { key: "family", label: "Family", detail: "Stay connected and arrange visits" },
  { key: "staff", label: "Staff", detail: "Coordinate care and respond to requests" },
] as const;

function managerDestination(staffUrl: string) {
  const url = new URL(staffUrl);
  url.searchParams.set("mode", "manager");

  const suffixIndexes = [staffUrl.indexOf("?"), staffUrl.indexOf("#")].filter((index) => index >= 0);
  const baseEnd = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : staffUrl.length;
  return `${staffUrl.slice(0, baseEnd)}${url.search}${url.hash}`;
}

export function App({ demo = false, urls }: AppProps) {
  return (
    <main className="portal-shell">
      <section className="portal" aria-labelledby="portal-title">
        <header className="portal-heading">
          {demo && <p className="demo-badge">SIMULATED</p>}
          <p className="wordmark">OnCare</p>
          <h1 id="portal-title">Choose your OnCare space</h1>
          <p className="introduction">Select where you want to go. You will sign in on the next page.</p>
        </header>

        <nav aria-label="OnCare applications">
          <ul className="role-list">
            {roles.map((role) => (
              <li key={role.key} className="role">
                <a href={urls[role.key]}>{role.label}</a>
                <p>{role.detail}</p>
              </li>
            ))}
            <li className="role">
              <a href={managerDestination(urls.staff)}>Manager</a>
              <p>Open the staff app for management access</p>
            </li>
          </ul>
        </nav>

        <p className="access-note">Your access is confirmed after you sign in.</p>
      </section>
    </main>
  );
}
