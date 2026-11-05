import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidSettingError,
  SECRET_KINDS,
  SETTING_KEYS,
  SETTING_VALUE_MAX_LENGTH,
  type ReviewChannelInput,
  type SettingKey,
  type SettingValues,
  type SecretKind,
  type SecretMeta,
  type SecretWrite,
  type SettingsBundle,
  type SettingsBundleOutcome,
  type SettingsStore,
} from "../../ports/settings-store";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import { aRejectedEvent, aSettingsEvent, type EventfulHarness } from "./harness";

const T0 = new Date("2026-11-04T01:00:00.000Z");

/** Obviously fake secret values, distinct per `n`. */
export const aSecretWrite = (n: number, over: Partial<SecretWrite> = {}): SecretWrite => ({
  value: `xoxp-0000-FAKE-contract-secret-${String(n).padStart(4, "0")}`,
  savedAt: new Date(T0.getTime() + n * 1000),
  savedByUserId: "owner-1",
  verifiedAt: null,
  testResult: null,
  ...over,
});

export const aChannel = (id: string, over: Partial<ReviewChannelInput> = {}) => ({
  channelId: id,
  name: id.toLowerCase(),
  missing: false,
  checkedAt: null,
  ...over,
});

const onSave = ({ meta }: { replaced: boolean; meta: SecretMeta }) =>
  aSettingsEvent("slack_secret_saved", { kind: meta.kind, last4: meta.last4 });
const onRemove = (meta: SecretMeta) =>
  aSettingsEvent("slack_secret_removed", { kind: meta.kind, last4: meta.last4 });
const onChannels = ({ added, removed }: { added: string[]; removed: string[] }) =>
  aSettingsEvent("slack_channels_changed", { added: added.length, removed: removed.length });

const onValuesSaved = ({ changed }: { changed: SettingKey[] }) =>
  aSettingsEvent("slack_channels_changed", { op: "save", keys: changed.join(",") });
const onValuesRemoved = ({ removed }: { removed: SettingKey[] }) =>
  aSettingsEvent("slack_channels_changed", { op: "remove", keys: removed.join(",") });

/** One valid value of every key. */
export const ALL_SETTING_VALUES: SettingValues = {
  jira_base_url: "https://acme.atlassian.net",
  jira_email: "owner@example.com",
  anthropic_base_url: "https://relay.example.com",
  anthropic_model: "claude-opus-5-5",
  anthropic_auth_header: "x-api-key",
  anthropic_server_fallback: true,
  openai_base_url: "https://openai-relay.example.com",
  openai_model: "gpt-6.1",
  openai_reasoning_effort: "high",
};

/**
 * `rotated()` returns a store over the same data whose keys come from a different
 * `BETTER_AUTH_SECRET`, so every existing row fails to decrypt.
 */
export type SettingsStoreHarness = EventfulHarness<SettingsStore> & { rotated(): SettingsStore };

