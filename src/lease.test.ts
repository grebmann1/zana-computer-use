import { describe, expect, it } from "vitest";
import { DesktopLease } from "./lease.ts";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("DesktopLease", () => {
  it("gives the desktop to one thread and refuses the next with the holder", () => {
    const time = clock();
    const lease = new DesktopLease(() => 60_000, time.now);
    expect(lease.tryAcquire("a", "Thread A")).toMatchObject({ ok: true, acquired: true });
    expect(lease.tryAcquire("b", "Thread B")).toEqual({
      ok: false,
      holder: { threadId: "a", title: "Thread A", acquiredAt: 1_000, lastUsedAt: 1_000 },
    });
  });

  it("renews the holder on reuse instead of re-acquiring", () => {
    const time = clock();
    const lease = new DesktopLease(() => 60_000, time.now);
    lease.tryAcquire("a", "Thread A");
    time.advance(50_000);
    expect(lease.tryAcquire("a", "")).toMatchObject({ ok: true, acquired: false, lease: { lastUsedAt: 51_000, title: "Thread A" } });
    time.advance(50_000);
    expect(lease.current()?.threadId).toBe("a");
  });

  it("expires after the idle limit so another thread can take it", () => {
    const time = clock();
    const lease = new DesktopLease(() => 60_000, time.now);
    lease.tryAcquire("a", "Thread A");
    time.advance(60_001);
    expect(lease.current()).toBeNull();
    expect(lease.tryAcquire("b", "Thread B")).toMatchObject({ ok: true, acquired: true });
  });

  it("only releases for the holder when a thread id is given", () => {
    const lease = new DesktopLease(() => 60_000);
    lease.tryAcquire("a", "Thread A");
    expect(lease.release("b")).toBeNull();
    expect(lease.current()?.threadId).toBe("a");
    expect(lease.release("a")?.threadId).toBe("a");
    expect(lease.current()).toBeNull();
  });
});

describe("DesktopLease in-flight calls", () => {
  it("does not idle out while a call runs, and counts its end as use", () => {
    const time = clock();
    const expired: string[] = [];
    const lease = new DesktopLease(() => 60_000, time.now, (gone) => expired.push(gone.threadId));
    lease.tryAcquire("a", "Thread A");
    const end = lease.begin("a");
    time.advance(120_000);
    expect(lease.current()?.threadId).toBe("a");
    end();
    end();
    expect(lease.current()?.lastUsedAt).toBe(121_000);
    time.advance(60_001);
    expect(lease.current()).toBeNull();
    expect(expired).toEqual(["a"]);
  });

  it("lets the user release mid-call, and the stale call end does not touch the next lease", () => {
    const time = clock();
    const lease = new DesktopLease(() => 60_000, time.now);
    lease.tryAcquire("a", "Thread A");
    const end = lease.begin("a");
    expect(lease.release()?.threadId).toBe("a");
    expect(lease.holds("a")).toBe(false);
    lease.tryAcquire("b", "Thread B");
    time.advance(10);
    end();
    expect(lease.current()).toMatchObject({ threadId: "b", lastUsedAt: 1_000 });
    expect(lease.begin("a")).toBeTypeOf("function");
  });
});
