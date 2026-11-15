import { Permission, PluginCommandRequest, PluginEnableRequest, PluginInstallRequest, PluginMemberActionRequest, PluginRemoveMessages, PluginSettingsRequest, displayNameOf } from "@squorli/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireMember, type MemberContext } from "../auth/session";
import { can } from "../authz";
import { channelActor } from "../channelGuard";
import type { Config } from "../config";
import type { Db } from "../db";
import { PluginError, Plugins } from "../plugins/service";

/**
 * Plugins (docs/features/plugins.md, 15 November 2026). Three groups of routes:
 *
 * - **Verwaltung > Plugins:** `GET /api/plugins` and a plugin's settings, log and views with MANAGE_SERVER; installing,
 *   enabling, disabling and removing only for an owner. With `PLUGINS=operator` nobody installs here.
 * - **What members do through a plugin:** `POST /api/plugins/:id/member-actions/:actionId` and
 *   `POST /api/channels/:id/commands`; the permission each needs comes from the plugin's manifest and is checked here.
 * - **The operator at the machine** (`squorli plugin`, /api/operator/plugins): no session, but the machine's token.
 *
 * Not registered at all with `PLUGINS=off`.
 */

export const OPERATOR_HEADER = "x-squorli-operator";
export const OPERATOR_TOKEN_FILE = "operator-token";

/**
 * The secret that proves "I am at this machine" for the routes that write without a session. `DOCTOR_TOKEN` when the
 * installation has one (the package for Windows makes it); otherwise a random value written under DATA_DIR at every start,
 * which the wrapper reads from inside the container. Loopback alone is no proof here, unlike for the setup check's report:
 * a proxy on the same machine that forwards without a forwarding header arrives from 127.0.0.1 too, and these routes
 * install code.
 */
