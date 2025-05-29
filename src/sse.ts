import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createServer, getAuthInfo } from "./gezhe.js";

console.error("Starting SSE server...");

const app = express();

const { server } = createServer();

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  console.error("Received connection");
  const authInfo = getAuthInfo(req);
  (req as any).auth = authInfo;
  transport = new SSEServerTransport("/message", res);

  await server.connect(transport);

  server.onclose = async () => {
    await server.close();
  };
});

app.post("/message", async (req, res) => {
  console.error("Received message");
  const authInfo = getAuthInfo(req);
  (req as any).auth = authInfo;
  await transport.handlePostMessage(req, res);
});

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.error(`Server is running on port ${PORT}`);
});
