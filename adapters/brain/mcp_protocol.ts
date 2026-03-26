export enum McpVersion {
  V2024_11_05 = "2024-11-05",
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpMessage {
  method: string;
  params?: Record<string, unknown>;
}

export interface McpRequest extends McpMessage {
  method: string;
}

export interface McpResponse {
  method: string;
  data?: unknown;
  error?: JsonRpcError;
}

export enum McpErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

export class McpError extends Error {
  constructor(
    message: string,
    public code: McpErrorCode,
    public data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}
