"use client";

import { OpenPrSection } from "./components/OpenPrSection";
import { ReviewHeader } from "./components/ReviewHeader";
import { ReviewPageProvider } from "./components/ReviewPageProvider";
import { ShipErrorModal } from "./components/ShipErrorModal";
import { ShipResultModal } from "./components/ShipResultModal";
import { SlackReviewSection } from "./components/SlackReviewSection";

export default function ReviewPage() {
  return (
    <ReviewPageProvider>
      <div style={{ display: "grid", gap: 28 }}>
        <ReviewHeader />
        <SlackReviewSection />
        <OpenPrSection />
        <ShipErrorModal />
        <ShipResultModal />
      </div>
    </ReviewPageProvider>
  );
}
