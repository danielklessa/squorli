import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { joinErrorText, moveErrorText, pluginErrorText, pluginProblem } from "./apiErrorText";
import { t } from "./i18n";

const refusal = (status: number, code: string | null) => new ApiError("POST", "/api/rtc-token", status, code, {});

describe("pluginProblem", () => {
  const plugin = (status: number, code: string | null, body: Record<string, unknown> = {}) => new ApiError("POST", "/api/plugins", status, code, body);
  it("has a sentence for every code the plugin routes send", () => {
    for (const code of ["plugins_operator_only", "plugin_no_manifest", "plugin_bad_manifest", "plugin_bad_code", "plugin_bad_file_name", "plugin_too_large", "plugin_api_too_new", "plugin_api_too_old", "too_many_plugins",
      "capabilities_changed", "command_taken", "plugin_incompatible", "plugin_unavailable", "plugin_failed", "plugin_timeout", "unknown_plugin", "unknown_action", "unknown_command", "unknown_view", "invalid_values", "owner_only",
      "forbidden", "target_above_you", "self", "not_found", "bad_request"]) {
      const text = pluginErrorText(plugin(400, code));
      expect(text, code).not.toContain("/api/");
      expect(text.length, code).toBeGreaterThan(10);
    }
    expect(pluginErrorText(plugin(403, "owner_only"))).toBe(t("plugin.err.owner_only"));
    expect(pluginErrorText(plugin(502, "plugin_failed"))).toBe(t("plugin.err.plugin_failed"));
  });
  it("shows the server's technical message as a detail below the sentence, never instead of it", () => {
    const p = pluginProblem(plugin(400, "plugin_bad_code", { message: "x.ts:3:1 enum is not supported in strip-only mode" }));
    expect(p).toEqual({ text: t("plugin.err.plugin_bad_code"), detail: "x.ts:3:1 enum is not supported in strip-only mode" });
    expect(pluginProblem(plugin(400, "plugin_no_manifest")).detail).toBeNull();
    expect(pluginProblem(plugin(400, "plugin_bad_manifest", { message: 7 })).detail).toBeNull();
    expect(pluginProblem(plugin(400, "plugin_bad_manifest", { message: "x".repeat(5000) })).detail).toHaveLength(600);
  });
  it("names the command that is taken", () => {
    expect(pluginErrorText(plugin(409, "command_taken", { command: "hello", plugin: "hello-ts" }))).toBe(t("plugin.err.command_taken", { command: "hello" }));
    expect(pluginErrorText(plugin(409, "command_taken"))).toBe(t("plugin.err.command_taken", { command: "?" }));
  });
  it("keeps an unknown code readable and other errors as they are", () => {
    expect(pluginErrorText(plugin(500, "internal"))).toBe(t("plugin.err.generic", { message: "POST /api/plugins -> 500 (internal)" }));
    expect(pluginProblem(new Error("no network"))).toEqual({ text: "no network", detail: null });
  });
});

describe("joinErrorText", () => {
  it("turns the server's codes into the catalog's sentences, never the request line", () => {
    expect(joinErrorText(refusal(403, "forbidden"))).toBe(t("voice.joinErr.forbidden"));
    expect(joinErrorText(refusal(403, "confined"))).toBe(t("voice.stickyBlocked"));
    expect(joinErrorText(refusal(409, "channel_full"))).toBe(t("voice.joinErr.full"));
    expect(joinErrorText(refusal(404, "unknown_channel"))).toBe(t("voice.joinErr.gone"));
    expect(joinErrorText(refusal(401, "unauthorized"))).toBe(t("voice.joinErr.session"));
    for (const [status, code] of [[403, "forbidden"], [403, "confined"], [409, "channel_full"], [404, "unknown_channel"], [401, "unauthorized"]] as const) expect(joinErrorText(refusal(status, code))).not.toContain("/api/");
  });
  it("keeps an unknown code readable and other errors as they are", () => {
    expect(joinErrorText(refusal(500, "boom"))).toBe(t("voice.joinErr.generic", { message: "POST /api/rtc-token -> 500 (boom)" }));
    expect(joinErrorText(new Error("no network"))).toBe("no network");
    expect(joinErrorText("x")).toBe("x");
  });
});

describe("moveErrorText", () => {
  it("has its own words for the move route", () => {
    expect(moveErrorText(refusal(403, "forbidden"))).toBe(t("members.moveErr.forbidden"));
    expect(moveErrorText(refusal(403, "confined"))).toBe(t("members.moveErr.confined"));
    expect(moveErrorText(refusal(403, "target_above_you"))).toBe(t("members.moveErr.aboveYou"));
    expect(moveErrorText(refusal(409, "not_in_voice"))).toBe(t("members.moveErr.notInVoice"));
    expect(moveErrorText(refusal(404, "not_found"))).toBe(t("members.moveErr.gone"));
    expect(moveErrorText(refusal(409, "channel_full"))).toBe(t("voice.joinErr.full"));
    expect(moveErrorText(refusal(400, "self"))).toBe(t("members.moveErr.generic", { message: "POST /api/rtc-token -> 400 (self)" }));
  });
});
