import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../components/ui/Button";
import {
  formatBytes,
  formatCount,
  getLegendColor,
  getNodeDisplayType,
  type DiskAnalysisLegendItem,
} from "../lib/diskAnalysisClient";
import type {
  DiskAnalysisIssue,
  DiskAnalysisTreemapNode,
} from "@deckos/contracts";

type IssuesPageState = {
  query: string;
  page: number;
};

const ISSUES_PAGE_SIZE = 100;

export function SidebarStat({
  label,
  value,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "bad";
}) {
  return (
    <div className="disk-analysis-meta__row">
      <span className="disk-analysis-meta__label">{label}</span>
      <span
        className={`disk-analysis-meta__value${mono ? " disk-analysis-meta__value--mono" : ""}${
          tone === "bad" ? " disk-analysis-meta__value--bad" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="disk-analysis-detail-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function LegendRow({ item }: { item: DiskAnalysisLegendItem }) {
  return (
    <div className="disk-analysis-legend__row">
      <span
        className="disk-analysis-legend__swatch"
        style={{ background: getLegendColor(item.colorToken) }}
      />
      <span className="disk-analysis-legend__label">.{item.extension}</span>
      <span className="disk-analysis-legend__count">
        {formatBytes(item.totalBytes)} ({formatCount(item.count)})
      </span>
    </div>
  );
}

export function ScanIssuesModal({
  isOpen,
  issues,
  onClose,
}: {
  isOpen: boolean;
  issues: DiskAnalysisIssue[];
  onClose: () => void;
}) {
  const [pageState, setPageState] = useState<IssuesPageState>({
    query: "",
    page: 1,
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setPageState({
        query: "",
        page: 1,
      });
    }
  }, [isOpen]);

  const filteredIssues = useMemo(() => {
    const query = pageState.query.trim().toLowerCase();
    if (!query) {
      return issues;
    }
    return issues.filter((issue) =>
      [issue.code, issue.message, issue.path].some((value) =>
        value.toLowerCase().includes(query)
      )
    );
  }, [issues, pageState.query]);
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / ISSUES_PAGE_SIZE));
  const currentPage = Math.min(pageState.page, totalPages);
  const pagedIssues = filteredIssues.slice(
    (currentPage - 1) * ISSUES_PAGE_SIZE,
    currentPage * ISSUES_PAGE_SIZE
  );

  useEffect(() => {
    setPageState((current) =>
      current.page === currentPage ? current : { ...current, page: currentPage }
    );
  }, [currentPage]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="disk-analysis-modal" role="presentation">
      <button
        type="button"
        className="disk-analysis-modal__backdrop"
        aria-label="Close scan issues dialog"
        onClick={onClose}
      />
      <div className="disk-analysis-modal__dialog" role="dialog" aria-modal="true">
        <div className="disk-analysis-modal__header">
          <div>
            <div className="label">Disk Analysis</div>
            <h2 className="disk-analysis-modal__title">
              Scan Issues ({formatCount(issues.length)})
            </h2>
          </div>
          <Button variant="icon" onClick={onClose} aria-label="Close scan issues dialog">
            <X size={16} />
          </Button>
        </div>
        <div className="disk-analysis-modal__body">
          <div className="disk-analysis-modal__toolbar">
            <label className="disk-analysis-modal__search">
              <span className="label">Search Issues</span>
              <input
                type="search"
                value={pageState.query}
                onChange={(event) =>
                  setPageState({
                    query: event.target.value,
                    page: 1,
                  })
                }
                placeholder="Search code, path, or message"
              />
            </label>
            <div className="disk-analysis-modal__pagination">
              <span className="disk-analysis-modal__pagination-summary">
                {filteredIssues.length > 0
                  ? `${formatCount((currentPage - 1) * ISSUES_PAGE_SIZE + 1)}-${formatCount(
                      Math.min(currentPage * ISSUES_PAGE_SIZE, filteredIssues.length)
                    )} of ${formatCount(filteredIssues.length)}`
                  : "0 results"}
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  setPageState((current) => ({
                    ...current,
                    page: Math.max(1, current.page - 1),
                  }))
                }
                disabled={currentPage <= 1}
              >
                Prev
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  setPageState((current) => ({
                    ...current,
                    page: Math.min(totalPages, current.page + 1),
                  }))
                }
                disabled={currentPage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
          {issues.length > 0 ? (
            <div className="disk-analysis-issues__list">
              {pagedIssues.map((issue) => (
                <div
                  key={`${issue.code}:${issue.path}:${issue.message}`}
                  className="disk-analysis-issue"
                >
                  <div className="disk-analysis-issue__code">{issue.code}</div>
                  <div className="disk-analysis-issue__message">{issue.message}</div>
                  <div className="disk-analysis-issue__path">{issue.path}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="disk-analysis-sidebar-empty">No scan issues reported.</div>
          )}
          {issues.length > 0 && filteredIssues.length === 0 ? (
            <div className="disk-analysis-sidebar-empty">
              No scan issues match the current search.
            </div>
          ) : filteredIssues.length > ISSUES_PAGE_SIZE ? (
            <div className="disk-analysis-modal__page-indicator">
              Page {formatCount(currentPage)} of {formatCount(totalPages)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function HoverDetails({ hoveredNode }: { hoveredNode: DiskAnalysisTreemapNode | null }) {
  if (!hoveredNode) {
    return <div className="disk-analysis-sidebar-empty">Hover a block to inspect it.</div>;
  }

  return (
    <div className="disk-analysis-details__content">
      <div className="disk-analysis-details__name">{hoveredNode.name}</div>
      <div className="disk-analysis-details__type">{getNodeDisplayType(hoveredNode)}</div>
      <div className="disk-analysis-details__path">{hoveredNode.path}</div>
      <DetailRow label="Recursive Size" value={formatBytes(hoveredNode.recursiveSize)} />
      <DetailRow label="Children" value={formatCount(hoveredNode.childCount)} />
    </div>
  );
}
