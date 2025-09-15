#!/usr/bin/env node
import { z } from "zod";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  SetLevelRequestSchema,
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
const REQUEST_TIMEOUT = 300000; // 5分钟超时
const MAX_CONCURRENT_REQUESTS = 100; // 最大并发请求数

// 请求计数器
let activeRequests = 0;

const getPayUpgradeUrl = () => {
  return `https://${GEZHE_APP_DOMAIN}/upgrade`;
};
const getMcpSettingUrl = () => {
  return `https://${GEZHE_APP_DOMAIN}/settings`;
};

export const GeneratePptByTopicSchema = z.object({
  topic: z.string().describe("Topic to generate ppt for"),
});

// 创建一个可取消的 Promise
class CancellablePromise<T> {
  private abortController: AbortController;
  private promise: Promise<T>;

  constructor(
    executor: (
      resolve: (value: T) => void,
      reject: (reason?: any) => void,
      signal: AbortSignal
    ) => void
  ) {
    this.abortController = new AbortController();
    this.promise = new Promise<T>((resolve, reject) => {
      executor(resolve, reject, this.abortController.signal);
    });
  }

  getPromise(): Promise<T> {
    return this.promise;
  }

  cancel(): void {
    this.abortController.abort();
  }
}

// 带超时的 Promise
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

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

  let currentLogLevel = "info";

  // 添加 logging/setLevel 处理器
  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params || {};
    const validLevels = ["error", "warn", "info", "debug"];
    if (level && validLevels.includes(level)) {
      currentLogLevel = level;
      console.log(`[MCP Server] Log level set to: ${level}`);
    } else {
      console.warn(
        `[MCP Server] Invalid log level: ${level}, keeping current: ${currentLogLevel}`
      );
    }
    return {};
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      // 检查并发限制
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "服务器繁忙，请稍后重试",
            },
          ],
        };
      }

      activeRequests++;

      try {
        const { authInfo } = extra;
        const { name, arguments: args } = request.params;

        if (name === "generate_ppt_by_topic") {
          const validatedArgs = GeneratePptByTopicSchema.parse(args);
          const { topic } = validatedArgs;
          const apiKey = authInfo?.token || process.env.API_KEY;

          if (!apiKey) {
            console.error("No valid api key provided");
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
            // 添加超时保护
            const { outline, taskId } = await withTimeout(
              genOutline(apiKey, topic, extra.sendNotification),
              REQUEST_TIMEOUT,
              "生成大纲超时，请重试"
            );

            await withTimeout(
              confirmOutline(taskId, apiKey, outline, extra.sendNotification),
              REQUEST_TIMEOUT,
              "确认大纲超时，请重试"
            );

            const { genUrl } = await withTimeout(
              confirmForm(taskId, apiKey, extra.sendNotification),
              REQUEST_TIMEOUT,
              "生成PPT超时，请重试"
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
            console.error("Error generating PPT:", error);
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

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool "${name}" not found.`,
            },
          ],
        };
      } finally {
        activeRequests--;
      }
    }
  );

  return {
    server,
  };
};

// 向 gezhe server 发送 A2A 请求
const makeA2ARequest = async (
  apiKey: string,
  requestBody: any,
  signal?: AbortSignal
) => {
  console.log(`makeA2ARequest: ${GEZHE_API_ROOT}/mcp/gen`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${GEZHE_API_ROOT}/mcp/gen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Response-Event-Stream": "yes",
      },
      body: JSON.stringify(requestBody),
      signal: signal || controller.signal,
    });

    clearTimeout(timeoutId);

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
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("请求超时");
    }
    throw error;
  }
};

// 优化的流处理函数
async function processSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onMessage: (message: EventSourceMessage) => void,
  signal?: AbortSignal
): Promise<void> {
  const parser = new SSEParser(onMessage);
  const decoder = new TextDecoder();

  try {
    while (true) {
      // 检查是否被取消
      if (signal?.aborted) {
        throw new Error("Stream processing cancelled");
      }

      const { done, value } = await reader.read();

      if (done) {
        parser.finish();
        break;
      }

      if (value) {
        parser.pushChunk(value);
      }
    }
  } finally {
    // 确保 reader 被释放
    try {
      await reader.cancel();
    } catch (e) {
      // 忽略取消错误
    }
  }
}

const genOutline = async (
  apiKey: string,
  topic: string,
  sendNotification: (notification: any) => Promise<void>
): Promise<{ taskId: string; outline: string }> => {
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

  const abortController = new AbortController();
  const response = await makeA2ARequest(
    apiKey,
    requestBody,
    abortController.signal
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  await sendNotification({
    method: "notifications/message",
    params: {
      level: "info",
      data: `正在为您生成 PPT 大纲`,
    },
  });

  let progress = 0;
  let outline = "";
  let isResolved = false;

  return new Promise<{ taskId: string; outline: string }>((resolve, reject) => {
    const cleanup = () => {
      isResolved = true;
      abortController.abort();
      reader.cancel().catch(() => {});
    };

    const handleMessage = (message: EventSourceMessage) => {
      if (isResolved) return;

      try {
        if (message.data) {
          const eventData = JSON.parse(message.data);
          const result = eventData.result;

          if (result && "status" in result) {
            const status = result.status;
            if (status.state === "failed") {
              console.error(
                `Failed to generate outline: ${JSON.stringify(status)}`
              );
              const msg = status.message?.parts?.[0]?.text;
              const metadata = status.message?.metadata;

              cleanup();

              if (metadata && metadata.insufficientPackage) {
                reject(
                  new Error(
                    `余额不足，请充值后重试，支付链接：${getPayUpgradeUrl()}`
                  )
                );
              } else {
                reject(new Error(msg || "生成失败"));
              }
              return;
            }
          }

          if (result && "artifact" in result) {
            const artifact = result.artifact;
            if (artifact.lastChunk) {
              outline += artifact.parts?.[0]?.text || "";

              sendNotification({
                method: "notifications/message",
                params: {
                  level: "info",
                  message: `PPT 大纲生成完成`,
                },
              })
                .then(() => {
                  cleanup();
                  resolve({ taskId, outline });
                })
                .catch((err) => {
                  cleanup();
                  reject(err);
                });
            } else {
              outline += artifact.parts?.[0]?.text || "";
              progress += 1;

              // 异步发送进度通知，不阻塞流处理
              sendNotification({
                method: "notifications/progress",
                params: {
                  progress: progress,
                  progressToken: artifact.parts?.[0]?.text,
                },
              }).catch(console.error);
            }
          }
        }
      } catch (error: any) {
        console.error("Error parsing SSE message:", error);
        cleanup();
        reject(error);
      }
    };

    // 开始处理流
    processSSEStream(reader, handleMessage, abortController.signal).catch(
      (error) => {
        if (!isResolved) {
          cleanup();
          reject(error);
        }
      }
    );

    // 设置超时
    setTimeout(() => {
      if (!isResolved) {
        cleanup();
        reject(new Error("生成大纲超时"));
      }
    }, REQUEST_TIMEOUT);
  });
};

const confirmOutline = async (
  taskId: string,
  apiKey: string,
  outline: string,
  sendNotification: (notification: any) => Promise<void>
): Promise<{ taskId: string }> => {
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

  const abortController = new AbortController();
  const response = await makeA2ARequest(
    apiKey,
    requestBody,
    abortController.signal
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  await sendNotification({
    method: "notifications/message",
    params: {
      level: "info",
      data: `正在为您准备 PPT 模板`,
    },
  });

  let isResolved = false;

  return new Promise<{ taskId: string }>((resolve, reject) => {
    const cleanup = () => {
      isResolved = true;
      abortController.abort();
      reader.cancel().catch(() => {});
    };

    const handleMessage = (message: EventSourceMessage) => {
      if (isResolved) return;

      try {
        if (message.data) {
          const eventData = JSON.parse(message.data);
          const result = eventData.result;

          if (result && "status" in result) {
            const status = result.status;
            if (status.state === "failed") {
              console.error(
                `Failed to generate ppt: ${JSON.stringify(status)}`
              );
              const msg = status.message?.parts?.[0]?.text;
              const metadata = status.message?.metadata;

              cleanup();

              if (metadata && metadata.insufficientPackage) {
                reject(
                  new Error(
                    `余额不足，请充值后重试，支付链接：${getPayUpgradeUrl()}`
                  )
                );
              } else {
                reject(new Error(msg || "确认失败"));
              }
              return;
            }

            if (status.state === "input-required") {
              const dataParts = status.message?.parts[0];
              if (
                dataParts.type === "data" &&
                dataParts.data?.type === "form"
              ) {
                sendNotification({
                  method: "notifications/message",
                  params: {
                    level: "info",
                    message: `补充信息确认`,
                  },
                })
                  .then(() => {
                    cleanup();
                    resolve({ taskId });
                  })
                  .catch((err) => {
                    cleanup();
                    reject(err);
                  });
              }
            }
          }
        }
      } catch (error: any) {
        console.error("Error parsing SSE message:", error);
        cleanup();
        reject(error);
      }
    };

    processSSEStream(reader, handleMessage, abortController.signal).catch(
      (error) => {
        if (!isResolved) {
          cleanup();
          reject(error);
        }
      }
    );

    setTimeout(() => {
      if (!isResolved) {
        cleanup();
        reject(new Error("确认大纲超时"));
      }
    }, REQUEST_TIMEOUT);
  });
};

const confirmForm = async (
  taskId: string,
  apiKey: string,
  sendNotification: (notification: any) => Promise<void>
): Promise<{ taskId: string; genUrl: string }> => {
  const requestBody = {
    jsonrpc: "2.0",
    id: uuidv4(),
    method: "tasks/sendSubscribe",
    params: {
      id: taskId,
      message: {
        role: "user",
        parts: [{ type: "data", data: {} }],
      },
    },
  };

  const abortController = new AbortController();
  const response = await makeA2ARequest(
    apiKey,
    requestBody,
    abortController.signal
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  let isResolved = false;
  let genUrl = "";

  return new Promise<{ taskId: string; genUrl: string }>((resolve, reject) => {
    const cleanup = () => {
      isResolved = true;
      abortController.abort();
      reader.cancel().catch(() => {});
    };

    const handleMessage = (message: EventSourceMessage) => {
      if (isResolved) return;

      try {
        if (message.data) {
          const eventData = JSON.parse(message.data);
          const result = eventData.result;

          if (result && "status" in result) {
            const status = result.status;
            if (status.state === "failed") {
              console.error(
                `Failed to generate ppt: ${JSON.stringify(status)}`
              );
              const msg = status.message?.parts?.[0]?.text;
              const metadata = status.message?.metadata;

              cleanup();

              if (metadata && metadata.insufficientPackage) {
                reject(
                  new Error(
                    `余额不足，请充值后重试，支付链接：${getPayUpgradeUrl()}`
                  )
                );
              } else {
                reject(new Error(msg || "生成失败"));
              }
              return;
            }

            if (status.state === "input-required") {
              const dataParts = status.message?.parts[0];
              if (dataParts.type === "data" && dataParts.data?.genUrl) {
                genUrl = dataParts.data.genUrl;

                sendNotification({
                  method: "notifications/message",
                  params: {
                    level: "info",
                    message: `PPT 已经生成`,
                  },
                })
                  .then(() => {
                    cleanup();
                    resolve({ taskId, genUrl });
                  })
                  .catch((err) => {
                    cleanup();
                    reject(err);
                  });
              }
            }
          }
        }
      } catch (error: any) {
        console.error("Error parsing SSE message:", error);
        cleanup();
        reject(error);
      }
    };

    processSSEStream(reader, handleMessage, abortController.signal).catch(
      (error) => {
        if (!isResolved) {
          cleanup();
          reject(error);
        }
      }
    );

    setTimeout(() => {
      if (!isResolved) {
        cleanup();
        reject(new Error("生成PPT超时"));
      }
    }, REQUEST_TIMEOUT);
  });
};

// get auth info
export const getAuthInfo = (req: express.Request): AuthInfo => {
  let apiKey = (req.query.API_KEY as string) || process.env.API_KEY;
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
