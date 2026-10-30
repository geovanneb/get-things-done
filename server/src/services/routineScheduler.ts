import { RoutineService } from './routineService';
import { scheduleKaizenIntake } from './kaizenIntake';

/**
 * Checks routines while the server runs: shortly after start (which is also how routines catch up
 * after a reboot) and then once a minute. The engine works out what is due, so a missed tick only
 * delays a task; it never loses one.
 */
const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 3_000;

export class RoutineScheduler {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly service = new RoutineService();

  start(): void {
    this.stop();
    this.timers.push(setTimeout(() => void this.tick('startup'), STARTUP_DELAY_MS));
    const interval = setInterval(() => void this.tick('timer'), TICK_MS);
    interval.unref();
    this.timers.push(interval);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private async tick(trigger: 'startup' | 'timer'): Promise<void> {
    // The file watcher can miss an event (macOS, network drives): a Kaizen note then still opens within a minute.
    void scheduleKaizenIntake();
    try {
      for (const run of await this.service.runDue(trigger)) {
        console.log(`[routines] ${run.routine_id} ${run.status}: ${run.message}`);
      }
    } catch (err) {
      // No workspace configured yet, or a transient file error: the next tick tries again.
      if (!(err as Error).message?.includes('not configured')) console.error(`[routines] ${(err as Error).message}`);
    }
  }
}

export const routineScheduler = new RoutineScheduler();
