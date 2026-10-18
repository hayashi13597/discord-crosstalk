import { describe, expect, it, vi } from "vitest";
import { VoiceMoveService, type MoveGateway } from "../src/voice-moves.js";
import { DiscordMoveGateway } from "../src/voice-move-discord.js";
import {
  discordHarness,
  MemoryMoves,
  moveInput,
} from "./voice-move-helpers.js";
describe("web Mass Move extensions reuse the existing engine", () => {
  it("accepts snapshots of more than 25 sources through the existing Discord gateway", async () => {
    const h = discordHarness();
    const ids = Array.from({ length: 30 }, (_, i) => `source${i}`);
    for (const [i, id] of ids.entries()) {
      h.addChannel(id);
      h.addMember(`person${i}`, id);
    }
    const snapshot = await new DiscordMoveGateway(h.guild, h.rest).snapshot(
      "admin",
      ids,
      "d",
    );
    expect(snapshot.sources).toHaveLength(30);
    expect(snapshot.members).toHaveLength(30);
    expect(h.patch).not.toHaveBeenCalled();
  });
  it("finishes an in-flight move and skips the remaining members after cancellation", async () => {
    const repo = new MemoryMoves();
    let cancel = false;
    const extended = Object.assign(repo, {
      cancellationRequested: vi.fn(async () => cancel),
      cancel: vi.fn(async (id: string) => {
        const job = repo.jobs.get(id)!;
        job.status = "Cancelled";
        for (const member of job.members)
          if (member.status === "pending") {
            member.status = "skipped";
            member.reason = "user_cancelled";
          }
      }),
    });
    const input = moveInput(3);
    const move = vi.fn(async () => {
      cancel = true;
      return { status: "moved" as const, reason: null };
    });
    const gateway: MoveGateway = {
      ready: () => true,
      validate: async () => {},
      move,
    };
    await new VoiceMoveService(extended, () => {}).run(
      input,
      gateway,
      async () => {},
    );
    expect(move).toHaveBeenCalledTimes(1);
    expect(repo.jobs.get(input.id)?.members.map((m) => m.status)).toEqual([
      "moved",
      "skipped",
      "skipped",
    ]);
    expect(repo.jobs.get(input.id)?.status).toBe("Cancelled");
  });
  it("allows a disconnected web progress consumer without cancelling a running job", async () => {
    const repo = new MemoryMoves();
    const input = moveInput(2);
    const gateway: MoveGateway = {
      ready: () => true,
      validate: async () => {},
      move: async () => ({ status: "moved", reason: null }),
    };
    // Web progress acknowledgement is server-held, never tied to an HTTP response/browser.
    await new VoiceMoveService(repo, () => {}).run(
      input,
      gateway,
      async () => {},
    );
    expect(repo.jobs.get(input.id)?.status).toBe("Completed");
  });
});