export function settingsStoreContract(make: () => Promise<SettingsStoreHarness>) {
  describe("SettingsStore contract", () => {
    let h: SettingsStoreHarness;
    const types = async () => (await h.events.list({ limit: 50 })).map((e) => e.type);
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    describe("secrets", () => {
      it("is empty at first: every kind is not_configured, remove is a no-op", async () => {
        for (const kind of SECRET_KINDS) {
          expect(await h.impl.getSecret(kind)).toEqual({ state: "not_configured" });
        }
        expect(await h.impl.removeSecret("slack_user_token", onRemove)).toBeNull();
        expect(await types()).toEqual([]);
      });

      it("saves, then reads back the plaintext and the metadata", async () => {
        const w = aSecretWrite(1, {
          verifiedAt: new Date(T0.getTime() + 1500),
          testResult: { teamName: "Acme", userName: "owner", ok: true, n: 1, none: null },
        });
        const saved = await h.impl.saveSecret("slack_user_token", w, onSave);
        const meta: SecretMeta = {
          kind: "slack_user_token",
          last4: w.value.slice(-4),
          savedAt: w.savedAt,
          savedByUserId: "owner-1",
          verifiedAt: w.verifiedAt,
          testResult: { teamName: "Acme", userName: "owner", ok: true, n: 1, none: null },
          version: 1,
        };
        expect(saved).toEqual({ replaced: false, meta });
        expect(await h.impl.getSecret("slack_user_token")).toEqual({
          state: "ready",
          value: w.value,
          meta,
        });
      });

      it("kinds are independent", async () => {
        await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        await h.impl.saveSecret("slack_app_token", aSecretWrite(2), onSave);
        expect(await h.impl.getSecret("slack_signing_secret")).toEqual({ state: "not_configured" });
        await h.impl.removeSecret("slack_user_token", onRemove);
        expect(await h.impl.getSecret("slack_user_token")).toEqual({ state: "not_configured" });
        expect(await h.impl.getSecret("slack_app_token")).toMatchObject({
          state: "ready",
          value: aSecretWrite(2).value,
          meta: { kind: "slack_app_token", version: 1 },
        });
      });

      it("every declared kind can be stored", async () => {
        for (const [i, kind] of SECRET_KINDS.entries()) {
          await h.impl.saveSecret(kind, aSecretWrite(i + 1), onSave);
        }
        for (const [i, kind] of SECRET_KINDS.entries()) {
          expect(await h.impl.getSecret(kind)).toMatchObject({
            state: "ready",
            value: aSecretWrite(i + 1).value,
          });
        }
      });

      it("a second save replaces the value and bumps the version", async () => {
        await h.impl.saveSecret("slack_app_token", aSecretWrite(1), onSave);
        const second = await h.impl.saveSecret("slack_app_token", aSecretWrite(2), onSave);
        expect(second).toMatchObject({ replaced: true, meta: { version: 2 } });
        expect(await h.impl.getSecret("slack_app_token")).toMatchObject({
          state: "ready",
          value: aSecretWrite(2).value,
          meta: { version: 2, savedAt: aSecretWrite(2).savedAt, verifiedAt: null },
        });
      });

      it("concurrent saves of one kind are serialised: one insert, one row remains", async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            h.impl.saveSecret("slack_signing_secret", aSecretWrite(i + 1), onSave),
          ),
        );
        expect(results.filter((r) => !r.replaced)).toHaveLength(1);
        expect(results.map((r) => r.meta.version).toSorted((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        const last = results.find((r) => r.meta.version === 8)!;
        expect(await h.impl.getSecret("slack_signing_secret")).toMatchObject({
          state: "ready",
          meta: last.meta,
        });
        expect((await types()).filter((t) => t === "slack_secret_saved")).toHaveLength(8);
      });

      it("a rotated key reads as needs_reset with the metadata, and never throws", async () => {
        const saved = await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        expect(await h.rotated().getSecret("slack_user_token")).toEqual({
          state: "needs_reset",
          meta: saved.meta,
        });
        expect(await h.rotated().getSecret("slack_app_token")).toEqual({
          state: "not_configured",
        });
      });

      it("a value saved after rotation reads back with the new key", async () => {
        await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        const rotated = h.rotated();
        await rotated.saveSecret("slack_user_token", aSecretWrite(2), onSave);
        expect(await rotated.getSecret("slack_user_token")).toMatchObject({
          state: "ready",
          value: aSecretWrite(2).value,
        });
      });

      it("remove deletes the row and returns it; a later save starts again", async () => {
        await h.impl.saveSecret("slack_app_token", aSecretWrite(1), onSave);
        const removed = await h.impl.removeSecret("slack_app_token", onRemove);
        expect(removed).toMatchObject({ kind: "slack_app_token", version: 1 });
        expect(await h.impl.getSecret("slack_app_token")).toEqual({ state: "not_configured" });
        expect(await h.impl.removeSecret("slack_app_token", onRemove)).toBeNull();
        const again = await h.impl.saveSecret("slack_app_token", aSecretWrite(3), onSave);
        expect(again).toMatchObject({ replaced: false, meta: { version: 1 } });
      });

      it("records each change's event, built from the outcome", async () => {
        await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        await h.impl.saveSecret("slack_user_token", aSecretWrite(2), (o) =>
          aSettingsEvent("slack_secret_saved", { replaced: o.replaced }),
        );
        await h.impl.removeSecret("slack_user_token", onRemove);
        expect((await types()).toSorted()).toEqual([
          "slack_secret_removed",
          "slack_secret_saved",
          "slack_secret_saved",
        ]);
        const [removed] = await h.events.list({ types: ["slack_secret_removed"], limit: 1 });
        expect(removed.detail).toEqual({
          kind: "slack_user_token",
          last4: aSecretWrite(2).value.slice(-4),
        });
        const saves = await h.events.list({ types: ["slack_secret_saved"], limit: 5 });
        expect(saves.map((e) => e.detail?.replaced ?? null).toSorted()).toEqual([null, true]);
      });

      it("a rejected event rolls the first save back: nothing is stored", async () => {
        await expect(
          h.impl.saveSecret("slack_user_token", aSecretWrite(1), () =>
            aRejectedEvent("slack_secret_saved"),
          ),
        ).rejects.toThrow();
        expect(await h.impl.getSecret("slack_user_token")).toEqual({ state: "not_configured" });
        expect(await types()).toEqual([]);
      });

      it("a rejected event rolls a replacement back: the old value stays", async () => {
        await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        const before = await h.impl.getSecret("slack_user_token");
        await expect(
          h.impl.saveSecret("slack_user_token", aSecretWrite(2), () =>
            aRejectedEvent("slack_secret_saved"),
          ),
        ).rejects.toThrow();
        expect(await h.impl.getSecret("slack_user_token")).toEqual(before);
        expect(
          (await h.impl.saveSecret("slack_user_token", aSecretWrite(3), onSave)).meta.version,
        ).toBe(2);
      });

      it("a rejected event rolls the remove back: the value stays", async () => {
        await h.impl.saveSecret("slack_user_token", aSecretWrite(1), onSave);
        const before = await h.impl.getSecret("slack_user_token");
        await expect(
          h.impl.removeSecret("slack_user_token", () => aRejectedEvent("slack_secret_removed")),
        ).rejects.toThrow();
        expect(await h.impl.getSecret("slack_user_token")).toEqual(before);
        expect(await types()).toEqual(["slack_secret_saved"]);
      });

      it("markSecretVerified sets verifiedAt only for the version it names", async () => {
        const at = new Date(T0.getTime() + 60_000);
        expect(await h.impl.markSecretVerified("slack_signing_secret", 1, at)).toBe(false);
        await h.impl.saveSecret("slack_signing_secret", aSecretWrite(1), onSave);
        await h.impl.saveSecret("slack_signing_secret", aSecretWrite(2), onSave);
        expect(await h.impl.markSecretVerified("slack_signing_secret", 1, at)).toBe(false);
        expect(await h.impl.getSecret("slack_signing_secret")).toMatchObject({
          meta: { verifiedAt: null, version: 2 },
        });
        expect(await h.impl.markSecretVerified("slack_signing_secret", 2, at)).toBe(true);
        expect(await h.impl.getSecret("slack_signing_secret")).toMatchObject({
          state: "ready",
          value: aSecretWrite(2).value,
          meta: { verifiedAt: at, version: 2 },
        });
        expect(await types()).toEqual(["slack_secret_saved", "slack_secret_saved"]);
      });

      it("returns copies", async () => {
        await h.impl.saveSecret(
          "slack_user_token",
          aSecretWrite(1, { testResult: { teamName: "Acme" } }),
          onSave,
        );
        const a = await h.impl.getSecret("slack_user_token");
        if (a.state !== "ready") throw new Error("expected ready");
        a.meta.testResult!.teamName = "changed";
        a.meta.savedAt.setTime(0);
        const b = await h.impl.getSecret("slack_user_token");
        expect(b).toMatchObject({
          meta: { testResult: { teamName: "Acme" }, savedAt: aSecretWrite(1).savedAt },
        });
      });
    });

    describe("values", () => {
      const AT = new Date("2026-11-04T07:00:00.000Z");
      const save = (values: Partial<SettingValues>, event = onValuesSaved) =>
        h.impl.saveValues(values, { at: AT, by: "owner-1", event });
      const remove = (keys: SettingKey[], event = onValuesRemoved) =>
        h.impl.removeValues(keys, { event });
      const details = async () =>
        (await h.events.list({ limit: 50 })).map((e) => e.detail).toReversed();

      it("is empty at first: nothing to read, remove is a no-op with no event", async () => {
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({});
        expect(await remove(["jira_email"])).toEqual({ removed: [] });
        expect(await save({})).toEqual({ changed: [] });
        expect(await types()).toEqual([]);
      });

      it("saves every key and reads them back with their types", async () => {
        const saved = await save(ALL_SETTING_VALUES);
        expect(saved).toEqual({ changed: [...SETTING_KEYS] });
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual(ALL_SETTING_VALUES);
        expect(await details()).toEqual([{ op: "save", keys: SETTING_KEYS.join(",") }]);
      });

      it("reads only the keys asked for", async () => {
        await save(ALL_SETTING_VALUES);
        expect(await h.impl.getValues(["jira_email", "anthropic_server_fallback"])).toEqual({
          jira_email: "owner@example.com",
          anthropic_server_fallback: true,
        });
        expect(await h.impl.getValues([])).toEqual({});
      });

      it("a partial save leaves other keys alone; changed lists only real changes", async () => {
        await save({ jira_base_url: "https://a.example.com", jira_email: "a@example.com" });
        const second = await save({
          jira_email: "a@example.com",
          anthropic_server_fallback: false,
          jira_base_url: "https://b.example.com",
          openai_model: undefined,
        });
        expect(second).toEqual({ changed: ["jira_base_url", "anthropic_server_fallback"] });
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({
          jira_base_url: "https://b.example.com",
          jira_email: "a@example.com",
          anthropic_server_fallback: false,
        });
        expect(await save({ jira_email: "a@example.com" })).toEqual({ changed: [] });
        expect(await details()).toEqual([
          { op: "save", keys: "jira_base_url,jira_email" },
          { op: "save", keys: "jira_base_url,anthropic_server_fallback" },
        ]);
      });

      it("removes values; removed lists only keys that had one", async () => {
        await save({ openai_model: "gpt-6.1", openai_reasoning_effort: "low" });
        const removed = await remove(["openai_reasoning_effort", "jira_email", "openai_model"]);
        expect(removed).toEqual({ removed: ["openai_model", "openai_reasoning_effort"] });
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({});
        expect(await remove(["openai_model"])).toEqual({ removed: [] });
        expect(await remove([])).toEqual({ removed: [] });
        expect(await details()).toEqual([
          { op: "save", keys: "openai_model,openai_reasoning_effort" },
          { op: "remove", keys: "openai_model,openai_reasoning_effort" },
        ]);
      });

      it("values and secrets are separate stores", async () => {
        await save({ jira_email: "a@example.com" });
        await h.impl.saveSecret("jira_api_token", aSecretWrite(1), onSave);
        await remove(["jira_email"]);
        expect(await h.impl.getSecret("jira_api_token")).toMatchObject({ state: "ready" });
        await h.impl.removeSecret("jira_api_token", onRemove);
        await save({ jira_email: "b@example.com" });
        expect(await h.impl.getValues(["jira_email"])).toEqual({ jira_email: "b@example.com" });
      });

      it("a rejected event rolls the save back", async () => {
        await save({ jira_email: "a@example.com" });
        await expect(
          save({ jira_email: "b@example.com", openai_model: "gpt-6.1" }, () =>
            aRejectedEvent("slack_channels_changed"),
          ),
        ).rejects.toThrow();
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({ jira_email: "a@example.com" });
        expect(await types()).toHaveLength(1);
      });

      it("a rejected event rolls the remove back", async () => {
        await save({ jira_email: "a@example.com", openai_model: "gpt-6.1" });
        await expect(
          remove(["jira_email", "openai_model"], () => aRejectedEvent("slack_channels_changed")),
        ).rejects.toThrow();
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({
          jira_email: "a@example.com",
          openai_model: "gpt-6.1",
        });
        expect(await types()).toHaveLength(1);
      });

      it("concurrent saves are serialised: one sees each change, the last value wins", async () => {
        const same = await Promise.all(
          Array.from({ length: 6 }, () => save({ anthropic_model: "claude-opus-5-5" })),
        );
        expect(same.filter((r) => r.changed.length > 0)).toHaveLength(1);
        const models = Array.from({ length: 6 }, (_, i) => `model-${i}`);
        const distinct = await Promise.all(models.map((m) => save({ anthropic_model: m })));
        expect(distinct.every((r) => r.changed.join() === "anthropic_model")).toBe(true);
        const { anthropic_model } = await h.impl.getValues(["anthropic_model"]);
        expect(models).toContain(anthropic_model);
        expect(await types()).toHaveLength(7);
      });

      it("concurrent removes are serialised: each key is removed once", async () => {
        await save({ jira_email: "a@example.com", jira_base_url: "https://a.example.com" });
        const results = await Promise.all(
          Array.from({ length: 6 }, () => remove(["jira_email", "jira_base_url"])),
        );
        expect(results.filter((r) => r.removed.length > 0)).toEqual([
          { removed: ["jira_base_url", "jira_email"] },
        ]);
        expect(await types()).toHaveLength(2);
      });

      describe("refuses bad input at the boundary, changing nothing", () => {
        const bad: [string, unknown][] = [
          ["an unknown key", { jira_url: "https://a.example.com" }],
          ["a secret kind as a key", { jira_api_token: "secret-value-0000" }],
          ["a prototype key", JSON.parse('{"__proto__": "x"}')],
          ["a null value", { jira_email: null }],
          ["a number", { anthropic_model: 5 }],
          ["a string for the boolean", { anthropic_server_fallback: "true" }],
          ["a boolean for a string", { openai_model: true }],
          ["an empty string", { jira_email: "" }],
          ["a string over the cap", { jira_base_url: "x".repeat(SETTING_VALUE_MAX_LENGTH + 1) }],
          ["a newline", { anthropic_model: "claude\nopus" }],
          ["a NUL", { anthropic_model: "claude\u0000" }],
          ["a DEL", { anthropic_model: "claude\u007f" }],
          ["a C1 control", { anthropic_model: "claude\u0085" }],
          ["a line separator", { anthropic_model: "claude\u2028" }],
          ["an unknown auth header", { anthropic_auth_header: "basic" }],
          ["an array", ["jira_email"]],
          ["null", null],
        ];
        for (const [name, values] of bad) {
          it(`save: ${name}`, async () => {
            await save({ jira_email: "a@example.com" });
            // A bad entry next to a good one: the good one is not written either.
            const input =
              values === null || Array.isArray(values)
                ? values
                : { openai_model: "gpt-6.1", ...(values as object) };
            await expect(save(input as Partial<SettingValues>)).rejects.toThrow(
              InvalidSettingError,
            );
            expect(await h.impl.getValues(SETTING_KEYS)).toEqual({ jira_email: "a@example.com" });
            expect(await types()).toHaveLength(1);
          });
        }

        it("accepts a value exactly at the cap, and unicode text", async () => {
          const long = "x".repeat(SETTING_VALUE_MAX_LENGTH);
          await save({ jira_base_url: long, anthropic_model: "模型-é-🙂" });
          expect(await h.impl.getValues(["jira_base_url", "anthropic_model"])).toEqual({
            jira_base_url: long,
            anthropic_model: "模型-é-🙂",
          });
        });

        it("the error names the key, never the value", async () => {
          const error = await save({ jira_email: "sentinel-value\n" }).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(InvalidSettingError);
          expect((error as InvalidSettingError).key).toBe("jira_email");
          expect(String((error as Error).message)).not.toContain("sentinel");
        });

        it("get and remove refuse unknown keys", async () => {
          await save({ jira_email: "a@example.com" });
          const unknown = ["jira_email", "slack_user_token"] as unknown as SettingKey[];
          await expect(h.impl.getValues(unknown)).rejects.toThrow(InvalidSettingError);
          await expect(remove(unknown)).rejects.toThrow(InvalidSettingError);
          await expect(remove("jira_email" as unknown as SettingKey[])).rejects.toThrow(
            InvalidSettingError,
          );
          expect(await h.impl.getValues(["jira_email"])).toEqual({ jira_email: "a@example.com" });
          expect(await types()).toHaveLength(1);
        });

        it("no setting key is a secret kind", () => {
          const secrets: readonly string[] = SECRET_KINDS;
          expect(SETTING_KEYS.filter((k) => secrets.includes(k))).toEqual([]);
        });
      });
    });

    describe("bundles (one transaction)", () => {
      const AT = new Date("2026-11-04T08:00:00.000Z");
      const onBundleEvent = (o: SettingsBundleOutcome) =>
        aSettingsEvent("settings_value_saved", {
          saved: o.savedSecrets.map((s) => `${s.kind}:${s.replaced}`).join(","),
          changed: o.changedValues.join(","),
          removedSecrets: o.removedSecrets.map((m) => m.kind).join(","),
          removedValues: o.removedValues.join(","),
        });
      const onBundle = { at: AT, by: "owner-1", event: onBundleEvent };
      const failing = (event: () => NewReviewEvent) => ({ at: AT, by: "owner-1", event });
      const snapshot = async () => ({
        values: await h.impl.getValues(SETTING_KEYS),
        secrets: await Promise.all(SECRET_KINDS.map((k) => h.impl.getSecret(k))),
      });
      /** Stored state with a secret and two values, plus one event. */
      const seed = async () => {
        await h.impl.saveBundle(
          {
            secrets: { anthropic_api_key: aSecretWrite(1) },
            values: { anthropic_model: "model-a", anthropic_base_url: "https://a.example.com" },
          },
          onBundle,
        );
      };

      it("writes secrets and values and records exactly one event", async () => {
        const out = await h.impl.saveBundle(
          {
            secrets: { jira_api_token: aSecretWrite(1, { verifiedAt: AT }) },
            values: { jira_base_url: "https://acme.atlassian.net", jira_email: "a@example.com" },
          },
          onBundle,
        );
        expect(out.savedSecrets.map((s) => [s.kind, s.replaced, s.meta.version])).toEqual([
          ["jira_api_token", false, 1],
        ]);
        expect(out.changedValues).toEqual(["jira_base_url", "jira_email"]);
        expect(out.removedSecrets).toEqual([]);
        expect(out.removedValues).toEqual([]);
        const token = await h.impl.getSecret("jira_api_token");
        expect(token.state === "ready" && token.value).toBe(aSecretWrite(1).value);
        expect(token.state === "ready" && token.meta.verifiedAt).toEqual(AT);
        expect(await h.impl.getValues(["jira_base_url", "jira_email"])).toEqual({
          jira_base_url: "https://acme.atlassian.net",
          jira_email: "a@example.com",
        });
        const events = await h.events.list({ limit: 50 });
        expect(events).toHaveLength(1);
        expect(events[0]!.detail).toEqual({
          saved: "jira_api_token:false",
          changed: "jira_base_url,jira_email",
          removedSecrets: "",
          removedValues: "",
        });
      });

      it("saves, replaces and removes in one call; lists only real changes", async () => {
        await seed();
        const out = await h.impl.saveBundle(
          {
            secrets: { anthropic_auth_token: aSecretWrite(2) },
            values: { anthropic_model: "model-a", anthropic_auth_header: "bearer" },
            removeSecrets: ["anthropic_api_key", "openai_api_key"],
            removeValues: ["anthropic_base_url", "openai_model"],
          },
          onBundle,
        );
        expect(out.savedSecrets.map((s) => s.kind)).toEqual(["anthropic_auth_token"]);
        expect(out.changedValues).toEqual(["anthropic_auth_header"]);
        expect(out.removedSecrets.map((m) => m.kind)).toEqual(["anthropic_api_key"]);
        expect(out.removedSecrets[0]!.last4).toBe(aSecretWrite(1).value.slice(-4));
        expect(out.removedValues).toEqual(["anthropic_base_url"]);
        expect(await h.impl.getSecret("anthropic_api_key")).toEqual({ state: "not_configured" });
        expect(await h.impl.getValues(SETTING_KEYS)).toEqual({
          anthropic_model: "model-a",
          anthropic_auth_header: "bearer",
        });
        expect(await types()).toHaveLength(2);
      });

      it("a second save of a kind is a replacement and bumps the version", async () => {
        await seed();
        const out = await h.impl.saveBundle(
          { secrets: { anthropic_api_key: aSecretWrite(3) } },
          onBundle,
        );
        expect(out.savedSecrets.map((s) => [s.replaced, s.meta.version])).toEqual([[true, 2]]);
      });

      it("a bundle that changes nothing records no event", async () => {
        await seed();
        const out = await h.impl.saveBundle(
          {
            values: { anthropic_model: "model-a" },
            removeSecrets: ["openai_api_key"],
            removeValues: ["jira_email"],
          },
          onBundle,
        );
        expect(out).toEqual({
          savedSecrets: [],
          changedValues: [],
          removedSecrets: [],
          removedValues: [],
        });
        expect(await h.impl.saveBundle({}, onBundle)).toEqual(out);
        expect(await types()).toHaveLength(1);
      });

      it("a rejected event rolls the whole bundle back: secrets, values and removals", async () => {
        await seed();
        const before = await snapshot();
        await expect(
          h.impl.saveBundle(
            {
              secrets: { anthropic_auth_token: aSecretWrite(4), openai_api_key: aSecretWrite(5) },
              values: { anthropic_model: "model-b", openai_model: "gpt-6.1" },
              removeSecrets: ["anthropic_api_key"],
              removeValues: ["anthropic_base_url"],
            },
            failing(() => aRejectedEvent("settings_value_saved")),
          ),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(await types()).toHaveLength(1);
        // The rolled-back replacement did not consume a version.
        const next = await h.impl.saveBundle(
          { secrets: { anthropic_api_key: aSecretWrite(6) } },
          onBundle,
        );
        expect(next.savedSecrets[0]!.meta.version).toBe(2);
      });

      it("an event builder that throws rolls the bundle back too", async () => {
        await seed();
        const before = await snapshot();
        await expect(
          h.impl.saveBundle(
            { values: { anthropic_model: "model-c" }, removeSecrets: ["anthropic_api_key"] },
            failing(() => {
              throw new Error("event builder failed");
            }),
          ),
        ).rejects.toThrow("event builder failed");
        expect(await snapshot()).toEqual(before);
      });

      describe("refuses a bad bundle, changing nothing", () => {
        const bad: [string, () => SettingsBundle][] = [
          [
            "an empty secret",
            () => ({ secrets: { jira_api_token: aSecretWrite(1, { value: "" }) } }),
          ],
          [
            "an unknown secret kind",
            () => ({ secrets: { github_token: aSecretWrite(1) } as SettingsBundle["secrets"] }),
          ],
          ["a bad value", () => ({ values: { jira_email: "" } })],
          [
            "an unknown removed kind",
            () => ({ removeSecrets: ["github_token"] as unknown as SecretKind[] }),
          ],
          [
            "an unknown removed key",
            () => ({ removeValues: ["jira_url"] as unknown as SettingKey[] }),
          ],
          [
            "a kind both saved and removed",
            () => ({
              secrets: { anthropic_api_key: aSecretWrite(2) },
              removeSecrets: ["anthropic_api_key"],
            }),
          ],
          [
            "a key both saved and removed",
            () => ({ values: { jira_email: "b@example.com" }, removeValues: ["jira_email"] }),
          ],
        ];
        for (const [name, bundle] of bad) {
          it(name, async () => {
            await seed();
            const before = await snapshot();
            const valid = { values: { openai_model: "gpt-6.1" } };
            await expect(
              h.impl.saveBundle(
                {
                  ...valid,
                  ...bundle(),
                  values: { ...valid.values, ...bundle().values },
                },
                onBundle,
              ),
            ).rejects.toThrow(InvalidSettingError);
            expect(await snapshot()).toEqual(before);
            expect(await types()).toHaveLength(1);
          });
        }
      });

      it("concurrent bundles are serialised: each change is reported once", async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            h.impl.saveBundle(
              { values: { jira_email: "a@example.com" }, removeSecrets: ["jira_api_token"] },
              onBundle,
            ),
          ),
        );
        expect(results.filter((r) => r.changedValues.length > 0)).toHaveLength(1);
        expect(await types()).toHaveLength(1);
      });
    });

    describe("review channels", () => {
      const AT = new Date("2026-11-04T05:00:00.000Z");
      const LATER = new Date("2026-11-04T06:00:00.000Z");

      it("is empty at first", async () => {
        expect(await h.impl.listReviewChannels()).toEqual([]);
      });

      it("replaces the selection, reports the diff and records one event", async () => {
        const first = await h.impl.setReviewChannels(
          [aChannel("C0BBB", { name: "web-team" }), aChannel("C0AAA", { name: "eng-review" })],
          { at: AT, by: "owner-1", event: onChannels },
        );
        expect(first.diff).toEqual({ added: ["C0AAA", "C0BBB"], removed: [] });
        expect(first.channels).toEqual([
          {
            channelId: "C0AAA",
            name: "eng-review",
            missing: false,
            checkedAt: null,
            addedAt: AT,
            addedBy: "owner-1",
          },
          {
            channelId: "C0BBB",
            name: "web-team",
            missing: false,
            checkedAt: null,
            addedAt: AT,
            addedBy: "owner-1",
          },
        ]);
        expect(await h.impl.listReviewChannels()).toEqual(first.channels);

        const second = await h.impl.setReviewChannels(
          [
            aChannel("C0AAA", { name: "eng-review-2", missing: true, checkedAt: LATER }),
            aChannel("G0CCC", { name: "private" }),
          ],
          { at: LATER, by: "owner-2", event: onChannels },
        );
        expect(second.diff).toEqual({ added: ["G0CCC"], removed: ["C0BBB"] });
        expect(await h.impl.listReviewChannels()).toEqual([
          {
            channelId: "C0AAA",
            name: "eng-review-2",
            missing: true,
            checkedAt: LATER,
            addedAt: AT,
            addedBy: "owner-1",
          },
          {
            channelId: "G0CCC",
            name: "private",
            missing: false,
            checkedAt: null,
            addedAt: LATER,
            addedBy: "owner-2",
          },
        ]);
        expect(await types()).toEqual(["slack_channels_changed", "slack_channels_changed"]);
      });

      it("an unchanged set records no event; clearing records one", async () => {
        await h.impl.setReviewChannels([aChannel("C0AAA")], {
          at: AT,
          by: "owner-1",
          event: onChannels,
        });
        const same = await h.impl.setReviewChannels([aChannel("C0AAA", { name: "renamed" })], {
          at: LATER,
          by: "owner-1",
          event: onChannels,
        });
        expect(same.diff).toEqual({ added: [], removed: [] });
        expect(same.channels[0]).toMatchObject({ name: "renamed", addedAt: AT });
        const cleared = await h.impl.setReviewChannels([], {
          at: LATER,
          by: "owner-1",
          event: onChannels,
        });
        expect(cleared).toEqual({ channels: [], diff: { added: [], removed: ["C0AAA"] } });
        expect(await types()).toEqual(["slack_channels_changed", "slack_channels_changed"]);
      });

      it("a rejected event rolls the change back", async () => {
        await h.impl.setReviewChannels([aChannel("C0AAA")], {
          at: AT,
          by: "owner-1",
          event: onChannels,
        });
        const before = await h.impl.listReviewChannels();
        await expect(
          h.impl.setReviewChannels([aChannel("C0BBB")], {
            at: LATER,
            by: "owner-1",
            event: () => aRejectedEvent("slack_channels_changed"),
          }),
        ).rejects.toThrow();
        expect(await h.impl.listReviewChannels()).toEqual(before);
        expect(await types()).toEqual(["slack_channels_changed"]);
      });

      it("concurrent replacements are serialised: the result is one of the inputs", async () => {
        const inputs = [
          ["C0AAA", "C0BBB"],
          ["C0CCC"],
          ["C0AAA", "C0DDD", "C0EEE"],
          ["C0FFF", "C0BBB"],
        ];
        await Promise.all(
          inputs.map((ids) =>
            h.impl.setReviewChannels(
              ids.map((id) => aChannel(id)),
              { at: AT, by: "owner-1", event: onChannels },
            ),
          ),
        );
        const now = (await h.impl.listReviewChannels()).map((c) => c.channelId);
        expect(inputs.map((ids) => ids.toSorted().join())).toContain(now.join());
        expect(await types()).toHaveLength(4);
      });

      it("updateReviewChannelChecks refreshes listed channels only, with no event", async () => {
        await h.impl.setReviewChannels([aChannel("C0AAA"), aChannel("C0BBB")], {
          at: AT,
          by: "owner-1",
          event: onChannels,
        });
        await h.impl.updateReviewChannelChecks(
          [
            { channelId: "C0AAA", name: "gone", missing: true },
            { channelId: "C0ZZZ", name: "not-selected", missing: false },
          ],
          LATER,
        );
        expect(await h.impl.listReviewChannels()).toEqual([
          expect.objectContaining({ channelId: "C0BBB", missing: false, checkedAt: null }),
          expect.objectContaining({
            channelId: "C0AAA",
            name: "gone",
            missing: true,
            checkedAt: LATER,
            addedAt: AT,
          }),
        ]);
        expect(await types()).toEqual(["slack_channels_changed"]);
      });
    });
  });
}
