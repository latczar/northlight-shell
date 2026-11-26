import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// The migration on a real Postgres (PGlite), with what a Supabase project provides before it: roles, auth.users and
// auth.uid(), and the default grants that hand anon/authenticated everything on new objects (the migration takes them back).
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique, raw_user_meta_data jsonb not null default '{}', raw_app_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant select on auth.users to service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const ADMIN = "00000000-0000-4000-8000-000000000001";
const ALEX = "00000000-0000-4000-8000-000000000002";
const JAMIE = "00000000-0000-4000-8000-000000000003";

let db: PGlite;

/** Runs `work` the way PostgREST does for a request: as the role, with the JWT subject set. */
async function as<T>(role: "anon" | "authenticated" | "service_role", userId: string | null, work: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
  try {
    return await work();
  } finally {
    await db.exec("reset role");
  }
}

// Saves the way the People page does: with the newest change it saw, or as an add when the person has no access here.
const setAccess = (userId: string, rows: unknown[], clientId = "kestrel") =>
  as("service_role", null, async () => {
    const seen = (await db.query<{ t: string | null; active: number }>(
      "select max(updated_at)::text as t, (count(*) filter (where revoked_at is null))::int as active from public.agent_access where user_id = $1 and client_id = $2",
      [userId, clientId],
    )).rows[0];
    return (await db.query<{ r: { changed: boolean; wanted_version: number } }>(
      "select public.set_agent_access($1, $2, $3, $4::jsonb, $5, $6) as r",
      [ADMIN, userId, clientId, JSON.stringify(rows), seen.active ? seen.t : null, !seen.active],
    )).rows[0].r;
  });

