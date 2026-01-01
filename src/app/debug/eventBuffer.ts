/**
 * Debug Event Buffer
 * Ring buffer for storing debug events from the pipeline
 *
 * Provides observability into the grammar check pipeline stages
 */

import { DebugEvent } from "../../core/contracts";

/**
 * Ring buffer for debug events
 * Stores the last N events (default: 50)
 */
export class EventBuffer {
  private buffer: DebugEvent[] = [];
  private readonly maxSize: number;
  private writeIndex: number = 0;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add an event to the buffer
   */
  add(event: DebugEvent): void {
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(event);
    } else {
      this.buffer[this.writeIndex] = event;
      this.writeIndex = (this.writeIndex + 1) % this.maxSize;
    }
  }

  /**
   * Get all events in chronological order
   */
  getAll(): DebugEvent[] {
    if (this.buffer.length < this.maxSize) {
      return [...this.buffer];
    }

    // Reorder from writeIndex to get chronological order
    const ordered: DebugEvent[] = [];
    for (let i = 0; i < this.maxSize; i++) {
      const index = (this.writeIndex + i) % this.maxSize;
      ordered.push(this.buffer[index]!);
    }
    return ordered;
  }

  /**
   * Get events filtered by stage
   */
  getByStage(stage: DebugEvent["stage"]): DebugEvent[] {
    return this.getAll().filter((event) => event.stage === stage);
  }

  /**
   * Get the last N events
   */
  getLast(n: number): DebugEvent[] {
    const all = this.getAll();
    return all.slice(-n);
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.buffer = [];
    this.writeIndex = 0;
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    totalEvents: number;
    eventsByStage: Record<string, number>;
    averageTimeSpent: number;
    lastEventTime: number | null;
  } {
    const all = this.getAll();
    const eventsByStage: Record<string, number> = {};
    let totalTime = 0;
    let timeCount = 0;
    let lastTime: number | null = null;

    for (const event of all) {
      eventsByStage[event.stage] = (eventsByStage[event.stage] || 0) + 1;
      if (event.data.timeSpent !== undefined) {
        totalTime += event.data.timeSpent as number;
        timeCount++;
      }
      if (event.timestamp > (lastTime || 0)) {
        lastTime = event.timestamp;
      }
    }

    return {
      totalEvents: all.length,
      eventsByStage,
      averageTimeSpent: timeCount > 0 ? totalTime / timeCount : 0,
      lastEventTime: lastTime,
    };
  }
}

/**
 * Global event buffer instance
 */
export const globalEventBuffer = new EventBuffer(50);
