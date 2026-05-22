import "../tests/setup/env.js";
import t from "tap";
import { type } from "arktype";
import { Hono } from "hono";
import { db, setupTestSchema, clearTestData } from "../db/instance.js";
import { signToken } from "../middleware/auth.js";
import { openapiRoutes } from "./openapi.js";
import { OPENAPI_USPTO } from "../tests/fixtures/openapi-spec.js";

const ErrorResponse = type({ error: "string", "+": "delete" });

const FaremeterPricing = type({
  "price?": "number",
  "scheme?": "string",
  "endpoint_id?": "number",
  "+": "delete",
});

const FaremeterPathItem = type({
  "x-faremeter-pricing?": FaremeterPricing,
  "x-faremeter-tags?": "string[]",
  "x-faremeter-orphan?": "boolean",
  "x-faremeter-original-pattern?": "string",
  "+": "delete",
});

function fmPath(val: unknown) {
  return FaremeterPathItem.assert(val);
}

const ExportedSpec = type({
  paths: "Record<string, unknown>",
  info: "Record<string, unknown>",
  openapi: "string",
  "orphans?": "unknown[]",
  "servers?": "unknown[]",
  "components?": "Record<string, unknown>",
  "+": "delete",
});

const SpecResponse = type({
  "spec?": ExportedSpec.or(type("null")),
  hasSpec: "boolean",
  "+": "delete",
});

const ExportResponse = type({
  spec: ExportedSpec,
  "warnings?": "string[]",
  "orphanEndpoints?": "unknown[]",
  stats: {
    totalEndpoints: "number",
    withLineage: "number",
    orphans: "number",
    "+": "delete",
  },
  "+": "delete",
});

const ImportResponse = type({
  success: "boolean",
  created: "number",
  linked: "number",
  paths: { created: "string[]", "+": "delete" },
  "+": "delete",
});

const RootPricingSpec = type({
  "x-faremeter-pricing": {
    rules: "unknown[]",
    "+": "delete",
  },
  "+": "delete",
});

const DeleteSpecResponse = type({
  success: "boolean",
  "+": "delete",
});

const ValidateResponse = type({
  valid: "boolean",
  "isValidRegex?": "boolean",
  "hasSpec?": "boolean",
  "matches?": "string[]",
  "totalSpecPaths?": "number",
  "+": "delete",
});

const OpenApiSpec = type({
  paths: "Record<string, unknown>",
  "info?": { "title?": "string", "+": "delete" },
  "openapi?": "string",
  "servers?": "unknown[]",
  "components?": "Record<string, unknown>",
  "+": "delete",
});

const app = new Hono();
app.route("/api/tenants/:tenantId/openapi", openapiRoutes);

await setupTestSchema();

interface TestUser {
  id: number;
  token: string;
}

