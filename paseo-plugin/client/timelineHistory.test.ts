import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { readTimelineHistory } from "./timelineHistory";

test("reads all canonical pages and caches the complete snapshot per agent", async () => {
  const calls: any[] = [];
  const timeline = {
    refetch: async (input: any): Promise<any> => {
      calls.push(input);
      return input.direction === "tail"
        ? { entries: [{ item: { type: "user_message", messageId: "recent" } }],
          hasOlder: true, startCursor: { epoch: "e", seq: 10 } }
        : { entries: [{ item: { type: "user_message", messageId: "old" } }],
          hasOlder: false, startCursor: { epoch: "e", seq: 1 } };
    },
  };
  const client = new QueryClient();
  try {
    const options = { queryKey: ["paseo-agent-timeline-history", "agent-a"],
      queryFn: () => readTimelineHistory(timeline), staleTime: 5000 };
    const history = await client.fetchQuery(options);
    expect(history.complete).toBe(true);
    expect(history.entries.map(({ item }) => item?.messageId)).toEqual(["old", "recent"]);
    await client.fetchQuery(options);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ direction: "before", cursor: { epoch: "e", seq: 10 }, limit: 1000, projection: "canonical" });
    await client.fetchQuery({ ...options, queryKey: ["paseo-agent-timeline-history", "agent-b"] });
    expect(calls).toHaveLength(4);
  } finally { client.clear(); }
});

test("empty history is complete, stalled or missing cursors are not", async () => {
  const read = (page: any) => readTimelineHistory({ refetch: async (): Promise<any> => page });
  expect(await read({ entries: [], hasOlder: false })).toEqual({ entries: [], complete: true });
  expect((await read({ entries: [], hasOlder: true })).complete).toBe(false);
  expect((await read({ entries: [{}], hasOlder: true, startCursor: { epoch: "e", seq: 10 } })).complete).toBe(false);
  expect((await read({ entries: [], hasOlder: true, startCursor: { epoch: "e", seq: 10 } })).complete).toBe(false);
  let calls = 0;
  expect((await readTimelineHistory({ refetch: async (): Promise<any> => ++calls === 1
    ? { entries: [{}], hasOlder: true, startCursor: { epoch: "e", seq: 10 } }
    : { entries: [], hasOlder: false } })).complete).toBe(true);
  await expect(read({ error: "offline" })).rejects.toThrow("offline");
});
