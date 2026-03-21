import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useAppStatus } from "../hooks/useAppStatus";
import { ToastContainer } from "../components/layout/ToastContainer";
import { RouteErrorComponent } from "../components/ui/RouteErrorComponent";
import { useAuthGate } from "../hooks/useAuthGate";
import { AuthGateScreen } from "../components/auth/AuthGateScreen";
import { TopBar } from "../components/layout/TopBar";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorComponent,
});

function RootLayout() {
  const {
    authChecking,
    authEnabled,
    authUnlocked,
    pin,
    setPin,
    unlockError,
    unlocking,
    retryAfterMs,
    handleUnlock,
    handleLock,
  } = useAuthGate();

  useAppStatus({
    enabled: !authChecking && (!authEnabled || authUnlocked),
  });

  if (authChecking || (authEnabled && !authUnlocked)) {
    return (
      <AuthGateScreen
        authChecking={authChecking}
        authEnabled={authEnabled}
        authUnlocked={authUnlocked}
        pin={pin}
        unlocking={unlocking}
        retryAfterMs={retryAfterMs}
        unlockError={unlockError}
        onPinChange={setPin}
        onUnlock={() => {
          void handleUnlock();
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar authEnabled={authEnabled} onLock={handleLock} />
      <main className="app-content">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  );
}