async function createUser(email: string, isAdmin = false): Promise<TestUser> {
  const user = await db
    .insertInto("users")
    .values({
      email,
      password_hash: "hash",
      is_admin: isAdmin,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();

  const token = signToken({ userId: user.id, email: user.email, isAdmin });
  return { id: user.id, token };
}

async function createOrg(name: string, slug: string) {
  return db
    .insertInto("organizations")
    .values({ name, slug })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

async function addMember(userId: number, orgId: number, role = "member") {
  await db
    .insertInto("user_organizations")
    .values({ user_id: userId, organization_id: orgId, role })
    .execute();
}

async function createTenant(orgId: number, name: string) {
  return db
    .insertInto("tenants")
    .values({
      name,
      organization_id: orgId,
      backend_url: "http://backend.example.com",
      default_price: 0.01,
      default_scheme: "exact",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

t.beforeEach(async () => {
  await clearTestData();
});

await t.test("GET /api/tenants/:tenantId/openapi/spec", async (t) => {
  await t.test("returns 401 without auth", async (t) => {
    const res = await app.request("/api/tenants/1/openapi/spec");
    t.equal(res.status, 401);
  });

  await t.test("returns 403 for non-member", async (t) => {
    const user = await createUser("outsider@example.com");
    const org = await createOrg("Team", "team");
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/spec`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 403);
  });

  await t.test("returns null spec when none stored", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/spec`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = SpecResponse.assert(await res.json());
    t.equal(data.spec, null);
    t.equal(data.hasSpec, false);
  });

  await t.test("returns stored spec when present", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spec: OPENAPI_USPTO }),
    });

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/spec`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = SpecResponse.assert(await res.json());
    t.equal(data.hasSpec, true);
    if (!data.spec) throw new Error("expected spec");
    t.equal(data.spec.openapi, OPENAPI_USPTO.openapi);
  });
});

await t.test("handles non-numeric tenantId", async (t) => {
  const user = await createUser("member@example.com");

  const res = await app.request("/api/tenants/invalid/openapi/spec", {
    headers: { Cookie: `auth_token=${user.token}` },
  });
  // parseInt("invalid") returns NaN (falsy), middleware returns 400
  t.equal(res.status, 400);
});

await t.test("DELETE /api/tenants/:tenantId/openapi/spec", async (t) => {
  await t.test("clears stored spec", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .updateTable("tenants")
      .set({ openapi_spec: JSON.stringify(OPENAPI_USPTO) })
      .where("id", "=", tenant.id)
      .execute();

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/spec`, {
      method: "DELETE",
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = DeleteSpecResponse.assert(await res.json());
    t.equal(data.success, true);
  });
});

await t.test("POST /api/tenants/:tenantId/openapi/import", async (t) => {
  await t.test("rejects invalid spec - missing openapi field", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spec: { paths: { "/test": {} } },
      }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("Invalid"));
  });

  await t.test("rejects spec with no paths", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spec: {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: { "/": {} },
        },
      }),
    });
    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("No paths"));
  });

  await t.test("rejects path keys without leading slash", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spec: {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: { "relative/path": { get: {} } },
        },
      }),
    });

    t.equal(res.status, 400);
    const data = ErrorResponse.assert(await res.json());
    t.ok(data.error.includes("Invalid"));
  });

  await t.test("imports valid spec and creates endpoints", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spec: OPENAPI_USPTO }),
    });
    t.equal(res.status, 200);
    const data = ImportResponse.assert(await res.json());
    t.equal(data.success, true);
    t.ok(data.created >= 2);
  });

  await t.test(
    "preserves existing root pricing when imported spec has none",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");
      const existingRules = [
        {
          selector: { type: "json_path", path: "$.model" },
          prices: { "gpt-4": "0.04", default: "0.01" },
        },
      ];

      await db
        .updateTable("tenants")
        .set({
          openapi_spec: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Existing", version: "1.0.0" },
            paths: {
              "/existing": {
                get: { responses: { "200": { description: "OK" } } },
              },
            },
            "x-faremeter-pricing": { rules: existingRules },
          }),
        })
        .where("id", "=", tenant.id)
        .execute();

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: OPENAPI_USPTO }),
        },
      );

      t.equal(res.status, 200);
      const savedTenant = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirstOrThrow();
      const savedSpec = RootPricingSpec.assert(savedTenant.openapi_spec);

      t.same(savedSpec["x-faremeter-pricing"].rules, existingRules);
    },
  );

  await t.test("rejects OpenAPI 2.x spec", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spec: {
          swagger: "2.0",
          info: { title: "Test", version: "1.0.0" },
          paths: { "/users": { get: {} } },
        },
      }),
    });
    t.equal(res.status, 400);
  });

  await t.test(
    "links to existing endpoint instead of creating duplicate",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spec: OPENAPI_USPTO }),
      });

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: OPENAPI_USPTO }),
        },
      );
      t.equal(res.status, 200);
      const data = ImportResponse.assert(await res.json());
      t.equal(data.created, 0);
      t.ok(data.linked >= 2);
    },
  );

  await t.test("handles paths with parameters", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const specWithParams = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/users/{userId}": { get: { summary: "Get user" } },
        "/users/{userId}/posts/{postId}": { get: { summary: "Get post" } },
      },
    };

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spec: specWithParams }),
    });
    t.equal(res.status, 200);
    const data = ImportResponse.assert(await res.json());
    t.equal(data.created, 2);
  });
});

await t.test("GET /api/tenants/:tenantId/openapi/export", async (t) => {
  await t.test("returns minimal spec when none stored", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/export`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = ExportResponse.assert(await res.json());
    t.ok(data.spec);
    t.equal(data.spec.openapi, "3.0.3");
  });

  await t.test("exports endpoints with pricing info", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spec: OPENAPI_USPTO }),
    });

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/export`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = ExportResponse.assert(await res.json());
    t.ok(data.stats);
    t.ok(data.stats.totalEndpoints >= 2);
  });

  await t.test("reports orphan endpoints in warnings", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("endpoints")
      .values({
        tenant_id: tenant.id,
        path: "/manual/endpoint",
        path_pattern: "^/manual/endpoint$",
        priority: 1,
        is_active: true,
      })
      .execute();

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/export`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = ExportResponse.assert(await res.json());
    t.equal(data.stats.orphans, 1);
    if (!data.warnings) throw new Error("expected data.warnings");
    t.ok(data.warnings.length > 0);
  });

  await t.test("includes orphans when requested", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await db
      .insertInto("endpoints")
      .values({
        tenant_id: tenant.id,
        path: "/manual/endpoint",
        path_pattern: "^/manual/endpoint$",
        priority: 1,
        is_active: true,
      })
      .execute();

    const res = await app.request(
      `/api/tenants/${tenant.id}/openapi/export?include_orphans=true`,
      { headers: { Cookie: `auth_token=${user.token}` } },
    );
    t.equal(res.status, 200);
    const data = ExportResponse.assert(await res.json());
    t.ok(Object.keys(data.spec.paths).length > 0);
  });

  await t.test("excludes inactive endpoints from export", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenant = await createTenant(org.id, "my-tenant");

    await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
      method: "POST",
      headers: {
        Cookie: `auth_token=${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spec: OPENAPI_USPTO }),
    });

    await db
      .updateTable("endpoints")
      .set({ is_active: false })
      .where("tenant_id", "=", tenant.id)
      .execute();

    const res = await app.request(`/api/tenants/${tenant.id}/openapi/export`, {
      headers: { Cookie: `auth_token=${user.token}` },
    });
    t.equal(res.status, 200);
    const data = ExportResponse.assert(await res.json());
    t.equal(data.stats.totalEndpoints, 0);
  });
});

