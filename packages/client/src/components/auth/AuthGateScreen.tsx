import { PinEntry } from "./PinEntry";
import { Button } from "../ui/Button";

interface AuthGateScreenProps {
  authChecking: boolean;
  authEnabled: boolean;
  authUnlocked: boolean;
  pin: string;
  unlocking: boolean;
  retryAfterMs: number;
  unlockError: string | null;
  onPinChange: (value: string) => void;
  onUnlock: () => void;
}

export function AuthGateScreen({
  authChecking,
  authEnabled,
  authUnlocked,
  pin,
  unlocking,
  retryAfterMs,
  unlockError,
  onPinChange,
  onUnlock,
}: AuthGateScreenProps) {
  if (authChecking) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="label">LOADING SECURITY STATUS...</div>
        </div>
      </div>
    );
  }

  if (!authEnabled || authUnlocked) {
    return null;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">UNLOCK DECKOS</h1>
        <div className="auth-subtitle">Enter your passcode to continue</div>
        <PinEntry
          value={pin}
          onChange={onPinChange}
          onSubmit={onUnlock}
          autoFocus
          disabled={unlocking}
        />
        <div className="auth-actions">
          <Button
            onClick={onUnlock}
            disabled={pin.length < 4 || unlocking || retryAfterMs > 0}
          >
            {unlocking ? "UNLOCKING..." : "UNLOCK"}
          </Button>
        </div>
        {retryAfterMs > 0 && (
          <div className="auth-message auth-message--warning">
            Retry in {Math.ceil(retryAfterMs / 1000)}s
          </div>
        )}
        {unlockError && (
          <div className="auth-message auth-message--error">{unlockError}</div>
        )}
      </div>
    </div>
  );
}
