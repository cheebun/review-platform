"use client";

import { useGithubAccount } from "@/components/AccountSwitcher";
import { ACCOUNT_HEADER } from "@/lib/accounts";
import {
  REVIEW_AUTHORS,
  buildOwnPrCopyText,
  shouldMergeAfterShip,
  type ReviewAuthor,
} from "@/lib/repos";
import type { ExecuteResult, OpenPrItem } from "@/lib/types";
import { App } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isCleanSuccess,
  successToastMessage,
  type ListState,
  type UiState,
} from "../lib/review-ui";

export function useReviewPage(loadOpenPullsOnMount = true) {
  const { account } = useGithubAccount();
  const { message } = App.useApp();
  const [state, setState] = useState<UiState>({ status: "idle" });
  const [listState, setListState] = useState<ListState>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [mergingUrl, setMergingUrl] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<ReviewAuthor | "all">("all");
  const hasLoadedRef = useRef(false);

  const loadOpenPulls = useCallback(async () => {
    if (hasLoadedRef.current) {
      setRefreshing(true);
    }
    try {
      const response = await fetch("/api/pulls/open", {
        headers: { [ACCOUNT_HEADER]: account },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `请求失败 (${response.status})`);
      }
      hasLoadedRef.current = true;
      setListState({ status: "ready", items: (data.items ?? []) as OpenPrItem[] });
    } catch (error) {
      setListState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshing(false);
    }
  }, [account]);

  useEffect(() => {
    if (loadOpenPullsOnMount) void loadOpenPulls();
  }, [loadOpenPulls, loadOpenPullsOnMount]);

  const authorCounts = useMemo(() => {
    const counts = Object.fromEntries(
      REVIEW_AUTHORS.map((author) => [author, 0]),
    ) as Record<ReviewAuthor, number>;
    if (listState.status !== "ready") return counts;
    for (const item of listState.items) {
      if ((REVIEW_AUTHORS as readonly string[]).includes(item.author)) {
        counts[item.author as ReviewAuthor] += 1;
      }
    }
    return counts;
  }, [listState]);

  const totalCount = useMemo(
    () => Object.values(authorCounts).reduce((sum, n) => sum + n, 0),
    [authorCounts],
  );

  const visibleItems = useMemo(() => {
    if (listState.status !== "ready") return [];
    if (authorFilter === "all") return listState.items;
    return listState.items.filter(
      (item) => item.author.toLowerCase() === authorFilter.toLowerCase(),
    );
  }, [listState, authorFilter]);

  // If the selected author drops to 0 after refresh, fall back to all.
  useEffect(() => {
    if (authorFilter === "all") return;
    if (authorCounts[authorFilter] === 0) {
      setAuthorFilter("all");
    }
  }, [authorFilter, authorCounts]);

  async function runShip(url: string) {
    setState({ status: "running", url });
    try {
      let sessionId: string | undefined;
      let result: ExecuteResult;
      for (;;) {
        const response = await fetch("/api/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [ACCOUNT_HEADER]: account,
          },
          body: JSON.stringify({ url, sessionId }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || `请求失败 (${response.status})`);
        }
        if (response.status !== 202) {
          result = data as ExecuteResult;
          break;
        }
        if (typeof data.sessionId !== "string") throw new Error("审查续跑响应无效");
        sessionId = data.sessionId;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      void loadOpenPulls();
      if (isCleanSuccess(result)) {
        message.success(successToastMessage(result));
        setState({ status: "idle" });
        return;
      }
      setState({ status: "result", result });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runMerge(url: string) {
    setMergingUrl(url);
    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ACCOUNT_HEADER]: account,
        },
        body: JSON.stringify({ url, mode: "merge" }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `请求失败 (${response.status})`);
      }
      void loadOpenPulls();
      message.success("已 Merge");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMergingUrl(null);
    }
  }

  async function runForceApproveMerge() {
    if (state.status !== "result") return;
    const url = state.result.pr.htmlUrl;
    setForcing(true);
    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ACCOUNT_HEADER]: account,
        },
        body: JSON.stringify({ url, mode: "force_approve" }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `请求失败 (${response.status})`);
      }
      const result = data as ExecuteResult;
      void loadOpenPulls();
      setState({ status: "idle" });
      if (result.merged) {
        message.success("已强制 Approve + Merge");
      } else if (result.approved) {
        message.success(
          shouldMergeAfterShip(result.pr.author)
            ? "已强制 Approve，但 Merge 未成功"
            : "已强制 Approve（未 Merge）",
        );
      } else {
        message.warning("强制操作未完成");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setForcing(false);
    }
  }

  async function copyOwnPr(htmlUrl: string, title: string) {
    try {
      await navigator.clipboard.writeText(buildOwnPrCopyText(htmlUrl, title));
      message.success("已复制");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "复制失败");
    }
  }

  const running = state.status === "running";
  const merging = mergingUrl != null;
  const busy = running || forcing || merging;
  const resultOpen = state.status === "result";
  const errorOpen = state.status === "error";
  const canForceMerge = state.status === "result" && !state.result.merged;
  const forceActionLabel =
    state.status === "result" && shouldMergeAfterShip(state.result.pr.author)
      ? "仍然 Approve + Merge"
      : "仍然 Approve";
  const runningUrl = state.status === "running" ? state.url : null;
  const result = state.status === "result" ? state.result : null;
  const errorMessage = state.status === "error" ? state.message : "";

  return {
    state,
    setState,
    listState,
    refreshing,
    forcing,
    mergingUrl,
    authorFilter,
    setAuthorFilter,
    authorCounts,
    totalCount,
    visibleItems,
    loadOpenPulls,
    runShip,
    runMerge,
    runForceApproveMerge,
    copyOwnPr,
    running,
    busy,
    resultOpen,
    errorOpen,
    canForceMerge,
    forceActionLabel,
    runningUrl,
    result,
    errorMessage,
  };
}
