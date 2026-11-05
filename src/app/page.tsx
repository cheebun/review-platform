"use client";

import { ReviewPageProvider } from "@/app/review/components/ReviewPageProvider";
import { OpenPrSection } from "@/app/review/components/OpenPrSection";
import { ShipErrorModal } from "@/app/review/components/ShipErrorModal";
import { ShipResultModal } from "@/app/review/components/ShipResultModal";
import { SlackReviewSection } from "@/app/review/components/SlackReviewSection";
import { SlackDigestUnread } from "@/components/SlackDigestUnread";

export default function WorkbenchPage() {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <div>
        <p className="ops-kicker">Workspace</p>
        <h1 className="ops-title">工作台</h1>
        <p className="ops-desc">点「已读」后，已处理的内容不再在这里显示；完整记录在各自的页面。</p>
      </div>
      <ReviewPageProvider>
        <SlackReviewSection href="/review" />
        <OpenPrSection ownOnly />
        <ShipErrorModal />
        <ShipResultModal />
      </ReviewPageProvider>
      <SlackDigestUnread />
    </div>
  );
}