await t.test(
  "POST /api/tenants/:tenantId/openapi/validate-pattern",
  async (t) => {
    await t.test("rejects invalid regex", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "[invalid" }),
        },
      );
      t.equal(res.status, 200);
      const data = ValidateResponse.assert(await res.json());
      t.equal(data.valid, false);
      t.equal(data.isValidRegex, false);
    });

    await t.test("returns no matches when no spec stored", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "^/api/.*$" }),
        },
      );
      t.equal(res.status, 200);
      const data = ValidateResponse.assert(await res.json());
      t.equal(data.valid, true);
      t.equal(data.hasSpec, false);
      t.same(data.matches, []);
    });

    await t.test("validates pattern against stored spec", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spec: OPENAPI_USPTO }),
      });

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "^/.*$" }),
        },
      );
      t.equal(res.status, 200);
      const data = ValidateResponse.assert(await res.json());
      t.equal(data.valid, true);
      t.equal(data.isValidRegex, true);
    });

    await t.test("returns matched paths from spec", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const testSpec = {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/api/users": { get: {} },
          "/api/posts": { get: {} },
          "/health": { get: {} },
        },
      };

      await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spec: testSpec }),
      });

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "^/api/.*$" }),
        },
      );
      t.equal(res.status, 200);
      const data = ValidateResponse.assert(await res.json());
      if (!data.matches) throw new Error("expected data.matches");
      t.equal(data.matches.length, 2);
      t.ok(data.matches.includes("/api/users"));
      t.ok(data.matches.includes("/api/posts"));
    });

    await t.test("returns total spec paths count", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const testSpec = {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/api/users": { get: {} },
          "/api/posts": { get: {} },
          "/health": { get: {} },
        },
      };

      await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spec: testSpec }),
      });

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "^/nomatch$" }),
        },
      );
      t.equal(res.status, 200);
      const data = ValidateResponse.assert(await res.json());
      if (!data.matches) throw new Error("expected data.matches");
      t.equal(data.matches.length, 0);
      t.equal(data.totalSpecPaths, 3);
    });
  },
);

await t.test(
  "POST /api/tenants/:tenantId/openapi/import - edge cases",
  async (t) => {
    await t.test("handles OpenAPI 3.1.0 spec", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const spec310 = {
        openapi: "3.1.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/api/v3/users": { get: {} },
        },
      };

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: spec310 }),
        },
      );
      t.equal(res.status, 200);
      const data = ImportResponse.assert(await res.json());
      t.equal(data.created, 1);
      t.ok(data.paths.created.includes("/api/v3/users"));
    });

    await t.test("handles paths with trailing slashes", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const specWithTrailingSlash = {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/api/users/": { get: {} },
          "/api/posts/": { get: {} },
        },
      };

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: specWithTrailingSlash }),
        },
      );
      t.equal(res.status, 200);
      const data = ImportResponse.assert(await res.json());
      t.equal(data.created, 2);
      t.ok(data.paths.created.includes("/api/users/"));
    });

    await t.test(
      "re-import creates new paths (existing endpoints persist)",
      async (t) => {
        const user = await createUser("member@example.com");
        const org = await createOrg("Team", "team");
        await addMember(user.id, org.id);
        const tenant = await createTenant(org.id, "my-tenant");

        const firstSpec = {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: {
            "/api/v1/users": { get: {} },
            "/api/v1/posts": { get: {} },
          },
        };

        await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: firstSpec }),
        });

        // Re-import with different paths - these are added, not replacing
        const secondSpec = {
          openapi: "3.0.0",
          info: { title: "Test", version: "2.0.0" },
          paths: {
            "/api/v2/users": { get: {} },
            "/api/v2/comments": { get: {} },
          },
        };

        const res = await app.request(
          `/api/tenants/${tenant.id}/openapi/import`,
          {
            method: "POST",
            headers: {
              Cookie: `auth_token=${user.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ spec: secondSpec }),
          },
        );

        t.equal(res.status, 200);
        const data = ImportResponse.assert(await res.json());
        // Should create 2 new paths
        t.equal(data.created, 2);
        t.ok(data.paths.created.includes("/api/v2/users"));
        t.ok(data.paths.created.includes("/api/v2/comments"));
      },
    );

    await t.test("handles spec with many paths efficiently", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Create spec with many unique paths
      const paths: Record<string, object> = {};
      for (let i = 0; i < 50; i++) {
        paths[`/api/resource${i}`] = { get: {} };
      }

      const spec = {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths,
      };

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec }),
        },
      );

      t.equal(res.status, 200);
      const data = ImportResponse.assert(await res.json());
      t.equal(data.created, 50);
    });
  },
);

await t.test(
  "POST /api/tenants/:tenantId/openapi/validate-pattern - edge cases",
  async (t) => {
    await t.test("rejects empty pattern string", async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      const res = await app.request(
        `/api/tenants/${tenant.id}/openapi/validate-pattern`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pattern: "" }),
        },
      );
      t.equal(res.status, 400);
    });

    await t.test(
      "handles tenant with no spec imported gracefully",
      async (t) => {
        const user = await createUser("member@example.com");
        const org = await createOrg("Team", "team");
        await addMember(user.id, org.id);
        const tenant = await createTenant(org.id, "my-tenant");

        // No spec imported - should return hasSpec: false
        const res = await app.request(
          `/api/tenants/${tenant.id}/openapi/validate-pattern`,
          {
            method: "POST",
            headers: {
              Cookie: `auth_token=${user.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ pattern: "^/api/.*$" }),
          },
        );
        t.equal(res.status, 200);
        const data = ValidateResponse.assert(await res.json());
        t.equal(data.hasSpec, false);
        if (!data.matches) throw new Error("expected data.matches");
        t.equal(data.matches.length, 0);
      },
    );
  },
);

