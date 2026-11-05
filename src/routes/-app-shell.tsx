import { createLink, Link, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { authClient } from "../adapters/auth/client";
import { Button, Toaster, twx } from "../ui";
import { NAV_BOTTOM, NAV_MAIN, isNavItemActive, type NavItem } from "./-nav";

const Shell = twx("div")(() => "min-h-screen bg-background text-on-surface md:flex");
const Sidebar = twx("aside")(
  () =>
    "flex flex-col gap-4 border-b border-border bg-surface px-3 py-4 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r",
);
const Brand = twx(Link)(
  () =>
    "flex items-center gap-2 rounded-md px-3 py-1 text-heading outline-none focus-visible:ring-2 focus-visible:ring-primary",
);
const BrandMark = twx("span").attrs({ "aria-hidden": true })(() => "size-3 rounded-sm bg-primary");
const BrandName = twx("span")(() => "font-semibold");
const Nav = twx("nav")(() => "flex min-h-0 flex-1 flex-col gap-4");
const List = twx("ul")(() => "flex flex-col gap-0.5");
const Bottom = twx("div")(() => "mt-auto flex flex-col gap-2 border-t border-border pt-3");
const navLink = (active: boolean) =>
  [
    "block whitespace-nowrap rounded-md px-3 py-1.5 text-label-md outline-none focus-visible:ring-2 focus-visible:ring-primary",
    active
      ? "bg-primary-soft text-primary-ink"
      : "text-secondary-text hover:bg-hover-fill hover:text-heading",
  ].join(" ");
const NavAnchor = twx("a")<{ $active?: boolean }>(({ $active }) => navLink(Boolean($active)));
/** Router-aware nav link: client-side navigation and preloading, styled by `NavAnchor`. */
const InternalLink = createLink(NavAnchor);
const Main = twx("main")(
  () => "mx-auto w-full min-w-0 max-w-content-max-width flex-1 px-4 py-8 sm:px-6",
);

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isNavItemActive(item, pathname);
  return (
    <li>
      {/* Nav items may point at sections not built yet (they hit the catch-all), so `to` is a
          plain string rather than a registered route path. */}
      <InternalLink
        to={item.to as never}
        $active={active}
        aria-current={active ? "page" : undefined}
      >
        {item.label}
      </InternalLink>
    </li>
  );
}

/**
 * No account is shown: the single owner signs in with the login token, and the account's email is
 * an internal placeholder.
 */
export interface AppShellProps {
  children?: ReactNode;
  /** Defaults to the Better Auth client. Injectable for tests. */
  signOut?: () => Promise<unknown>;
  /** Defaults to a full reload of /login, which also drops every cached query. */
  afterSignOut?: () => void;
}

const defaultSignOut = () => authClient.signOut();
const defaultAfterSignOut = () => window.location.assign("/login");

export function AppShell({
  children,
  signOut = defaultSignOut,
  afterSignOut = defaultAfterSignOut,
}: AppShellProps) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [leaving, setLeaving] = useState(false);
  const onSignOut = async () => {
    setLeaving(true);
    try {
      await signOut();
    } catch {
      // Leave anyway: the guard on /login re-checks the session.
    }
    afterSignOut();
  };
  return (
    <Shell>
      <Sidebar>
        <Brand to="/">
          <BrandMark />
          <BrandName>Review platform</BrandName>
        </Brand>
        <Nav aria-label="主导航">
          <List>
            {NAV_MAIN.map((item) => (
              <NavLink key={item.to} item={item} pathname={pathname} />
            ))}
          </List>
          <Bottom>
            <List>
              {NAV_BOTTOM.map((item) => (
                <NavLink key={item.to} item={item} pathname={pathname} />
              ))}
            </List>
            <Button variant="ghost" size="sm" loading={leaving} onClick={() => void onSignOut()}>
              退出登录
            </Button>
          </Bottom>
        </Nav>
      </Sidebar>
      <Main>{children}</Main>
      <Toaster />
    </Shell>
  );
}
