/**
 * One ZCC thread controls the desktop at a time. The lease is cooperative: it
 * serializes callers of this plugin's tools, not processes that run the
 * cua-driver CLI directly.
 */
export interface Lease {
  threadId: string;
  title: string;
  acquiredAt: number;
  lastUsedAt: number;
}

export type AcquireResult = { ok: true; lease: Lease; acquired: boolean } | { ok: false; holder: Lease };

export class DesktopLease {
  private lease: Lease | null = null;
  /** Calls (including pending approvals) running under the current lease; it never idles out meanwhile. */
  private active = 0;

  constructor(
    private readonly idleMs: () => number,
    private readonly now: () => number = Date.now,
    private readonly onExpire: (lease: Lease) => void = () => undefined,
  ) {}

  /** The live lease, or null once it has been idle longer than the limit. */
  current(): Lease | null {
    if (this.lease && this.active === 0 && this.now() - this.lease.lastUsedAt > this.idleMs()) {
      const expired = this.lease;
      this.lease = null;
      this.onExpire(expired);
    }
    return this.lease;
  }

  tryAcquire(threadId: string, title: string): AcquireResult {
    const holder = this.current();
    const now = this.now();
    if (holder && holder.threadId !== threadId) return { ok: false, holder };
    if (holder) {
      holder.lastUsedAt = now;
      if (title) holder.title = title;
      return { ok: true, lease: holder, acquired: false };
    }
    this.lease = { threadId, title, acquiredAt: now, lastUsedAt: now };
    this.active = 0;
    return { ok: true, lease: this.lease, acquired: true };
  }

  /**
   * Mark a call in flight for the holder. The returned function ends it and
   * counts as use; it is a no-op once the lease was released or replaced.
   */
  begin(threadId: string): () => void {
    const lease = this.current();
    if (!lease || lease.threadId !== threadId) return () => undefined;
    this.active++;
    let ended = false;
    return () => {
      if (ended || this.lease !== lease) return;
      ended = true;
      this.active--;
      lease.lastUsedAt = this.now();
    };
  }

  /** Whether this thread still holds the lease. */
  holds(threadId: string): boolean {
    return this.current()?.threadId === threadId;
  }

  /** Release the lease; with a threadId, only when that thread holds it. */
  release(threadId?: string): Lease | null {
    const holder = this.current();
    if (!holder || (threadId && holder.threadId !== threadId)) return null;
    this.lease = null;
    this.active = 0;
    return holder;
  }
}