await t.test("OpenAPI spec auto-sync with endpoint mutations", async (t) => {
  await t.test(
    "import spec then add manual endpoint preserves imported spec structure",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Import the USPTO spec
      const importRes = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: OPENAPI_USPTO }),
        },
      );
      t.equal(importRes.status, 200);

      // Manually add an endpoint (simulating the endpoint route sync)
      const { syncOpenApiSpec } = await import("../lib/openapi-sync.js");
      await db
        .insertInto("endpoints")
        .values({
          tenant_id: tenant.id,
          path: "/health",
          path_pattern: "/health",
          priority: 100,
          is_active: true,
          description: "Health check",
        })
        .execute();

      await syncOpenApiSpec(tenant.id);

      // Verify spec via GET /spec
      const specRes = await app.request(
        `/api/tenants/${tenant.id}/openapi/spec`,
        {
          headers: { Cookie: `auth_token=${user.token}` },
        },
      );
      t.equal(specRes.status, 200);
      const specData = SpecResponse.assert(await specRes.json());
      t.equal(specData.hasSpec, true);

      const spec = ExportedSpec.assert(specData.spec);
      // Original info preserved
      t.equal(spec.info?.title, "USPTO Data Set API");
      t.equal(spec.info?.version, "1.0.0");
      // Original servers preserved
      t.ok(spec.servers);
      t.equal(spec.servers?.length, 1);
      // Original components preserved
      t.ok(spec.components);
      // Imported paths preserved (with lineage endpoints still active)
      t.ok(
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- checking if either path exists
        spec.paths["/{dataset}/{version}/fields"] ||
          spec.paths["/{dataset}/{version}/records"],
      );
      // Manual endpoint included
      t.ok(spec.paths["/health"]);
    },
  );

  await t.test(
    "import spec then delete imported endpoint removes path from spec",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Import spec
      await app.request(`/api/tenants/${tenant.id}/openapi/import`, {
        method: "POST",
        headers: {
          Cookie: `auth_token=${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spec: OPENAPI_USPTO }),
      });

      // Get all endpoints to find one to delete
      const endpoints = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .execute();

      // Find the fields endpoint
      const fieldsEndpoint = endpoints.find(
        (e) => e.openapi_source_paths?.[0] === "/{dataset}/{version}/fields",
      );
      if (!fieldsEndpoint) {
        t.fail("expected fieldsEndpoint");
        return;
      }

      // Soft-delete it
      await db
        .updateTable("endpoints")
        .set({ is_active: false, deleted_at: new Date() })
        .where("id", "=", fieldsEndpoint.id)
        .execute();

      const { syncOpenApiSpec } = await import("../lib/openapi-sync.js");
      await syncOpenApiSpec(tenant.id);

      const tenantRow = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();

      if (!tenantRow) {
        t.fail("expected tenantRow");
        return;
      }
      const spec = OpenApiSpec.assert(tenantRow.openapi_spec);
      t.notOk(spec.paths["/{dataset}/{version}/fields"]);
      // Other path should still exist
      t.ok(spec.paths["/{dataset}/{version}/records"]);
    },
  );

  await t.test(
    "import spec, add manual endpoint, remove it - spec returns to imported paths only",
    async (t) => {
      const user = await createUser("member@example.com");
      const org = await createOrg("Team", "team");
      await addMember(user.id, org.id);
      const tenant = await createTenant(org.id, "my-tenant");

      // Import spec
      const importRes = await app.request(
        `/api/tenants/${tenant.id}/openapi/import`,
        {
          method: "POST",
          headers: {
            Cookie: `auth_token=${user.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ spec: OPENAPI_USPTO }),
        },
      );
      t.equal(importRes.status, 200);
      const importData = ImportResponse.assert(await importRes.json());
      const importedCount =
        (importData.created ?? 0) + (importData.linked ?? 0);

      // Add manual endpoint
      const { syncOpenApiSpec } = await import("../lib/openapi-sync.js");
      const manual = await db
        .insertInto("endpoints")
        .values({
          tenant_id: tenant.id,
          path: "/health",
          path_pattern: "/health",
          priority: 100,
          is_active: true,
          description: "Health check",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await syncOpenApiSpec(tenant.id);

      // Verify manual endpoint is in spec
      let tenantRow = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      if (!tenantRow) {
        t.fail("expected tenantRow");
        return;
      }
      let spec = OpenApiSpec.assert(tenantRow.openapi_spec);
      t.ok(spec.paths["/health"], "manual endpoint present after add");
      const pathCountWithManual = Object.keys(spec.paths).length;
      t.equal(pathCountWithManual, importedCount + 1);

      // Remove the manual endpoint
      await db
        .updateTable("endpoints")
        .set({ is_active: false, deleted_at: new Date() })
        .where("id", "=", manual.id)
        .execute();

      await syncOpenApiSpec(tenant.id);

      // Verify spec reverts to imported-only
      tenantRow = await db
        .selectFrom("tenants")
        .select(["openapi_spec"])
        .where("id", "=", tenant.id)
        .executeTakeFirst();
      if (!tenantRow) {
        t.fail("expected tenantRow after remove");
        return;
      }
      spec = OpenApiSpec.assert(tenantRow.openapi_spec);
      t.notOk(spec.paths["/health"], "manual endpoint gone after remove");
      t.equal(Object.keys(spec.paths).length, importedCount);
      // Original imported paths still intact
      t.ok(spec.paths["/{dataset}/{version}/fields"]);
      t.ok(spec.paths["/{dataset}/{version}/records"]);
      // Original spec metadata preserved
      if (!spec.info) throw new Error("expected spec.info");
      t.equal(spec.info.title, "USPTO Data Set API");
      t.ok(spec.servers);
      t.ok(spec.components);
    },
  );
});

