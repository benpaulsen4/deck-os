import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}

function TopBar() {
  const trpc = useTRPC();
  const { data: systemInfo } = useQuery(trpc.system.getInfo.queryOptions());

  const hostname = systemInfo?.hostname || "DECKOS";

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-logo">DECKOS</div>
        <nav className="topbar-nav">
          <Link to="/" className="topbar-link" activeProps={{ className: "topbar-link topbar-link--active" }}>
            Dashboard
          </Link>
          <Link to="/apps" className="topbar-link" activeProps={{ className: "topbar-link topbar-link--active" }}>
            Apps
          </Link>
          <Link to="/settings" className="topbar-link" activeProps={{ className: "topbar-link topbar-link--active" }}>
            Settings
          </Link>
        </nav>
        <div className="topbar-host">{hostname}</div>
      </div>
    </header>
  );
}
