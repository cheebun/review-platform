/**
 * The app's navigation, in display order (§2.7). The shell renders exactly these lists, so a
 * change to the information architecture is a one-line edit here.
 */
export interface NavItem {
  label: string;
  /** An app path. */
  to: string;
}

/** The main sidebar list: one flat level. */
export const NAV_MAIN: readonly NavItem[] = [
  { label: "Overview", to: "/" },
  { label: "Review", to: "/review" },
  { label: "Merge", to: "/merge" },
];

/** Pinned to the bottom of the sidebar, next to sign-out. */
export const NAV_BOTTOM: readonly NavItem[] = [{ label: "Settings", to: "/settings" }];

/** Every link in display order (main, then bottom). */
export function navLinks(): NavItem[] {
  return [...NAV_MAIN, ...NAV_BOTTOM];
}

/** `/` matches only itself; any other item also matches its sub-paths (legacy AppShell rule). */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.to) return true;
  return item.to !== "/" && pathname.startsWith(`${item.to}/`);
}