function makeSpec(
  paths: Record<string, unknown>,
  info?: { title?: string; version?: string },
) {
  return {
    openapi: "3.0.0",
    info: { title: info?.title ?? "Test", version: info?.version ?? "1.0.0" },
    paths,
  };
}

function authHeaders(token: string) {
  return {
    Cookie: `auth_token=${token}`,
    "Content-Type": "application/json",
  };
}

async function importSpec(tenantId: number, token: string, spec: unknown) {
  return app.request(`/api/tenants/${tenantId}/openapi/import`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ spec }),
  });
}

async function exportSpec(
  tenantId: number,
  token: string,
  includeOrphans = false,
) {
  const url = includeOrphans
    ? `/api/tenants/${tenantId}/openapi/export?include_orphans=true`
    : `/api/tenants/${tenantId}/openapi/export`;
  const res = await app.request(url, {
    headers: { Cookie: `auth_token=${token}` },
  });
  return { res, data: ExportResponse.assert(await res.json()) };
}

async function setupTenant() {
  const user = await createUser("member@example.com");
  const org = await createOrg("Team", "team");
  await addMember(user.id, org.id);
  const tenant = await createTenant(org.id, "my-tenant");
  return { user, org, tenant };
}

await t.test("x-402 export extensions", async (t) => {
  await t.test(
    "exports x-faremeter-pricing with correct values on lineage endpoints",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": { get: { summary: "List users" } },
        "/api/posts": { get: { summary: "List posts" } },
      });

      await importSpec(tenant.id, user.token, spec);

      await db
        .updateTable("endpoints")
        .set({ price: 500, scheme: "exact" })
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .execute();

      await db
        .updateTable("endpoints")
        .set({ price: 0, scheme: "exact" })
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/posts")
        .execute();

      const { data } = await exportSpec(tenant.id, user.token);

      const usersFm = fmPath(data.spec.paths["/api/users"]);
      if (!usersFm["x-faremeter-pricing"]) throw new Error("expected pricing");
      t.equal(usersFm["x-faremeter-pricing"].price, 500);
      t.equal(usersFm["x-faremeter-pricing"].scheme, "exact");
      t.notOk(
        usersFm["x-faremeter-pricing"].endpoint_id,
        "endpoint_id should not be exported",
      );

      const postsFm = fmPath(data.spec.paths["/api/posts"]);
      if (!postsFm["x-faremeter-pricing"]) throw new Error("expected pricing");
      t.equal(postsFm["x-faremeter-pricing"].price, 0);
      t.equal(postsFm["x-faremeter-pricing"].scheme, "exact");
      t.notOk(postsFm["x-faremeter-pricing"].endpoint_id);
    },
  );

  await t.test("exports x-faremeter-tags on lineage endpoints", async (t) => {
    const { user, tenant } = await setupTenant();

    await importSpec(
      tenant.id,
      user.token,
      makeSpec({
        "/api/users": { get: {} },
      }),
    );

    await db
      .updateTable("endpoints")
      .set({ tags: ["production", "v2"] })
      .where("tenant_id", "=", tenant.id)
      .execute();

    const { data } = await exportSpec(tenant.id, user.token);

    t.same(fmPath(data.spec.paths["/api/users"])["x-faremeter-tags"], [
      "production",
      "v2",
    ]);
  });

  await t.test("omits x-faremeter-tags when tags are empty", async (t) => {
    const { user, tenant } = await setupTenant();

    await importSpec(
      tenant.id,
      user.token,
      makeSpec({
        "/api/users": { get: {} },
      }),
    );

    const { data } = await exportSpec(tenant.id, user.token);

    t.notOk(
      fmPath(data.spec.paths["/api/users"])["x-faremeter-tags"],
      "x-faremeter-tags should be absent when no tags",
    );
  });

  await t.test(
    "uses tenant defaults when endpoint has no overrides",
    async (t) => {
      const { user, tenant } = await setupTenant();

      await importSpec(
        tenant.id,
        user.token,
        makeSpec({
          "/api/users": { get: {} },
        }),
      );

      const { data } = await exportSpec(tenant.id, user.token);

      const fm = fmPath(data.spec.paths["/api/users"]);
      if (!fm["x-faremeter-pricing"]) throw new Error("expected pricing");
      t.equal(fm["x-faremeter-pricing"].price, 0.01);
      t.equal(fm["x-faremeter-pricing"].scheme, "exact");
    },
  );

  await t.test(
    "orphan export includes x-faremeter-pricing, x-faremeter-tags, and x-faremeter-orphan",
    async (t) => {
      const { user, tenant } = await setupTenant();

      await db
        .insertInto("endpoints")
        .values({
          tenant_id: tenant.id,
          path: "/manual/endpoint",
          path_pattern: "^/manual/endpoint$",
          priority: 1,
          is_active: true,
          price: 250,
          scheme: "exact",
          tags: ["internal"],
        })
        .execute();

      const { data } = await exportSpec(tenant.id, user.token, true);

      const orphanPath = fmPath(data.spec.paths["/manual/endpoint"]);
      t.ok(orphanPath, "orphan path should exist");
      t.equal(orphanPath["x-faremeter-orphan"], true);
      t.equal(orphanPath["x-faremeter-pricing"]?.price, 250);
      t.equal(orphanPath["x-faremeter-pricing"]?.scheme, "exact");
      t.same(orphanPath["x-faremeter-tags"], ["internal"]);
    },
  );
});