const pushState = () =>
  as("service_role", null, async () => (await db.query<{ s: { wanted_version: number; pushed_version: number; last_error: string | null; rows: { user_id: string; can_approve: boolean; can_manage: boolean }[] } | null }>("select public.access_push_state('kestrel') as s")).rows[0].s);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(readFileSync(new URL("../supabase/migrations/20261124000000_agent_access.sql", import.meta.url), "utf8"));
  // Jamie set a name on themselves (user metadata, which anyone can change about themselves); only Alex's came from an admin
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
    ('${ADMIN}', 'admin@northlight.example', '{}', '{}'),
    ('${ALEX}', 'Alex@Kestrel.example', '{}', '{"full_name":"Alex Morgan"}'),
    ('${JAMIE}', 'jamie@kestrel.example', '{"full_name":"Alex Morgan"}', '{}')`);
});

describe("set_agent_access", () => {
  it("grants, then bumps the client's version only when something changed", async () => {
    const first = await setAccess(ALEX, [{ agent_id: "iris", can_approve: true, can_manage: true }]);
    expect(first.changed).toBe(true);
    const again = await setAccess(ALEX, [{ agent_id: "iris", can_approve: true, can_manage: true }]);
    expect(again).toEqual({ changed: false, wanted_version: first.wanted_version });
    const changed = await setAccess(ALEX, [{ agent_id: "iris", can_approve: true, can_manage: false }]);
    expect(changed.changed).toBe(true);
    expect(changed.wanted_version).toBeGreaterThan(first.wanted_version);
  });

  it("revokes employees left out (softly) and brings them back on a new grant", async () => {
    await setAccess(JAMIE, [{ agent_id: "iris" }]);
    const removed = await setAccess(JAMIE, []);
    expect(removed.changed).toBe(true);
    const rows = await db.query<{ revoked: boolean }>(`select revoked_at is not null as revoked from public.agent_access where user_id = '${JAMIE}'`);
    expect(rows.rows).toEqual([{ revoked: true }]);
    await setAccess(JAMIE, [{ agent_id: "iris" }]);
    const back = await db.query<{ revoked: boolean; can_approve: boolean }>(`select revoked_at is not null as revoked, can_approve from public.agent_access where user_id = '${JAMIE}'`);
    expect(back.rows).toEqual([{ revoked: false, can_approve: false }]);
  });

  it("refuses a malformed client, a repeated employee, or a write that says nothing about what it saw", async () => {
    await expect(setAccess(JAMIE, [{ agent_id: "iris" }], "Kestrel Garage")).rejects.toThrow(/client id/);
    await expect(setAccess(JAMIE, [{ agent_id: "iris" }, { agent_id: "iris", can_approve: true }])).rejects.toThrow(/once/);
    await expect(as("service_role", null, () => db.query("select public.set_agent_access($1, $2, 'kestrel', '[]'::jsonb)", [ADMIN, JAMIE]))).rejects.toThrow(/p_expected/);
  });

  it("refuses a save from a page older than the person's last change, so a removed right cannot come back", async () => {
    const changedAt = async () =>
      (await as("service_role", null, () => db.query<{ t: string }>(`select max(updated_at)::text as t from public.agent_access where user_id = '${JAMIE}'`))).rows[0].t;
    const save = (rows: unknown[], expected: string) =>
      as("service_role", null, () => db.query("select public.set_agent_access($1, $2, 'kestrel', $3::jsonb, $4)", [ADMIN, JAMIE, JSON.stringify(rows), expected]));
    const seen = await changedAt();
    await setAccess(JAMIE, []); // another admin removes Jamie
    await expect(save([{ agent_id: "iris", can_approve: true }], seen)).rejects.toThrow(/changed since/);
    const active = await db.query(`select 1 from public.agent_access where user_id = '${JAMIE}' and revoked_at is null`);
    expect(active.rows).toHaveLength(0);
    await save([{ agent_id: "iris" }], await changedAt()); // a page read after the change saves
  });

  it("refuses adding someone who already has access here, and adds them again once removed", async () => {
    const add = () => as("service_role", null, () => db.query("select public.set_agent_access($1, $2, 'kestrel', $3::jsonb, null, true)", [ADMIN, JAMIE, JSON.stringify([{ agent_id: "iris", can_approve: true }])]));
    await expect(add()).rejects.toThrow(/already has access/);
    const approves = await db.query<{ can_approve: boolean }>(`select can_approve from public.agent_access where user_id = '${JAMIE}'`);
    expect(approves.rows).toEqual([{ can_approve: false }]);
    await setAccess(JAMIE, []);
    await add();
    await setAccess(JAMIE, [{ agent_id: "iris" }]); // back to using only, for the tests below
  });
});

describe("the push to the agent", () => {
  it("lists only active approvers and managers, from one snapshot with the version", async () => {
    const state = await pushState();
    expect(state?.rows).toEqual([{ user_id: ALEX, agent_id: "iris", can_approve: true, can_manage: false }]);
    expect(state?.wanted_version).toBeGreaterThan(state?.pushed_version ?? 0);
  });

  it("never moves the accepted version backwards, and clears the error once a push is accepted", async () => {
    const wanted = (await pushState())!.wanted_version;
    await as("service_role", null, () => db.query("select public.access_push_failed('kestrel', 'Northlight''s service did not answer.')"));
    expect((await pushState())!.last_error).toBe("Northlight's service did not answer.");
    await as("service_role", null, () => db.query("select public.access_push_done('kestrel', $1)", [wanted]));
    await as("service_role", null, () => db.query("select public.access_push_done('kestrel', $1)", [wanted - 1]));
    const state = await pushState();
    expect(state?.pushed_version).toBe(wanted);
    expect(state?.last_error).toBeNull();
  });

  it("ignores a failure reported after the brain already took the newest list", async () => {
    await as("service_role", null, () => db.query("select public.access_push_failed('kestrel', 'An older push failed.')"));
    expect((await pushState())!.last_error).toBeNull();
  });

  it("keeps a changed person pending, business-wide, until the brain takes the version their change is in", async () => {
    const pending = async (userId: string) =>
      (await as("service_role", null, () => db.query<{ p: boolean }>("select public.access_pending($1, 'kestrel') as p", [userId]))).rows[0].p;
    expect(await pending(JAMIE)).toBe(false);
    // a change on another employee counts: the brain lets an approver of any employee decide a lesson for the whole team
    await setAccess(JAMIE, [{ agent_id: "iris" }, { agent_id: "scout", can_approve: true }]);
    expect(await pending(JAMIE)).toBe(true);
    expect(await pending(ALEX)).toBe(false); // her rows did not change
    const wanted = (await pushState())!.wanted_version;
    await as("service_role", null, () => db.query("select public.access_push_done('kestrel', $1)", [wanted]));
    expect(await pending(JAMIE)).toBe(false);
    await setAccess(JAMIE, [{ agent_id: "iris" }]);
  });
});

describe("the People page's reads", () => {
  it("finds an account by email whatever its case", async () => {
    const found = await as("service_role", null, () => db.query<{ id: string }>("select public.access_user_id_for_email('alex@kestrel.EXAMPLE') as id"));
    expect(found.rows[0].id).toBe(ALEX);
  });

  it("lists people with active rows, their email and the name an admin gave (never one they set themselves)", async () => {
    const people = await as("service_role", null, () => db.query<{ email: string; full_name: string | null; agent_id: string }>("select email, full_name, agent_id from public.access_people('kestrel')"));
    expect(people.rows).toEqual([
      { email: "Alex@Kestrel.example", full_name: "Alex Morgan", agent_id: "iris" },
      { email: "jamie@kestrel.example", full_name: null, agent_id: "iris" },
    ]);
  });
});

describe("what a browser's session can do (RLS and grants)", () => {
  it("lets a signed-in person read only their own rows", async () => {
    const rows = await as("authenticated", JAMIE, () => db.query<{ user_id: string }>("select user_id from public.agent_access"));
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(new Set(rows.rows.map(r => r.user_id))).toEqual(new Set([JAMIE]));
  });

  it("refuses every write and every function to signed-in and anonymous sessions", async () => {
    await expect(as("authenticated", JAMIE, () => db.query(`update public.agent_access set can_approve = true where user_id = '${JAMIE}'`))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", JAMIE, () => db.query(`insert into public.agent_access (user_id, client_id, agent_id) values ('${JAMIE}', 'kestrel', 'scout')`))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", JAMIE, () => db.query(`select public.set_agent_access('${JAMIE}', '${JAMIE}', 'kestrel', '[{"agent_id":"iris","can_approve":true}]')`))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", JAMIE, () => db.query("select * from public.access_people('kestrel')"))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", JAMIE, () => db.query("select * from public.brain_sync"))).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, () => db.query("select * from public.agent_access"))).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, () => db.query("select public.access_user_id_for_email('jamie@kestrel.example')"))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", JAMIE, () => db.query(`select public.access_pending('${JAMIE}', 'kestrel')`))).rejects.toThrow(/permission denied/);
  });
});
