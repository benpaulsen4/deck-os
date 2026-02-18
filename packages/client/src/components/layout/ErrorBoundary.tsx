import React, { Component, ErrorInfo } from "react";
import { RefreshCw, Home } from "lucide-react";
import { Button } from "../ui/Button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    const { hasError, error, errorInfo } = this.state;
    const { children } = this.props;

    if (!hasError) {
      return children;
    }

    const containerStyle: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      padding: "var(--space-6)",
      background: "var(--bg-primary)",
      color: "var(--text-primary)",
      fontFamily: "var(--font-mono)",
    };

    const errorBoxStyle: React.CSSProperties = {
      maxWidth: "600px",
      width: "100%",
      background: "var(--bg-secondary)",
      border: "1px solid var(--status-stopped)",
      padding: "var(--space-4)",
    };

    const titleStyle: React.CSSProperties = {
      fontSize: "var(--text-xl)",
      fontWeight: 700,
      color: "var(--status-stopped)",
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      marginBottom: "var(--space-3)",
    };

    const messageStyle: React.CSSProperties = {
      fontSize: "var(--text-sm)",
      color: "var(--text-secondary)",
      marginBottom: "var(--space-3)",
    };

    const stackTraceStyle: React.CSSProperties = {
      background: "var(--bg-primary)",
      padding: "var(--space-2)",
      fontSize: "var(--text-xs)",
      color: "var(--text-muted)",
      fontFamily: "var(--font-mono)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      marginBottom: "var(--space-4)",
      maxHeight: "200px",
      overflow: "auto",
    };

    const actionsStyle: React.CSSProperties = {
      display: "flex",
      gap: "var(--space-2)",
    };

    return (
      <div style={containerStyle}>
        <div style={errorBoxStyle}>
          <h1 style={titleStyle}>System Error</h1>
          <p style={messageStyle}>
            Something went wrong. The application encountered an unexpected error.
          </p>

          {error && (
            <div style={{ marginBottom: "var(--space-2)" }}>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                }}
              >
                ERROR MESSAGE:
              </div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--status-stopped)" }}>
                {error.message}
              </div>
            </div>
          )}

          {errorInfo && (
            <div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                }}
              >
                STACK TRACE:
              </div>
              <div style={stackTraceStyle}>{errorInfo.componentStack}</div>
            </div>
          )}

          <div style={actionsStyle}>
            <Button variant="primary" onClick={this.handleReset}>
              <RefreshCw size={16} style={{ marginRight: "8px" }} />
              RELOAD
            </Button>
            <Button variant="secondary" onClick={() => (window.location.href = "/")}>
              <Home size={16} style={{ marginRight: "8px" }} />
              HOME
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
