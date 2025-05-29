# gezhe-mcp-server

## 简介
歌者 PPT MCP server， 可以通过话题生成 PPT

### Tools
1. `generate_ppt_by_topic`
   - 输入:
     - `topic` (string): 话题名称
   - 返回: 预览链接

## 使用指引：

### 方法 1：Stream Http 
1. 访问并登录 https://gezhe.com/ 
2. 进入「设置-MCP 服务器」页面，复制页面中提供的 URL 地址

<img width="800" alt="image" src="https://github.com/user-attachments/assets/53d01c39-a455-4533-929e-840746704aaa" />

3. 将其粘贴到 Cherry Studio、Cursor 等客户端中使用。

### 方法 2：本地执行

1. 访问并登录 https://gezhe.com/ 
2. 进入「设置-MCP 服务器」页面，获取页面中提供的 URL 地址，复制 URL 中末尾 token 的值。
3. 复制一些配置，填入到 Cherry Studio、Cursor 等客户端中使用。
```json
{
  "mcpServers": {
    "歌者PPT": {
      "command": "npx",
      "args": ["-y", "gezhe-mcp-server"],
      "env": {
        "API_KEY": "替换为获取的 token"
      }
    }
  }
}
```
