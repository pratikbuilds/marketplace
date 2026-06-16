import { Hono } from "hono";
import { serve } from "@hono/node-server";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

const app = new Hono();

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Local Marketplace Publisher Mock",
    version: "1.0.0",
    description:
      "OpenAPI schema for the local publisher mock used by the Marketplace developer stack.",
  },
  paths: {
    "/v1/chat/completions": {
      "x-faremeter-tags": ["chat", "local-publisher"],
      "x-faremeter-pricing": {
        scheme: "flex",
        rules: [
          {
            match: "$",
            authorize:
              "(jsonSize($.request.body.messages) / 4 * 10 + coalesce($.request.body.max_tokens, 1024) * 40) * 120 / 100",
            capture:
              "$.response.body.usage.prompt_tokens * 10 + $.response.body.usage.completion_tokens * 40",
          },
        ],
      },
      post: {
        summary: "Create a local chat completion",
        operationId: "createLocalChatCompletion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ChatCompletionRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Local chat completion response",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatCompletionResponse",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ChatCompletionRequest: {
        type: "object",
        required: ["model", "messages"],
        properties: {
          model: {
            type: "string",
            example: "local-demo",
          },
          messages: {
            type: "array",
            items: {
              $ref: "#/components/schemas/ChatMessage",
            },
          },
          max_tokens: {
            type: "integer",
            minimum: 1,
          },
        },
        additionalProperties: true,
      },
      ChatMessage: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: {
            type: "string",
            enum: ["system", "user", "assistant", "tool"],
          },
          content: {
            type: "string",
          },
        },
        additionalProperties: true,
      },
      ChatCompletionResponse: {
        type: "object",
        required: ["id", "object", "choices", "usage", "upstream"],
        properties: {
          id: {
            type: "string",
          },
          object: {
            type: "string",
            enum: ["chat.completion"],
          },
          choices: {
            type: "array",
            items: {
              type: "object",
              required: ["index", "message"],
              properties: {
                index: {
                  type: "integer",
                },
                message: {
                  $ref: "#/components/schemas/ChatMessage",
                },
              },
              additionalProperties: true,
            },
          },
          usage: {
            $ref: "#/components/schemas/Usage",
          },
          upstream: {
            $ref: "#/components/schemas/UpstreamEcho",
          },
        },
        additionalProperties: true,
      },
      LocalCheckResponse: {
        type: "object",
        required: ["id", "object", "message", "upstream"],
        properties: {
          id: {
            type: "string",
          },
          object: {
            type: "string",
            enum: ["local.check"],
          },
          message: {
            type: "string",
          },
          upstream: {
            $ref: "#/components/schemas/UpstreamEcho",
          },
        },
        additionalProperties: true,
      },
      Usage: {
        type: "object",
        required: ["prompt_tokens", "completion_tokens", "total_tokens"],
        properties: {
          prompt_tokens: {
            type: "integer",
          },
          completion_tokens: {
            type: "integer",
          },
          total_tokens: {
            type: "integer",
          },
        },
      },
      UpstreamEcho: {
        type: "object",
        required: ["received", "host", "path"],
        properties: {
          received: {
            type: "object",
            additionalProperties: true,
          },
          host: {
            type: "string",
            nullable: true,
          },
          path: {
            type: "string",
          },
        },
        additionalProperties: true,
      },
    },
  },
};

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/openapi.json", (c) => c.json(openApiSpec));

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

  return c.json({
    id: c.req.param("name"),
    object: "local.check",
    message: "Hello from a dynamically created marketplace endpoint.",
    upstream: {
      received: body,
      host: c.req.header("host"),
      path: new URL(c.req.url).pathname,
    },
  });
});

serve({ fetch: app.fetch, port: PORT });