await t.test("x-402 import extensions", async (t) => {
  await t.test(
    "imports x-faremeter-pricing and applies to created endpoints",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: { summary: "List users" },
          "x-faremeter-pricing": { price: 500, scheme: "exact" },
        },
      });

      const res = await importSpec(tenant.id, user.token, spec);
      t.equal(res.status, 200);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();

      t.equal(endpoint.price, 500);
      t.equal(endpoint.scheme, "exact");
    },
  );

  await t.test(
    "imports x-faremeter-tags and applies to created endpoints",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-tags": ["api", "v2"],
        },
      });

      const res = await importSpec(tenant.id, user.token, spec);
      t.equal(res.status, 200);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();

      t.same(endpoint.tags, ["api", "v2"]);
    },
  );

  await t.test(
    "ignores x-faremeter-pricing with out-of-range price",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-pricing": { price: 999999999 },
        },
      });

      const res = await importSpec(tenant.id, user.token, spec);
      t.equal(res.status, 200);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();

      t.equal(
        endpoint.price,
        null,
        "out-of-range price should fall back to null",
      );
    },
  );

  await t.test("ignores x-faremeter-pricing with invalid scheme", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": { price: 100, scheme: "bogus" },
      },
    });

    const res = await importSpec(tenant.id, user.token, spec);
    t.equal(res.status, 200);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();

    t.equal(
      endpoint.price,
      null,
      "invalid scheme should invalidate all extensions",
    );
    t.equal(endpoint.scheme, null);
  });

  await t.test(
    "ignores x-faremeter-tags with invalid tag values",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-tags": ["UPPERCASE", "invalid tag!"],
        },
      });

      const res = await importSpec(tenant.id, user.token, spec);
      t.equal(res.status, 200);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();

      t.same(endpoint.tags, [], "invalid tags should fall back to empty");
    },
  );

  await t.test("ignores x-faremeter-pricing with negative price", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": { price: -5 },
      },
    });

    const res = await importSpec(tenant.id, user.token, spec);
    t.equal(res.status, 200);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();

    t.equal(endpoint.price, null, "negative price should fall back to null");
  });
});

