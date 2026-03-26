#!/usr/bin/env node

/**
 * Overmind MCP Bridge for Claude Code
 *
 * Bridges Claude Code tool calls to the Overmind kernel via neural_link HTTP API.
 * Tools exposed:
 *   - overmind_delegate: Send work to the Overmind swarm
 *   - overmind_status:   Get swarm/kernel status
 *   - overmind_cancel:   Cancel a running objective
 */

"use strict";

const NEURAL_LINK_URL = process.env.OVERMIND_NEURAL_LINK_URL || "http://localhost:9961/mcp";
const OVERMIND_ROOM_ID = process.env.OVERMIND_ROOM_ID || "";
const PARTICIPANT_ID = process.env.OVERMIND_PARTICIPANT_ID || "claudecode-overmind";
const KERNEL_HTTP_URL = process.env.OVERMIND_KERNEL_HTTP_URL || "http://localhost:8080";

// ─── JSON-RPC over stdio transport ─────────────────────────────────────────────

let requestId = 0;
let sessionId = null;
let pendingRequests = new Map();
let stdinBuffer = "";

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  process.stdout.write(msg);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
  process.stdout.write(msg);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  process.stdout.write(msg);
}

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split("\n");
  stdinBuffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      console.error("[overmind-mcp] Failed to parse message:", e.message);
    }
  }
});

function handleMessage(msg) {
  if (msg.id !== undefined) {
    // Response
    const resolver = pendingRequests.get(msg.id);
    if (resolver) {
      pendingRequests.delete(msg.id);
      if (msg.error) {
        resolver.reject(new Error(msg.error.message));
      } else {
        resolver.resolve(msg.result);
      }
    }
  } else if (msg.method) {
    // Request or notification
    handleRequest(msg.method, msg.params || {}, msg.id);
  }
}

async function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    process.stdin.write(payload + "\n");

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

// ─── MCP request handlers ─────────────────────────────────────────────────────

