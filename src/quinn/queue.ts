/**
 * BACKGROUND QUEUE (pg-boss, stored in the same PostgreSQL database).
 *
 * The website puts a job on the queue and returns immediately; the worker picks it up and
 * calls OpenAI, so a slow AI answer never freezes anyone's screen. For now the worker runs
 * inside the app container; it can move to its own Dokploy service later without code changes.
 */
import { PgBoss } from "pg-boss";
import { and, inArray, lt } from "drizzle-orm";
import type { DB } from "@/db/client";
import { agentTasks } from "@/db/schema";
import { defaultDrafter, type Drafter } from "./ai";
import { runDraftTask } from "./tasks";

export const DRAFT_QUEUE = "quinn-draft-quotation";

const g = globalThis as unknown as { __quinnBoss?: Promise<PgBoss> };

export function getBoss(): Promise<PgBoss> {
  if (!g.__quinnBoss) {
    g.__quinnBoss = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
      boss.on("error", (e) => console.error("[quinn queue]", e));
      await boss.start();
      if (!(await boss.getQueue(DRAFT_QUEUE))) {
        // No automatic retries: the OpenAI client already retries brief glitches, and a person
        // is waiting on the result, so a clear failure + "Try again" beats silent re-runs.
        await boss.createQueue(DRAFT_QUEUE, { retryLimit: 0, expireInSeconds: 600 });
      }
      return boss;
    })().catch((e) => { g.__quinnBoss = undefined; throw e; });
  }
  return g.__quinnBoss;
}

export async function enqueueDraftTask(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(DRAFT_QUEUE, { taskId });
}

/** Tasks stuck because the app restarted mid-way are marked failed so nobody waits forever. */
export async function failStaleTasks(db: DB, olderThanMinutes = 10): Promise<void> {
  await db.update(agentTasks)
    .set({ status: "failed", error: "Quinn was interrupted (the app restarted). Please try again.", finishedAt: new Date() })
    .where(and(inArray(agentTasks.status, ["queued", "running"]), lt(agentTasks.createdAt, new Date(Date.now() - olderThanMinutes * 60_000))));
}

export async function startQuinnWorker(db: DB, makeDrafter: () => Drafter = defaultDrafter): Promise<string> {
  await failStaleTasks(db);
  const boss = await getBoss();
  return boss.work<{ taskId: string }>(DRAFT_QUEUE, { batchSize: 1, pollingIntervalSeconds: 1, localConcurrency: 2 }, async ([job]) => {
    await runDraftTask(db, job.data.taskId, makeDrafter());
  });
}

export async function stopQueue(): Promise<void> {
  if (g.__quinnBoss) {
    const boss = await g.__quinnBoss;
    g.__quinnBoss = undefined;
    await boss.stop({ graceful: true, timeout: 10_000 });
  }
}
