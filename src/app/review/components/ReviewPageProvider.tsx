"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useReviewPage } from "../hooks/use-review-page";

type ReviewPageContextValue = ReturnType<typeof useReviewPage>;

const ReviewPageContext = createContext<ReviewPageContextValue | null>(null);

export function ReviewPageProvider({ children, loadOpenPullsOnMount = true }: {
  children: ReactNode;
  loadOpenPullsOnMount?: boolean;
}) {
  const value = useReviewPage(loadOpenPullsOnMount);
  return (
    <ReviewPageContext.Provider value={value}>
      {children}
    </ReviewPageContext.Provider>
  );
}

export function useReviewPageContext() {
  const ctx = useContext(ReviewPageContext);
  if (!ctx) {
    throw new Error("useReviewPageContext must be used within ReviewPageProvider");
  }
  return ctx;
}
