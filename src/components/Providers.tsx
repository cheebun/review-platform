"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";

const theme = {
  token: {
    colorPrimary: "#0b5fff",
    colorInfo: "#0b5fff",
    colorSuccess: "#16794c",
    colorWarning: "#b45309",
    colorError: "#c41e1e",
    colorText: "#111827",
    colorTextSecondary: "#4b5563",
    colorTextTertiary: "#6b7280",
    colorBorder: "#d1d5db",
    colorBorderSecondary: "#e5e7eb",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgLayout: "#f3f4f6",
    borderRadius: 8,
    fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
    fontFamilyCode: "var(--font-mono), ui-monospace, monospace",
    controlHeight: 40,
    controlHeightLG: 44,
  },
  components: {
    Layout: {
      headerBg: "transparent",
      headerHeight: 64,
      bodyBg: "transparent",
    },
    Button: {
      primaryShadow: "none",
      fontWeight: 600,
      colorPrimary: "#0b5fff",
    },
    Typography: {
      colorText: "#111827",
      colorTextDescription: "#4b5563",
      colorTextSecondary: "#4b5563",
    },
    Form: {
      labelColor: "#111827",
    },
    Input: {
      colorText: "#111827",
      colorTextPlaceholder: "#9ca3af",
      activeBorderColor: "#0b5fff",
      hoverBorderColor: "#3b82f6",
    },
    Alert: {
      colorText: "#111827",
      colorTextHeading: "#111827",
    },
  },
};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider locale={zhCN} theme={theme}>
        <App>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
