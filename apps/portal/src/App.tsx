export interface PortalUrls {
  resident: string;
  family: string;
  staff: string;
}

interface AppProps {
  urls: PortalUrls;
}

const roles = [
  { key: "resident", label: "Resident", detail: "Daily support, calls, and care updates" },
  { key: "family", label: "Family", detail: "Stay connected and arrange visits" },
  { key: "staff", label: "Staff", detail: "Coordinate care and respond to requests" },
] as const;

export function App({ urls }: AppProps) {
  return (
    <main className="portal-shell">
      <section className="portal" aria-labelledby="portal-title">
        <header className="portal-heading">
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
              <a href={`${urls.staff}?mode=manager`}>Manager</a>
              <p>Open the staff app for management access</p>
            </li>
          </ul>
        </nav>

        <p className="access-note">Your access is confirmed after you sign in.</p>
      </section>
    </main>
  );
}
