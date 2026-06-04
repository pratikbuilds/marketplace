import t from "tap";

const dashURL = "http://faremeter-dash.example.test";
const originalFetch = globalThis.fetch;
const originalDashURL = process.env.FAREMETER_DASH_API_URL;
const originalDashKey = process.env.FAREMETER_DASH_API_KEY;
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

process.env.FAREMETER_DASH_API_URL = dashURL;
process.env.FAREMETER_DASH_API_KEY = "test-key";
process.env.SOLANA_NETWORK = "devnet";

t.teardown(() => {
  globalThis.fetch = originalFetch;
  if (originalDashURL === undefined) {
    delete process.env.FAREMETER_DASH_API_URL;
  } else {
    process.env.FAREMETER_DASH_API_URL = originalDashURL;
  }
  if (originalDashKey === undefined) {
    delete process.env.FAREMETER_DASH_API_KEY;
  } else {
    process.env.FAREMETER_DASH_API_KEY = originalDashKey;
  }
  if (originalSolanaNetwork === undefined) {
    delete process.env.SOLANA_NETWORK;
  } else {
    process.env.SOLANA_NETWORK = originalSolanaNetwork;
  }
});

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

const fetchCalls: FetchCall[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return null;
  }
  return JSON.parse(body);
}

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const [input, init] = args;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.startsWith(dashURL)) {
    throw new Error(`Unexpected fetch URL: ${url}`);
  }

  const body = readBody(init?.body);
  const path = url.slice(dashURL.length);
  const method = init?.method ?? "GET";
  fetchCalls.push({ method, path, body });

  if (method === "POST" && path === "/accounts") {
    const payload = isRecord(body) ? body : {};
    return response({
      data: {
        id: 123,
        name: typeof payload.name === "string" ? payload.name : "",
        access_token:
          typeof payload.access_token === "string" ? payload.access_token : "",
        grafana_dashboard_url: null,
        is_active: true,
        created_at: "2026-06-05T00:00:00.000Z",
      },
    });
  }

  if (method === "GET" && path.startsWith("/accounts?")) {
    return response({
      data: [
        {
          id: 123,
          name: "tenant-devnet",
          access_token: "access-token",
          grafana_dashboard_url: null,
          is_active: true,
          created_at: "2026-06-05T00:00:00.000Z",
        },
      ],
      meta: { total: 1, limit: 1, offset: 0, has_more: false },
    });
  }

  if (method === "GET" && path.startsWith("/tracked-addresses?")) {
    return response({
      data: [
        {
          id: 456,
          account_id: 123,
          chain: "solana-devnet",
          address: "old-devnet-address",
          is_active: true,
          created_at: "2026-06-05T00:00:00.000Z",
        },
      ],
      meta: { total: 1, limit: 100, offset: 0, has_more: false },
    });
  }

  if (method === "DELETE" && path === "/tracked-addresses/456") {
    return response({
      data: {
        id: 456,
        account_id: 123,
        chain: "solana-devnet",
        address: "old-devnet-address",
        is_active: false,
        created_at: "2026-06-05T00:00:00.000Z",
      },
    });
  }

  if (method === "POST" && path === "/tracked-addresses") {
    const payload = isRecord(body) ? body : {};
    return response({
      data: {
        id: 789,
        account_id:
          typeof payload.account_id === "number" ? payload.account_id : 0,
        chain: typeof payload.chain === "string" ? payload.chain : "",
        address: typeof payload.address === "string" ? payload.address : "",
        is_active: true,
        created_at: "2026-06-05T00:00:00.000Z",
      },
    });
  }

  throw new Error(`Unexpected fetch request: ${method} ${path}`);
};

const { setupAccountWithAddresses, updateAccountAddresses } = await import(
  "./faremeter-dash.js"
);

await t.test("tracks Solana dashboard addresses on devnet", async (t) => {
  await setupAccountWithAddresses("tenant-devnet", "access-token", {
    solana: "new-devnet-address",
  });
  await updateAccountAddresses("tenant-devnet", {
    solana: "updated-devnet-address",
  });

  const solanaTrackingCalls = fetchCalls.filter(
    (call) =>
      call.method === "POST" &&
      call.path === "/tracked-addresses" &&
      isRecord(call.body) &&
      typeof call.body.address === "string" &&
      call.body.address.includes("devnet"),
  );

  t.same(
    solanaTrackingCalls.map((call) =>
      isRecord(call.body) ? call.body.chain : null,
    ),
    ["solana-devnet", "solana-devnet"],
  );
});
