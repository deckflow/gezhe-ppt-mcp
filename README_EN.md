# Gezhe-MCP-server

## Introduction
Gezhe PPT MCP server, can generate PPTs based on topics.

### Tools
1. `generate_ppt_by_topic`
   - Input:
     - `topic` (string): Topic name
   - Returns: Preview link

## Usage Guide:

### Method 1: Streamable HTTP
1. Visit and log in to https://gezhe.com/
2. Go to the "Settings - MCP Server" page and copy the URL provided on the page.

<img width="800" alt="image" src="https://github.com/user-attachments/assets/c9d08387-825b-424a-a6c4-0ca600501bc2" />

3. Paste it into clients such as Cherry Studio, Cursor, etc.

### Method 2: Run Locally

1. Visit and log in to https://gezhe.com/
2. Go to the "Settings - MCP Server" page, get the URL provided on the page, and copy the API_KEY value at the end of the URL.
3. Copy the following configuration and fill it into clients such as Cherry Studio, Cursor, etc.
```json
{
  "mcpServers": {
    "Gezhe PPT": {
      "command": "npx",
      "args": ["-y", "gezhe-mcp-server@latest"],
      "env": {
        "API_KEY": "Replace with the obtained API_KEY"
      }
    }
  }
}
```