async function handleRequest(method, params, id) {
  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "overmind", version: "0.1.0" },
      });
      break;

    case "initialized":
      break;

    case "tools/list":
      sendResponse(id, {
        tools: [
          {
            name: "overmind_delegate",
            description: "Delegate work to the Overmind swarm coordinator via neural_link",
            inputSchema: {
              type: "object",
              properties: {
                objective: { type: "string", description: "The objective to accomplish" },
                mode: {
                  type: "string",
                  enum: ["scout", "relay", "swarm"],
                  description: "Execution mode (scout=parallel context, relay=sequential pipeline, swarm=parallel with verify/fix)"
                },
                priority: {
                  type: "number",
                  enum: [0, 1, 2, 3, 4],
                  description: "Priority (0=critical, 1=high, 2=medium, 3=low, 4=backlog)",
                  default: 4
                }
              },
              required: ["objective"]
            }
          },
          {
            name: "overmind_status",
            description: "Get Overmind kernel and swarm status",
            inputSchema: { type: "object", properties: {} }
          },
          {
            name: "overmind_cancel",
            description: "Cancel a running objective",
            inputSchema: {
              type: "object",
              properties: {
                objective_id: { type: "string", description: "ID of the objective to cancel" }
              },
              required: ["objective_id"]
            }
          },
          {
            name: "overmind_room_join",
            description: "Join an Overmind neural_link room for coordination",
            inputSchema: {
              type: "object",
              properties: {
                room_id: { type: "string", description: "Room ID to join" },
                display_name: { type: "string", description: "Display name", default: "Claude Code" }
              },
              required: ["room_id"]
            }
          }
        ]
      });
      break;

    case "tools/call": {
      const { name, arguments: args = {} } = params;
      try {
        const result = await handleToolCall(name, args);
        sendResponse(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        sendResponse(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function neuralLinkFetch(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(`${NEURAL_LINK_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (resp.headers.has("Mcp-Session-Id")) {
    sessionId = resp.headers.get("Mcp-Session-Id");
  }

  return resp;
}

async function handleToolCall(name, args) {
  switch (name) {
    case "overmind_delegate":
      return delegateToOvermind(args.objective, args.mode, args.priority);

    case "overmind_status":
      return getOvermindStatus();

    case "overmind_cancel":
      return cancelObjective(args.objective_id);

    case "overmind_room_join":
      return joinRoom(args.room_id, args.display_name);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function delegateToOvermind(objective, mode = "scout", priority = 4) {
  if (!OVERMIND_ROOM_ID) {
    // Try kernel HTTP if no room configured
    if (KERNEL_HTTP_URL) {
      try {
        const resp = await fetch(`${KERNEL_HTTP_URL}/objective`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective, mode, priority })
        });
        if (resp.ok) {
          const data = await resp.json();
          return { success: true, objective_id: data.objective_id, mode };
        }
      } catch (e) {
        // Fall through to neural_link
      }
    }

    // No room configured - try neural_link room_open first
    const openResp = await neuralLinkFetch("/room/open", {
      title: `overmind-${Date.now()}`,
      participant_id: PARTICIPANT_ID,
      display_name: "Overmind Lead",
      purpose: "Overmind kernel coordination",
      interaction_mode: "informative"
    });

    if (!openResp.ok) {
      return { success: false, error: "neural_link not available" };
    }

    const openData = await openResp.json();
    const roomId = openData.room_id;
    const newSessionId = openData.session_id || sessionId;
    if (newSessionId) sessionId = newSessionId;

    // Send the objective as a proposal
    const sendResp = await neuralLinkFetch("/message/send", {
      room_id: roomId,
      from: PARTICIPANT_ID,
      kind: "proposal",
      summary: `Objective: ${objective.slice(0, 50)}...`,
      body: JSON.stringify({ objective, mode, priority }),
      persist_hint: "durable"
    });

    return {
      success: sendResp.ok,
      room_id: roomId,
      mode,
      message: sendResp.ok
        ? "Objective sent to Overmind swarm"
        : "Failed to send objective"
    };
  }

  // Room already configured - send directly
  const resp = await neuralLinkFetch("/message/send", {
    room_id: OVERMIND_ROOM_ID,
    from: PARTICIPANT_ID,
    kind: "proposal",
    summary: `Objective: ${objective.slice(0, 50)}...`,
    body: JSON.stringify({ objective, mode, priority }),
    persist_hint: "durable"
  });

  if (!resp.ok) {
    return { success: false, error: "Failed to send via neural_link" };
  }

  return { success: true, mode, room_id: OVERMIND_ROOM_ID };
}

async function getOvermindStatus() {
  const status = {
    neural_link_url: NEURAL_LINK_URL,
    room_id: OVERMIND_ROOM_ID || null,
    participant_id: PARTICIPANT_ID,
    kernel_http_url: KERNEL_HTTP_URL,
    configured: !!(OVERMIND_ROOM_ID || KERNEL_HTTP_URL)
  };

  // Try to ping neural_link
  try {
    const resp = await fetch(`${NEURAL_LINK_URL}/health`);
    status.neural_link_available = resp.ok;
  } catch {
    status.neural_link_available = false;
  }

  return status;
}

async function cancelObjective(objectiveId) {
  if (!OVERMIND_ROOM_ID) {
    return { success: false, error: "No room configured" };
  }

  const resp = await neuralLinkFetch("/message/send", {
    room_id: OVERMIND_ROOM_ID,
    from: PARTICIPANT_ID,
    kind: "blocker",
    summary: `Cancel: ${objectiveId}`,
    body: JSON.stringify({ cancel: objectiveId }),
    persist_hint: "durable"
  });

  return { success: resp.ok };
}

async function joinRoom(roomId, displayName = "Claude Code") {
  const resp = await neuralLinkFetch("/room/join", {
    room_id: roomId,
    participant_id: PARTICIPANT_ID,
    display_name: displayName,
    role: "member"
  });

  if (!resp.ok) {
    return { success: false, error: "Failed to join room" };
  }

  return { success: true, room_id: roomId };
}

console.error("[overmind-mcp] Bridge started, listening on stdin...");