await t.test("x-402 round-trip and deduplication", async (t) => {
  await t.test(
    "export then re-import preserves pricing and tags",
    async (t) => {
      const { user, tenant } = await setupTenant();

      // Import a plain spec
      await importSpec(
        tenant.id,
        user.token,
        makeSpec({
          "/api/users": { get: { summary: "List users" } },
          "/api/posts": { get: { summary: "List posts" } },
        }),
      );

      // Set pricing and tags
      await db
        .updateTable("endpoints")
        .set({
          price: 750,
          scheme: "exact",
          tags: ["premium"],
        })
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .execute();

      await db
        .updateTable("endpoints")
        .set({
          price: 0,
          scheme: "exact",
          tags: ["free", "public"],
        })
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/posts")
        .execute();

      // Export
      const { data: exportData } = await exportSpec(tenant.id, user.token);
      const exportedSpec = exportData.spec;

      // Clear all endpoints
      await db
        .deleteFrom("endpoints")
        .where("tenant_id", "=", tenant.id)
        .execute();

      // Re-import the exported spec
      const reimportRes = await importSpec(tenant.id, user.token, exportedSpec);
      t.equal(reimportRes.status, 200);

      // Verify
      const endpoints = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .execute();

      const usersEp = endpoints.find((e) => e.path === "/api/users");
      const postsEp = endpoints.find((e) => e.path === "/api/posts");

      if (!usersEp) throw new Error("usersEp not found");
      t.equal(usersEp.price, 750);
      t.equal(usersEp.scheme, "exact");
      t.same(usersEp.tags, ["premium"]);

      if (!postsEp) throw new Error("postsEp not found");
      t.equal(postsEp.price, 0);
      t.equal(postsEp.scheme, "exact");
      t.same(postsEp.tags, ["free", "public"]);
    },
  );

  await t.test(
    "re-import with x-402 updates existing endpoints without duplication",
    async (t) => {
      const { user, tenant } = await setupTenant();

      // First import: plain spec
      const plainSpec = makeSpec({
        "/api/users": { get: { summary: "List users" } },
        "/api/posts": { get: { summary: "List posts" } },
      });
      const firstRes = await importSpec(tenant.id, user.token, plainSpec);
      const firstData = ImportResponse.assert(await firstRes.json());
      t.equal(firstData.created, 2);

      const countBefore = await db
        .selectFrom("endpoints")
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirstOrThrow();

      // Second import: same paths but with x-402 extensions
      const specWithExtensions = makeSpec({
        "/api/users": {
          get: { summary: "List users" },
          "x-faremeter-pricing": { price: 1000, scheme: "exact" },
          "x-faremeter-tags": ["updated"],
        },
        "/api/posts": {
          get: { summary: "List posts" },
          "x-faremeter-pricing": { price: 0, scheme: "exact" },
        },
      });

      const secondRes = await importSpec(
        tenant.id,
        user.token,
        specWithExtensions,
      );
      const secondData = ImportResponse.assert(await secondRes.json());
      t.equal(secondData.created, 0, "no new endpoints created");
      t.equal(secondData.linked, 2, "both linked to existing");

      const countAfter = await db
        .selectFrom("endpoints")
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirstOrThrow();

      t.equal(
        Number(countBefore.count),
        Number(countAfter.count),
        "endpoint count unchanged",
      );

      // Verify values were updated
      const usersEp = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();

      t.equal(usersEp.price, 1000);
      t.equal(usersEp.scheme, "exact");
      t.same(usersEp.tags, ["updated"]);
    },
  );

  await t.test("tenant isolation - imports do not cross tenants", async (t) => {
    const user = await createUser("member@example.com");
    const org = await createOrg("Team", "team");
    await addMember(user.id, org.id);
    const tenantA = await createTenant(org.id, "tenant-a");
    const tenantB = await createTenant(org.id, "tenant-b");

    await importSpec(
      tenantA.id,
      user.token,
      makeSpec({
        "/api/alpha": {
          get: {},
          "x-faremeter-pricing": { price: 100 },
        },
      }),
    );

    await importSpec(
      tenantB.id,
      user.token,
      makeSpec({
        "/api/beta": {
          get: {},
          "x-faremeter-pricing": { price: 200 },
        },
      }),
    );

    const { data: exportA } = await exportSpec(tenantA.id, user.token);
    const { data: exportB } = await exportSpec(tenantB.id, user.token);

    t.ok(exportA.spec.paths["/api/alpha"], "tenant A has its own path");
    t.notOk(
      exportA.spec.paths["/api/beta"],
      "tenant A does not have tenant B's path",
    );

    t.ok(exportB.spec.paths["/api/beta"], "tenant B has its own path");
    t.notOk(
      exportB.spec.paths["/api/alpha"],
      "tenant B does not have tenant A's path",
    );

    t.equal(
      fmPath(exportA.spec.paths["/api/alpha"])["x-faremeter-pricing"]?.price,
      100,
    );
    t.equal(
      fmPath(exportB.spec.paths["/api/beta"])["x-faremeter-pricing"]?.price,
      200,
    );
  });

  await t.test(
    "orphan round-trip: export with orphans then re-import does not duplicate",
    async (t) => {
      const { user, tenant } = await setupTenant();

      // Import a spec to have some lineage endpoints
      await importSpec(
        tenant.id,
        user.token,
        makeSpec({
          "/api/users": { get: { summary: "List users" } },
        }),
      );

      // Create an orphan endpoint (manually, no openapi_source_paths)
      await db
        .insertInto("endpoints")
        .values({
          tenant_id: tenant.id,
          path: "/custom/data",
          path_pattern: "^/custom/[^/]+/data$",
          priority: 100,
          is_active: true,
          price: 300,
          scheme: "exact",
          tags: ["orphan-tag"],
        })
        .execute();

      const countBefore = await db
        .selectFrom("endpoints")
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirstOrThrow();

      // Export with orphans included
      const { data: exportData } = await exportSpec(
        tenant.id,
        user.token,
        true,
      );
      t.equal(exportData.stats.orphans, 1, "should have 1 orphan");

      // Re-import the exported spec (which contains orphans with x-faremeter-original-pattern)
      const reimportRes = await importSpec(
        tenant.id,
        user.token,
        exportData.spec,
      );
      const reimportData = ImportResponse.assert(await reimportRes.json());

      // The orphan should be linked, not created as new
      t.equal(reimportData.created, 0, "no new endpoints should be created");

      const countAfter = await db
        .selectFrom("endpoints")
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirstOrThrow();

      t.equal(
        Number(countBefore.count),
        Number(countAfter.count),
        "endpoint count should not increase",
      );
    },
  );
});

