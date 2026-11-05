import type { RepoView, SettingsView } from "../../../application/settings/view";
import type { RepoPermissions } from "../../../domain/settings/permissions";

export const FULL: RepoPermissions = {
  pullRequests: { read: "granted", write: "granted" },
  contents: { read: "granted", write: "granted" },
  checks: { read: "granted" },
  statuses: { read: "granted" },
};

export const aRepoView = (over: Partial<RepoView> = {}): RepoView => ({
  canonical: "acme/web",
  access: "ok",
  permissions: FULL,
  health: "ok",
  missing: [],
  checkedAt: "2026-11-04T03:00:00.000Z",
  addedAt: "2026-11-04T03:00:00.000Z",
  ...over,
});

export const aSettingsView = (over: Partial<SettingsView> = {}): SettingsView => ({
  availability: "ready",
  token: {
    login: "octocat",
    avatarUrl: "https://avatars.example.test/u/1",
    last4: "WXYZ",
    savedAt: "2026-11-04T03:00:00.000Z",
    tokenKind: "fine_grained",
    scopes: null,
  },
  repos: [],
  maxRepos: 50,
  ...over,
});

export const notConfigured = (): SettingsView =>
  aSettingsView({ availability: "not_configured", token: null });
