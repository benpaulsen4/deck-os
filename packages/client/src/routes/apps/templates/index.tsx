import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../../trpc";
import { AppIcon } from "../../../components/ui/AppIcon";
import { Input } from "../../../components/ui/Input";
import { Button } from "../../../components/ui/Button";

export const Route = createFileRoute("/apps/templates/")({
  component: TemplatesStorefrontPage,
});

function TemplatesStorefrontPage() {
  const trpc = useTRPC();

  const [queryText, setQueryText] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [cardHeightPx, setCardHeightPx] = useState(190);
  const gridViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(queryText.trim());
    }, 250);
    return () => window.clearTimeout(handle);
  }, [queryText]);

  useEffect(() => {
    setPage(1);
  }, [query, category]);

  useEffect(() => {
    const el = gridViewportRef.current;
    if (!el) return;

    const minCardWidth = 260;
    const gap = 16;
    const minCardHeight = 220;

    const compute = () => {
      const width = Math.max(0, el.clientWidth);
      const height = Math.max(0, el.clientHeight);
      if (width <= 0 || height <= 0) return;

      const columns = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
      const rows = Math.max(1, Math.floor((height + gap) / (minCardHeight + gap)));
      const heightPx = Math.max(minCardHeight, (height - gap * (rows - 1)) / rows);
      const next = Math.min(100, Math.max(1, rows * columns));

      setPageSize((prev) => (prev === next ? prev : next));
      setCardHeightPx((prev) => (Math.abs(prev - heightPx) < 0.5 ? prev : heightPx));
      setPage((prev) => (prev < 1 ? 1 : prev));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener("resize", compute);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, []);

  const listInput = useMemo(
    () => ({ query, category, page, pageSize }),
    [query, category, page, pageSize]
  );

  const { data, isLoading } = useQuery({
    ...trpc.templates.list.queryOptions(listInput),
    placeholderData: (prev) => prev,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const categories = data?.categories ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (!data) return;
    setPage((p) => Math.min(p, totalPages));
  }, [data, totalPages]);

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: "var(--space-2)",
  };

  const cardStyle: React.CSSProperties = {
    padding: "var(--space-2)",
    display: "grid",
    gridTemplateColumns: "48px 1fr",
    gap: "var(--space-2)",
    alignItems: "start",
    height: `${cardHeightPx.toFixed(2)}px`,
    overflow: "hidden",
  };

  const titleStyle: React.CSSProperties = {
    fontSize: "var(--text-md)",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-primary)",
    lineHeight: 1.2,
  };

  const descStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "4px",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
  };

  const tagRowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginTop: "6px",
  };

  const tagStyle: React.CSSProperties = {
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-primary)",
    padding: "2px 6px",
    background: "var(--bg-tertiary)",
  };

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Template Store</h1>
        <Link to="/apps" className="page-header-action">
          BACK TO APPS
        </Link>
      </div>

      <div
        className="page-body"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      >
        <div className="panel" style={{ padding: "var(--space-2)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: "8px" }}>
            <Input
              label="SEARCH"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="jellyfin, media, dns..."
            />
            <div>
              <label
                className="label"
                htmlFor="templates-category-filter"
                style={{ marginBottom: "4px" }}
              >
                CATEGORY
              </label>
              <select
                id="templates-category-filter"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={{
                  width: "100%",
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-primary)",
                  color: "var(--text-primary)",
                  padding: "8px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-base)",
                  minHeight: "40px",
                }}
              >
                <option value="">ALL</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          ref={gridViewportRef}
          className={isLoading ? "loading-scan" : undefined}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          {items.length === 0 && !isLoading ? (
            <div className="panel" style={{ padding: "var(--space-6)" }}>
              <div className="app-launcher-empty">
                NO TEMPLATES FOUND
                <br />
                <span style={{ color: "var(--text-muted)" }}>
                  TRY CLEARING SEARCH OR CATEGORY
                </span>
              </div>
            </div>
          ) : (
            <div style={gridStyle}>
              {items.map((t) => (
                <div key={t.id} className="panel" style={cardStyle}>
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      display: "grid",
                      placeItems: "center",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)",
                      color: "var(--text-secondary)",
                      fontSize: "var(--text-lg)",
                      fontWeight: 700,
                    }}
                  >
                    <AppIcon
                      name={t.title}
                      src={t.icon}
                      imgStyle={{ width: 32, height: 32, objectFit: "contain" }}
                    />
                  </div>
                  <div
                    style={{
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                    }}
                  >
                    <div style={titleStyle}>{t.title}</div>
                    <div style={descStyle}>{t.description}</div>
                    <div style={tagRowStyle}>
                      {(t.categories ?? []).slice(0, 3).map((c) => (
                        <span key={c} style={tagStyle}>
                          {c}
                        </span>
                      ))}
                    </div>
                    <div
                      style={{
                        marginTop: "auto",
                        display: "flex",
                        justifyContent: "flex-end",
                      }}
                    >
                      <Link
                        to="/apps/templates/$templateId"
                        params={{ templateId: t.id }}
                      >
                        <Button type="button" variant="secondary">
                          DEPLOY
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className="panel"
          style={{
            padding: "var(--space-2)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div className="label">
            PAGE {page} / {totalPages}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Button
              type="button"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              PREV
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              NEXT
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