await t.test("x-402 import edge cases", async (t) => {
  await t.test(
    "re-import without extensions preserves existing pricing and tags",
    async (t) => {
      const { user, tenant } = await setupTenant();

      // First import with extensions
      const specWithExt = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-pricing": { price: 999, scheme: "exact" },
          "x-faremeter-tags": ["premium"],
        },
      });
      await importSpec(tenant.id, user.token, specWithExt);

      // Verify values were set
      let endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.equal(endpoint.price, 999);
      t.equal(endpoint.scheme, "exact");
      t.same(endpoint.tags, ["premium"]);

      // Re-import same paths WITHOUT extensions
      const plainSpec = makeSpec({
        "/api/users": { get: {} },
      });
      const res = await importSpec(tenant.id, user.token, plainSpec);
      const data = ImportResponse.assert(await res.json());
      t.equal(data.linked, 1, "should link, not create");
      t.equal(data.created, 0);

      // Verify existing values preserved
      endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.equal(endpoint.price, 999, "price should be preserved");
      t.equal(endpoint.scheme, "exact", "scheme should be preserved");
      t.same(endpoint.tags, ["premium"], "tags should be preserved");
    },
  );

  await t.test(
    "partial x-faremeter-pricing: only price, no scheme",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-pricing": { price: 42 },
        },
      });
      await importSpec(tenant.id, user.token, spec);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.equal(endpoint.price, 42);
      t.equal(
        endpoint.scheme,
        null,
        "scheme should remain null when not provided",
      );
    },
  );

  await t.test(
    "partial x-faremeter-pricing: only scheme, no price",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-pricing": { scheme: "exact" },
        },
      });
      await importSpec(tenant.id, user.token, spec);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.equal(
        endpoint.price,
        null,
        "price should remain null when not provided",
      );
      t.equal(endpoint.scheme, "exact");
    },
  );

  await t.test("boundary: price = 0 (free)", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/free": {
        get: {},
        "x-faremeter-pricing": { price: 0 },
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/free")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, 0);
  });

  await t.test("boundary: price = 100000000 (max)", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/max": {
        get: {},
        "x-faremeter-pricing": { price: 100000000 },
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/max")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, 100000000);
  });

  await t.test("boundary: exactly 5 tags (max allowed)", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-tags": ["t1", "t2", "t3", "t4", "t5"],
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.same(endpoint.tags, ["t1", "t2", "t3", "t4", "t5"]);
  });

  await t.test("boundary: 6 tags (over limit) rejected", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-tags": ["t1", "t2", "t3", "t4", "t5", "t6"],
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.same(endpoint.tags, [], "over-limit tags should fall back to empty");
  });

  await t.test("boundary: tag at exactly 50 chars (max length)", async (t) => {
    const { user, tenant } = await setupTenant();

    const longTag = "a".repeat(50);
    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-tags": [longTag],
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.same(endpoint.tags, [longTag]);
  });

  await t.test("boundary: tag at 51 chars (over max) rejected", async (t) => {
    const { user, tenant } = await setupTenant();

    const tooLong = "a".repeat(51);
    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-tags": [tooLong],
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.same(endpoint.tags, [], "over-length tag should fall back to empty");
  });

  await t.test("type mismatch: price as string", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": { price: "500" },
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, null, "string price should be rejected");
  });

  await t.test(
    "type mismatch: x-faremeter-tags as string instead of array",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-tags": "api",
        },
      });
      await importSpec(tenant.id, user.token, spec);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.same(endpoint.tags, [], "string tags should be ignored");
    },
  );

  await t.test("type mismatch: x-faremeter-pricing as string", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": "invalid",
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, null, "non-object pricing should be ignored");
    t.equal(endpoint.scheme, null);
  });

  await t.test("junk values: price as boolean", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": { price: true, scheme: 123 },
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, null);
    t.equal(endpoint.scheme, null);
  });

  await t.test(
    "junk values: tags array with non-string elements",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/users": {
          get: {},
          "x-faremeter-tags": [123, null, true],
        },
      });
      await importSpec(tenant.id, user.token, spec);

      const endpoint = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("path", "=", "/api/users")
        .executeTakeFirstOrThrow();
      t.same(endpoint.tags, [], "non-string tag elements should be rejected");
    },
  );

  await t.test(
    "mixed paths: some with valid extensions, some without, some invalid",
    async (t) => {
      const { user, tenant } = await setupTenant();

      const spec = makeSpec({
        "/api/valid": {
          get: {},
          "x-faremeter-pricing": { price: 100, scheme: "exact" },
          "x-faremeter-tags": ["production"],
        },
        "/api/none": {
          get: {},
        },
        "/api/invalid": {
          get: {},
          "x-faremeter-pricing": { price: -1, scheme: "fake" },
          "x-faremeter-tags": ["UPPERCASE!"],
        },
      });

      const res = await importSpec(tenant.id, user.token, spec);
      t.equal(res.status, 200);

      const endpoints = await db
        .selectFrom("endpoints")
        .selectAll()
        .where("tenant_id", "=", tenant.id)
        .where("is_active", "=", true)
        .execute();
      t.equal(endpoints.length, 3, "all three paths should create endpoints");

      const valid = endpoints.find((e) => e.path === "/api/valid");
      const none = endpoints.find((e) => e.path === "/api/none");
      const invalid = endpoints.find((e) => e.path === "/api/invalid");

      if (!valid) throw new Error("valid endpoint not found");
      t.equal(valid.price, 100);
      t.equal(valid.scheme, "exact");
      t.same(valid.tags, ["production"]);

      if (!none) throw new Error("none endpoint not found");
      t.equal(none.price, null, "no-extension path gets null");
      t.equal(none.scheme, null);

      if (!invalid) throw new Error("invalid endpoint not found");
      t.equal(invalid.price, null, "invalid extensions get null");
      t.equal(invalid.scheme, null);
      t.same(invalid.tags, []);
    },
  );

  await t.test("price as null in x-faremeter-pricing", async (t) => {
    const { user, tenant } = await setupTenant();

    const spec = makeSpec({
      "/api/users": {
        get: {},
        "x-faremeter-pricing": { price: null, scheme: "exact" },
      },
    });
    await importSpec(tenant.id, user.token, spec);

    const endpoint = await db
      .selectFrom("endpoints")
      .selectAll()
      .where("tenant_id", "=", tenant.id)
      .where("path", "=", "/api/users")
      .executeTakeFirstOrThrow();
    t.equal(endpoint.price, null);
    t.equal(endpoint.scheme, "exact");
  });
});
