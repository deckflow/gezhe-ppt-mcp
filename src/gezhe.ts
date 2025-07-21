#!/usr/bin/env node
import { z } from "zod";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { SSEParser, EventSourceMessage } from "./sseParse.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const GEZHE_API_ROOT = process.env.GEZHE_API_ROOT || "https://pro.gezhe.com/v1";
const GEZHE_APP_DOMAIN = process.env.GEZHE_APP_DOMAIN || "pro.gezhe.com";

const getPayUpgradeUrl = () => {
  return `https://${GEZHE_APP_DOMAIN}/upgrade`;
};
const getMcpSettingUrl = () => {
  return `https://${GEZHE_APP_DOMAIN}/settings`;
};

export const GeneratePptByTopicSchema = z.object({
  topic: z.string().describe("Topic to generate ppt for"),
});

export const createServer = () => {
  const server = new Server(
    {
      name: "gezhe-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: {
          listChanged: false,
        },
      },
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: "generate_ppt_by_topic",
        description: "Generate PowerPoint presentations from topics",
        inputSchema: zodToJsonSchema(GeneratePptByTopicSchema) as ToolInput,
      },
    ];
    return {
      tools,
    };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { authInfo } = extra;
      const { name, arguments: args } = request.params;
      if (name === "generate_ppt_by_topic") {
        const validatedArgs = GeneratePptByTopicSchema.parse(args);
        const { topic } = validatedArgs;
        const apiKey = authInfo?.token || process.env.API_KEY;

        // check api key
        if (!apiKey) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `您的 API Key 无效，请登录歌者检查后重试，歌者MCP服务器设置地址: ${getMcpSettingUrl()}`,
              },
            ],
          };
        }
        try {
          const { outline, taskId } = await genOutline(
            apiKey,
            topic,
            extra.sendNotification
          );

          const { genUrl } = await confirmOutline(
            taskId,
            apiKey,
            outline,
            extra.sendNotification
          );

          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `ppt 已经生成，请点击链接选择模板：${genUrl}`,
                taskId,
                preview_link: genUrl,
              },
            ],
          };
        } catch (error: any) {
          console.error("Error sending notifications:", error);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `ppt 生成失败: ${error.message}`,
              },
            ],
          };
        }
      }
      // Default return for unhandled tool names
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool "${name}" not found.`,
          },
        ],
      };
    }
  );
  return {
    server,
  };
};

// 向 gezhe server 发送 A2A 请求
const makeA2ARequest = async (apiKey: string, requestBody: any) => {
  const response = await fetch(`${GEZHE_API_ROOT}/mcp/gen`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Response-Event-Stream": "yes",
    },
    body: JSON.stringify(requestBody),
  });
  // 401
  if (response.status >= 400) {
    console.error(
      `Failed to generate outline: ${response.status} ${response.statusText}`
    );
    if (response.status === 401) {
      throw new Error(
        `您的 API Key 无效，请登录歌者检查后重试，歌者MCP服务器设置地址: ${getMcpSettingUrl()}`
      );
    }
    throw new Error(`${response.statusText}`);
  }
  return response;
};
const genOutline = async (
  apiKey: string,
  topic: string,
  sendNotification: (notification: any) => Promise<void>
) => {
  const taskId = uuidv4();
  const requestBody = {
    jsonrpc: "2.0",
    id: uuidv4(),
    method: "tasks/sendSubscribe",
    params: {
      id: taskId,
      message: {
        role: "user",
        parts: [{ type: "text", text: `${topic}` }],
      },
    },
  };

  const response = await makeA2ARequest(apiKey, requestBody);
  // response 返回的是 sse 流，需要解析
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  await sendNotification({
    method: "notifications/message",
    params: {
      level: "info",
      data: `正在为您生成  PPT 大纲`,
    },
  });

  let progress = 0;
  let outline = "";

  return new Promise<{ taskId: string; outline: string }>((resolve, reject) => {
    const parser = new SSEParser((message: EventSourceMessage) => {
      try {
        if (message.data) {
          const eventData = JSON.parse(message.data);
          const result = eventData.result;

          if (result && "status" in result) {
            const status = result.status;
            if (status.state === "failed") {
              console.error(`Failed to generate outline: ${status}`);
              const msg = status.message?.parts?.[0]?.text;
              const metadata = status.message?.metadata;
              if (metadata && metadata.insufficientPackage) {
                // 余额不足，引导充值
                reject(
                  new Error(
                    `余额不足，请充值后重试，支付链接：${getPayUpgradeUrl()}`
                  )
                );
                return;
              }
              reject(new Error(msg));
              return;
            }
          }

          if (result && "artifact" in result) {
            const artifact = result.artifact;
            if (artifact.lastChunk) {
              outline += artifact.parts?.[0]?.text;
              // 大纲生成完成
              sendNotification({
                method: "notifications/message",
                params: {
                  level: "info",
                  message: `PPT 大纲生成完成`,
                },
              }).then(() => {
                resolve({ taskId, outline });
              });
            } else {
              progress += 1;
              sendNotification({
                method: "notifications/progress",
                params: {
                  progress: progress,
                  progressToken: artifact.parts?.[0]?.text,
                },
              });
            }
          }
        }
      } catch (error: any) {
        console.error("Error parsing SSE message:", error);
        reject(error);
      }
    });

    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            parser.finish();
            break;
          }
          parser.pushChunk(value);
        }
      } catch (error) {
        reject(error);
      }
    };

    processStream();
  });
};

const confirmOutline = async (
  taskId: string,
  apiKey: string,
  outline: string,
  sendNotification: (notification: any) => Promise<void>
) => {
  const requestBody = {
    jsonrpc: "2.0",
    id: uuidv4(),
    method: "tasks/sendSubscribe",
    params: {
      id: taskId,
      message: {
        role: "user",
        parts: [{ type: "text", text: outline }],
      },
    },
  };

  const response = await makeA2ARequest(apiKey, requestBody);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  await sendNotification({
    method: "notifications/message",
    params: {
      level: "info",
      data: `正在为您生成准备 ppt 模板`,
    },
  });

  return new Promise<{ taskId: string; genUrl: string }>((resolve, reject) => {
    let genUrl = "";

    const parser = new SSEParser((message: EventSourceMessage) => {
      try {
        if (message.data) {
          const eventData = JSON.parse(message.data);
          const result = eventData.result;

          if (result && "status" in result) {
            const status = result.status;
            if (status.state === "failed") {
              console.error(`Failed to generate ppt: ${status}`);
              const msg = status.message?.parts?.[0]?.text;
              const metadata = status.message?.metadata;
              if (metadata && metadata.insufficientPackage) {
                // 余额不足，引导充值
                reject(
                  new Error(
                    `余额不足，请充值后重试，支付链接：${getPayUpgradeUrl()}`
                  )
                );
                return;
              }
              reject(new Error(msg));
              return;
            }
            if (status.state === "input-required") {
              const dataParts = status.message?.parts[0];
              if (dataParts.type === "data" && dataParts.data?.genUrl) {
                genUrl = dataParts.data.genUrl;
                // PPT 生成完成
                sendNotification({
                  method: "notifications/message",
                  params: {
                    level: "info",
                    message: `PPT 已经生成`,
                  },
                }).then(() => {
                  resolve({ taskId, genUrl });
                });
              }
            }
          }
        }
      } catch (error: any) {
        console.error("Error parsing SSE message:", error);
        reject(error);
      }
    });

    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            parser.finish();
            break;
          }
          parser.pushChunk(value);
        }
      } catch (error) {
        reject(error);
      }
    };

    processStream();
  });
};

// get auth info
export const getAuthInfo = (req: express.Request): AuthInfo => {
  // query params or env
  let apiKey = (req.query.API_KEY as string) || process.env.API_KEY;
  // header Authorization
  const authHeader = req.headers.authorization as string | undefined;
  if (!apiKey && authHeader) {
    const [type, token] = authHeader.split(" ");
    apiKey = token;
  }
  if (!apiKey) {
    throw new Error("No valid api key provided");
  }
  return { token: apiKey, clientId: "", scopes: ["Generation"] };
};
