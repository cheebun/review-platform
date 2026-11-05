"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountProvider, AccountSwitcher } from "./AccountSwitcher";

const JIRA_ANALYZER_URL = "https://wgbx.github.io/jira-analyzer/";

const NAV = [
  { key: "/", label: "工作台", href: "/", external: false },
  { key: "/review", label: "PR Review", href: "/review", external: false },
  { key: "/slack", label: "Slack 日报", href: "/slack", external: false },
  { key: "/jira", label: "Jira Breakdown", href: "/jira", external: false },
  {
    key: "daily-ui-tweaks",
    label: "Daily UI tweaks",
    href: JIRA_ANALYZER_URL,
    external: true,
  },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AccountProvider>
      <div className="ops-shell">
        <header className="ops-header">
          <div style={{ display: "flex", alignItems: "center", gap: 28, minWidth: 0 }}>
            <Link href="/" className="ops-brand">
              <span className="ops-brand-mark" aria-hidden />
              <span className="ops-brand-name">agent-ops</span>
              <span className="ops-brand-sub">console</span>
            </Link>
            <nav className="ops-nav">
              {NAV.map((item) => {
                if (item.external) {
                  return (
                    <a
                      key={item.key}
                      href={item.href}
                      className="ops-nav-link"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {item.label}
                    </a>
                  );
                }
                const active =
                  pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`ops-nav-link${active ? " active" : ""}`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <AccountSwitcher />
        </header>
        <main className="ops-main">
          <div className="ops-panel">{children}</div>
        </main>
      </div>
    </AccountProvider>
  );
}
