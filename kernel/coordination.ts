import type { NeuralLinkPort, WaitForMessage, InboxMessage } from "./types.ts";
import { MessageKind } from "./types.ts";

export interface ParticipationContext {
  port: NeuralLinkPort;
  roomId: string;
  participantId: string;
}

/**
 * Process all pending inbox messages: read, handle each, ack in batch.
 * Returns the number of processed messages.
 * Returns 0 if disconnected or inbox is empty.
 */
export async function drainInbox(
  port: NeuralLinkPort,
  roomId: string,
  participantId: string,
  handler: (msg: InboxMessage) => Promise<void>,
): Promise<number> {
  if (!port.isConnected()) return 0;

  const messages = await port.inboxRead(roomId, participantId);
  if (messages.length === 0) return 0;

  const processedIds: string[] = [];
  for (const msg of messages) {
    await handler(msg);
    processedIds.push(msg.message_id);
  }

  if (processedIds.length > 0) {
    await port.messageAck(roomId, participantId, processedIds);
  }

  return processedIds.length;
}

export interface WaitAndProcessOptions {
  timeoutMs?: number;
  from?: string[];
  onInterleaved?: (msg: WaitForMessage) => Promise<void>;
  maxIterations?: number;
}

/**
 * Wait for a specific message kind, processing interleaved messages along the way.
 * Unlike raw waitFor, this handles unexpected messages (blockers, questions)
 * that arrive while waiting for the expected kind.
 *
 * Returns the matching message, or null on timeout/disconnect/max-iterations.
 */
export async function waitAndProcessInbox(
  port: NeuralLinkPort,
  roomId: string,
  participantId: string,
  expectedKinds: string[],
  opts: WaitAndProcessOptions = {},
): Promise<WaitForMessage | null> {
  const {
    timeoutMs = 30_000,
    from,
    onInterleaved,
    maxIterations = 20,
  } = opts;

  for (let i = 0; i < maxIterations; i++) {
    const msg = await port.waitFor(roomId, participantId, timeoutMs, undefined, from);
    if (msg === null) return null; // timeout or disconnect

    if (expectedKinds.includes(msg.kind)) {
      return msg;
    }

    // Interleaved message — process and continue waiting
    if (onInterleaved) {
      await onInterleaved(msg);
    }

    // Ack the interleaved message so it doesn't reappear
    await port.messageAck(roomId, participantId, [msg.message_id]);
  }

  return null; // max iterations reached
}

/**
 * Standard participant lifecycle: join → work → handoff → leave.
 * Wraps the join/leave protocol with drain semantics.
 * Always sends a handoff and calls roomLeave, even if work() throws.
 */
export async function withParticipation<T>(
  port: NeuralLinkPort,
  roomId: string,
  participant: { id: string; displayName: string; role?: string },
  work: (ctx: ParticipationContext) => Promise<T>,
): Promise<T> {
  const joined = await port.roomJoin(
    roomId,
    participant.id,
    participant.displayName,
    participant.role,
  );

  if (!joined) {
    throw new Error(`Failed to join room ${roomId} as ${participant.id}`);
  }

  const ctx: ParticipationContext = {
    port,
    roomId,
    participantId: participant.id,
  };

  let result: T;
  let error: Error | null = null;

  try {
    result = await work(ctx);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    result = undefined as T;
  }

  // Always send handoff and leave
  const handoffSummary = error
    ? `Error: ${error.message}`
    : "Work completed successfully";

  await port.messageSend({
    roomId,
    from: participant.id,
    kind: MessageKind.Handoff,
    summary: handoffSummary,
  });

  await port.roomLeave(roomId, participant.id);

  if (error) throw error;
  return result!;
}
