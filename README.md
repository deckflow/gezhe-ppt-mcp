# gezhe-mcp-server

歌者 PPT gezhe.com MCP server

---
## Features
Generate PowerPoint presentations from topics

## Tools
1. `generate_ppt_by_topic`
   - Generate PowerPoint presentations from topics
   - Inputs:
     - `topic` (string): Topic to generate ppt for
   - Returns: preview url

## Install and Run Locally

To install the dependencies, run:

```bash
npm install
```

Then build:

```bash
npm run build
```

## Running the Server

### Production Mode

To run the server in production mode:

```bash
npm start
# or directly with
node build/index.js
```


It runs on port 3000 by default. If you need another port, you can specify with the PORT env var.

```bash
PORT=3002 npm start
# or
PORT=3002 node build/index.js
```

### Development Mode

For development, you can use the dev mode which automatically watches for changes in your source files, rebuilds, and restarts the server:

```bash
npm run dev
```

With a custom port:

```bash
PORT=3002 npm run dev
```

## Setup Config

You can connect a client to your Streamable HTTP MCP Server once it's running. Configure per the client's configuration. There is the [mcp-config.json](/mcp-config.json) that has an example configuration that looks like this:

### gezhe ppt MCP API Key
https://pro.gezhe.com/settings

### NPX
```json
{
  "mcpServers": {
    "gezhe-mcp-server": {
      "command": "npx",
      "args": ["-y", "gezhe-mcp-server"],
      "env": {
        "API_KEY": "gezhe mcp api key"
      }
    }
  }
}
```

### DOCKER
```json
{
  "mcpServers": {
    "gezhe-mcp-server": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "API_KEY", "gezhe/gezhe-mcp-server"],
      "env": {
        "API_KEY": "your_key_here"
      }
    }
  }
}
```





