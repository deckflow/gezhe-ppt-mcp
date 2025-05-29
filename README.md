# gezhe-mcp-server

## 简介
歌者 PPT MCP server， 可以通过话题生成 PPT

### Tools
1. `generate_ppt_by_topic`
   - 输入:
     - `topic` (string): 话题名称
   - 返回: 预览链接

## 使用指引：

### 方法 1：Streamable HTTP
1. 访问并登录 https://gezhe.com/ 
2. 进入「设置-MCP 服务器」页面，复制页面中提供的 URL 地址

<img width="800" alt="image" src="https://github.com/user-attachments/assets/c9d08387-825b-424a-a6c4-0ca600501bc2" />

3. 将其粘贴到 Cherry Studio、Cursor 等客户端中使用。

### 方法 2：本地执行

1. 访问并登录 https://gezhe.com/ 
2. 进入「设置-MCP 服务器」页面，获取页面中提供的 URL 地址，复制 URL 中末尾 API_KEY 的值。
3. 复制以下配置，填入到 Cherry Studio、Cursor 等客户端中使用。
```json
{
  "mcpServers": {
    "歌者PPT": {
      "command": "npx",
      "args": ["-y", "gezhe-mcp-server@latest"],
      "env": {
        "API_KEY": "替换为获取的 API_KEY"
      }
    }
  }
}
```
