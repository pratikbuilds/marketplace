import { Hono } from "hono";
import { serve } from "@hono/node-server";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/v1/chat/completions", async (c) => {
  const body: unknown = await c.req.json().catch((): unknown => ({}));
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  };

  return c.json({
    id: "local-demo",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello from the local marketplace publisher mock.",
        },
      },
    ],
    usage,
    upstream: {
      received: body,
      host: c.req.header("host"),
      path: new URL(c.req.url).pathname,
    },
  });
});

app.post("/v1/local-check/:name", async (c) => {
  const body: unknown = await c.req.json().catch((): unknown => ({}));
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  };

  return c.json({
    id: c.req.param("name"),
    object: "local.check",
    message: "Hello from a dynamically created marketplace endpoint.",
    usage,
    upstream: {
      received: body,
      host: c.req.header("host"),
      path: new URL(c.req.url).pathname,
    },
  });
});

serve({ fetch: app.fetch, port: PORT });
