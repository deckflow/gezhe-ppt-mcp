import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import express, { Request, Response } from "express";
import { createServer, getAuthInfo, activeRequests } from "./gezhe.js";
import { randomUUID } from "node:crypto";

console.error("Starting Streamable HTTP server...");

const app = express();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无活动则清理（兜底）
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 每 60 秒检查一次
const CLOSE_DELAY_AFTER_COMPLETE_MS = 5 * 1000; // 工具完成后 5 秒关闭 session（留时间发送响应）

// Store both transport and its dedicated server instance for each session
const sessions: {
  [sessionId: string]: {
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createServer>["server"];
    lastActivity: number;
  };
} = {};

// 定期清理超时 session
setInterval(async () => {
  const now = Date.now();
  const sessionIds = Object.keys(sessions);
  for (const sessionId of sessionIds) {
    const session = sessions[sessionId];
    if (!session) continue;
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.error(`Session ${sessionId} timed out, cleaning up`);
      try {
        await session.transport.close();
        await session.server.close();
      } catch (error) {
        console.error(`Error cleaning up session ${sessionId}:`, error);
      }
      delete sessions[sessionId];
    }
  }
  if (sessionIds.length > 0) {
    console.error(`Active sessions: ${Object.keys(sessions).length}`);
  }
}, SESSION_CLEANUP_INTERVAL_MS);

// 健康检查和监控端点
app.get("/health", (_req: Request, res: Response) => {
  const sessionCount = Object.keys(sessions).length;
  res.json({
    status: "ok",
    sessions: sessionCount,
    activeRequests,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  console.error("Received MCP POST request");
  try {
    const authInfo = getAuthInfo(req);
    (req as any).auth = authInfo;

    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions[sessionId]) {
      // Reuse existing transport for this session
      transport = sessions[sessionId].transport;
    } else if (!sessionId) {
      // New initialization request - create a dedicated server for this session
      const { server } = createServer({
        onToolComplete: () => {
          // 工具执行完毕后，延迟关闭 session（留时间让响应发送完毕）
          setTimeout(async () => {
            const sid = transport.sessionId;
            if (sid && sessions[sid]) {
              console.error(`Tool completed, closing session ${sid}`);
              try {
                await transport.close();
                await sessions[sid].server.close();
              } catch (error) {
                console.error(`Error closing session ${sid} after tool complete:`, error);
              }
              delete sessions[sid];
            }
          }, CLOSE_DELAY_AFTER_COMPLETE_MS);
        },
      });
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore, // Enable resumability
        onsessioninitialized: (sessionId) => {
          // Store both the transport and server by session ID when session is initialized
          // This avoids race conditions where requests might come in before the session is stored
          console.error(`Session initialized with ID: ${sessionId}`);
          sessions[sessionId] = { transport, server, lastActivity: Date.now() };
        },
      });

      // Set up onclose handler to clean up session when closed
      transport.onclose = async () => {
        const sid = transport.sessionId;
        if (sid && sessions[sid]) {
          console.error(
            `Transport closed for session ${sid}, cleaning up session`
          );

          // Close the server instance for this session
          try {
            await sessions[sid].server.close();
            console.error(`Closed server for session ${sid}`);
          } catch (error) {
            console.error(`Error closing server for session ${sid}:`, error);
          }

          // Remove the session
          delete sessions[sid];
        }
      };

      // Connect the transport to its dedicated MCP server BEFORE handling the request
      // so responses can flow back through the same transport
      await server.connect(transport);
      console.error(`Connected new transport to dedicated server instance`);

      await transport.handleRequest(req, res);
      return; // Already handled
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: req?.body?.id,
      });
      return;
    }

    // Update last activity time
    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].lastActivity = Date.now();
    }

    // Handle the request with existing transport - no need to reconnect
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: req?.body?.id,
      });
      return;
    }
  }
});

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
app.get("/mcp", async (req: Request, res: Response) => {
  console.error("Received MCP GET request");
  const authInfo = getAuthInfo(req);
  (req as any).auth = authInfo;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: req?.body?.id,
    });
    return;
  }

  // Check for Last-Event-ID header for resumability
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId) {
    console.error(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.error(`Establishing new SSE stream for session ${sessionId}`);
  }

  // Update last activity time
  sessions[sessionId].lastActivity = Date.now();

  const transport = sessions[sessionId].transport;
  await transport.handleRequest(req, res);
});

// Handle DELETE requests for session termination (according to MCP spec)
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: req?.body?.id,
    });
    return;
  }

  console.error(
    `Received session termination request for session ${sessionId}`
  );

  try {
    const authInfo = getAuthInfo(req);
    (req as any).auth = authInfo;
    const transport = sessions[sessionId].transport;
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling session termination:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Error handling session termination",
        },
        id: req?.body?.id,
      });
      return;
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.error(`MCP Streamable HTTP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on("SIGINT", async () => {
  console.error("Shutting down server...");

  // Close all active sessions to properly clean up resources
  for (const sessionId in sessions) {
    try {
      console.error(`Closing session ${sessionId}`);
      const { transport, server } = sessions[sessionId];

      // Close both transport and server
      await transport.close();
      await server.close();
      delete sessions[sessionId];
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  }

  console.error("Server shutdown complete");
  process.exit(0);
});