export async function operatorToken(config: Pick<Config, "DOCTOR_TOKEN" | "DATA_DIR">): Promise<string> {
  if (config.DOCTOR_TOKEN) {
    // A token file of a start without DOCTOR_TOKEN opens nothing any more; it is taken away so nobody tries it.
    await rm(join(config.DATA_DIR, OPERATOR_TOKEN_FILE), { force: true }).catch(() => {});
    return config.DOCTOR_TOKEN;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(join(config.DATA_DIR, OPERATOR_TOKEN_FILE), `${token}\n`, "utf8");
  return token;
}

/** Tested: only the exact token, compared in constant time, and never together with a session. */
export function isOperator(req: Pick<FastifyRequest, "headers">, token: string): boolean {
  const given = req.headers[OPERATOR_HEADER];
  if (typeof given !== "string" || !given || req.headers.authorization) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

const IdParams = { type: "object", properties: { id: { type: "string", minLength: 3, maxLength: 32 } }, required: ["id"] } as const;
const ChannelParams = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

export async function registerPluginRoutes(app: FastifyInstance, db: Db, service: Plugins, token: string) {
  /** A refusal of the service as an answer; anything else is a server error (httpHardening.ts). */
  async function answer<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
    try { return await fn(); } catch (err) {
      if (err instanceof PluginError) return reply.code(err.status).send({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}), ...err.extra });
      throw err;
    }
  }
  const idOf = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null => {
    if (Plugins.isId(req.params.id)) return req.params.id;
    void reply.code(404).send({ error: "unknown_plugin" });
    return null;
  };
  async function manager(req: FastifyRequest, reply: FastifyReply): Promise<MemberContext | null> {
    const m = await requireMember(db, req, reply);
    if (!m) return null;
    if (!can(m.actor, Permission.MANAGE_SERVER)) { await reply.code(403).send({ error: "forbidden" }); return null; }
    return m;
  }
  async function owner(req: FastifyRequest, reply: FastifyReply): Promise<MemberContext | null> {
    const m = await requireMember(db, req, reply);
    if (!m) return null;
    if (!m.actor.isOwner) { await reply.code(403).send({ error: "owner_only" }); return null; }
    return m;
  }
  const who = (m: MemberContext) => ({ userId: m.userId, name: displayNameOf(m) });

  // ---------- Verwaltung > Plugins ----------

  app.get("/api/plugins", async (req, reply) => {
    if (!(await manager(req, reply))) return;
    return service.list();
  });

  app.post("/api/plugins", async (req, reply) => {
    const m = await owner(req, reply);
    if (!m) return;
    if (service.mode !== "owner") return reply.code(403).send({ error: "plugins_operator_only" });
    const body = PluginInstallRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, async () => {
      const info = await service.install(body.data, who(m), "upload");
      req.log.info({ by: m.userId, plugin: info.id, version: info.version }, "Plugin installiert");
      return info;
    });
  });

  app.put<{ Params: { id: string } }>("/api/plugins/:id/enabled", { schema: { params: IdParams } }, async (req, reply) => {
    const m = await owner(req, reply);
    const id = m && idOf(req, reply);
    if (!m || !id) return;
    const body = PluginEnableRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, () => service.setEnabled(id, body.data.enabled, body.data.grant, who(m)));
  });

  app.delete<{ Params: { id: string }; Querystring: { messages?: string } }>("/api/plugins/:id", { schema: { params: IdParams } }, async (req, reply) => {
    const m = await owner(req, reply);
    const id = m && idOf(req, reply);
    if (!m || !id) return;
    const messages = PluginRemoveMessages.safeParse(req.query.messages ?? "keep");
    if (!messages.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, async () => { await service.remove(id, messages.data === "delete", who(m)); return { ok: true }; });
  });

  app.get<{ Params: { id: string } }>("/api/plugins/:id/settings", { schema: { params: IdParams } }, async (req, reply) => {
    const m = await manager(req, reply);
    const id = m && idOf(req, reply);
    if (!m || !id) return;
    return answer(reply, async () => service.settingsOf(id));
  });

  app.put<{ Params: { id: string } }>("/api/plugins/:id/settings", { schema: { params: IdParams } }, async (req, reply) => {
    const m = await manager(req, reply);
    const id = m && idOf(req, reply);
    if (!m || !id) return;
    const body = PluginSettingsRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, async () => {
      const r = await service.saveSettings(id, body.data.values, m);
      if (!r.ok) return reply.code(400).send({ error: "invalid_values", fieldErrors: r.fieldErrors });
      return r.settings;
    });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/plugins/:id/log", { schema: { params: IdParams } }, async (req, reply) => {
    const m = await manager(req, reply);
    const id = m && idOf(req, reply);
    if (!m || !id) return;
    const before = req.query.before !== undefined && /^\d{1,15}$/.test(req.query.before) ? Number(req.query.before) : null;
    return answer(reply, () => service.logOf(id, before));
  });

  app.get<{ Params: { id: string; viewId: string } }>("/api/plugins/:id/views/:viewId", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    if (!Plugins.isId(req.params.id) || req.params.viewId.length > 32) return reply.code(404).send({ error: "unknown_view" });
    return answer(reply, () => service.view(req.params.id, req.params.viewId));
  });

  // ---------- What members do through a plugin ----------

  app.post<{ Params: { id: string; actionId: string } }>("/api/plugins/:id/member-actions/:actionId", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!Plugins.isId(req.params.id) || req.params.actionId.length > 32) return reply.code(404).send({ error: "unknown_action" });
    const body = PluginMemberActionRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, () => service.memberAction(req.params.id, req.params.actionId, m, body.data.userId, body.data.values));
  });

  /** A slash command (the composer's "/" list). An invisible channel is a 404 like everywhere (channelGuard.ts). */
  app.post<{ Params: { id: string } }>("/api/channels/:id/commands", { schema: { params: ChannelParams } }, async (req, reply) => {
    const c = await channelActor(db, req, reply, req.params.id, "text");
    if (!c) return;
    const body = PluginCommandRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, () => service.command(c, c.channel, c.perms, body.data));
  });

  // ---------- The operator at the machine (`squorli plugin`) ----------

  const operator = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (isOperator(req, token)) return true;
    void reply.code(403).send({ error: "forbidden" });
    return false;
  };

  app.get("/api/operator/plugins", async (req, reply) => {
    if (!operator(req, reply)) return;
    return service.list();
  });

  app.post("/api/operator/plugins", async (req, reply) => {
    if (!operator(req, reply)) return;
    const body = PluginInstallRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, async () => {
      const info = await service.install(body.data, null, "cli");
      req.log.info({ plugin: info.id, version: info.version }, "Plugin vom Betreiber installiert");
      return info;
    });
  });

  app.put<{ Params: { id: string } }>("/api/operator/plugins/:id/enabled", { schema: { params: IdParams } }, async (req, reply) => {
    if (!operator(req, reply)) return;
    const id = idOf(req, reply);
    if (!id) return;
    const body = PluginEnableRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // The command printed what the plugin asks for and the operator said yes: everything the manifest names is granted.
    return answer(reply, () => service.setEnabled(id, body.data.enabled, "all", null));
  });

  app.delete<{ Params: { id: string }; Querystring: { messages?: string } }>("/api/operator/plugins/:id", { schema: { params: IdParams } }, async (req, reply) => {
    if (!operator(req, reply)) return;
    const id = idOf(req, reply);
    if (!id) return;
    const messages = PluginRemoveMessages.safeParse(req.query.messages ?? "keep");
    if (!messages.success) return reply.code(400).send({ error: "bad_request" });
    return answer(reply, async () => { await service.remove(id, messages.data === "delete", null); return { ok: true }; });
  });

  app.get<{ Params: { id: string } }>("/api/operator/plugins/:id/log", { schema: { params: IdParams } }, async (req, reply) => {
    if (!operator(req, reply)) return;
    const id = idOf(req, reply);
    if (!id) return;
    return answer(reply, () => service.logOf(id, null));
  });
}
