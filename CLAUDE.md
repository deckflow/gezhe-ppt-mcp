# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Gezhe PPT MCP Server - a Model Context Protocol server that integrates with the Gezhe.com PowerPoint generation service. The server provides a single tool `generate_ppt_by_topic` that creates PowerPoint presentations from topic descriptions.

## Architecture

The project follows a modular architecture with multiple entry points:

- **Core Server Logic** (`src/gezhe.ts`): Contains the main MCP server implementation, PPT generation logic, and API communication
- **Entry Points**:
  - `src/index.ts`: Main entry point that dynamically loads different server modes
  - `src/stdio.ts`: Standard I/O MCP server mode
  - `src/sse.ts`: Server-Sent Events mode
  - `src/streamableHttp.ts`: HTTP streaming mode

The server communicates with Gezhe's API using Server-Sent Events (SSE) for real-time progress updates during PPT generation.

## Development Commands

### Build and Development
- `npm run build` - Compile TypeScript and make the output executable
- `npm run watch` - Watch mode for development
- `npm run prepare` - Pre-publish build (runs automatically on npm install)

### Testing and Development Tools
- `npm run inspector` - Run the MCP inspector for debugging
- `npm run start` - Start the default stdio server
- `npm run start:sse` - Start the SSE server
- `npm run start:streamableHttp` - Start the HTTP streaming server

### Local Testing Configuration
Use the provided `mcp-config.json` as a template for MCP client configuration. The API_KEY environment variable must be set with a valid Gezhe API key.

## Key Implementation Details

### PPT Generation Flow
1. **Outline Generation**: First API call generates a structured PPT outline
2. **Template Preparation**: Second API call prepares templates and returns a generation URL
3. **Progress Notifications**: Real-time updates via MCP notifications during generation

### Error Handling
- Authentication errors return helpful messages with setup URLs
- Insufficient balance errors redirect users to upgrade page
- Network and API errors are properly caught and reported

### Environment Configuration
- `GEZHE_API_ROOT`: API endpoint (defaults to https://pro.gezhe.com/v1)
- `GEZHE_APP_DOMAIN`: App domain for URLs (defaults to pro.gezhe.com)
- `API_KEY`: Required authentication token

## MCP Integration

The server supports multiple MCP transport modes:
- **stdio**: Standard input/output (default for most MCP clients)
- **sse**: Server-sent events for web-based integrations
- **streamableHttp**: HTTP streaming for advanced use cases

Authentication is handled via environment variables or HTTP headers/query parameters depending on the transport mode.