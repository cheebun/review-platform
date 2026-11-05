"use client";

import {
  REVIEW_AUTHOR_LABELS,
  REVIEW_AUTHORS,
} from "@/lib/repos";
import { useReviewPageContext } from "./ReviewPageProvider";

export function AuthorFilter() {
  const {
    authorFilter,
    setAuthorFilter,
    authorCounts,
    totalCount,
    busy,
    refreshing,
  } = useReviewPageContext();
  const disabled = busy || refreshing;

  return (
    <div className="author-filter">
      <span className="author-filter-label">筛选人员：</span>
      <div className="author-filter-chips">
        <button
          type="button"
          className={`author-chip${authorFilter === "all" ? " is-active" : ""}`}
          disabled={disabled}
          onClick={() => setAuthorFilter("all")}
        >
          全部 {totalCount}
        </button>
        {REVIEW_AUTHORS.filter((author) => authorCounts[author] > 0).map(
          (author) => (
            <button
              key={author}
              type="button"
              className={`author-chip${authorFilter === author ? " is-active" : ""}`}
              disabled={disabled}
              onClick={() => setAuthorFilter(author)}
            >
              {REVIEW_AUTHOR_LABELS[author]} {authorCounts[author]}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
