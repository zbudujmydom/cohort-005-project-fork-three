import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  MAX_WATCH_TIME_SECONDS,
  approveRefund,
  createRefundRequest,
  declineRefund,
  getIndividualPurchase,
  getRefundEligibility,
  isWithinRefundWindow,
  lastDayOfRefundWindow,
} from "./refunds.server";

const PRICE = 10000;
const PURCHASED_AT = "2026-03-01T23:30:00.000Z";
const DURING_WINDOW = new Date("2026-03-10T12:00:00.000Z");

let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: PRICE })
    .where(eq(schema.courses.id, base.course.id))
    .run();
  admin = testDb
    .insert(schema.users)
    .values({ name: "Admin", email: "admin@example.com", role: schema.UserRole.Admin })
    .returning()
    .get();
});

function course() {
  return testDb
    .select()
    .from(schema.courses)
    .where(eq(schema.courses.id, base.course.id))
    .get()!;
}

function buyForSelf(amountPaid = PRICE, createdAt = PURCHASED_AT) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country: null,
      createdAt,
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return purchase;
}

function buyTeamLicence(seats: number) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: PRICE * seats,
      country: null,
      createdAt: PURCHASED_AT,
    })
    .returning()
    .get();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let i = 0; i < seats; i++) {
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `seat-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .run();
  }
  return purchase;
}

function watch(seconds: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "M", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "L", position: 1 })
    .returning()
    .get();
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId: lesson.id,
      eventType: "progress",
      positionSeconds: seconds,
    })
    .run();
}

function isEnrolled() {
  return !!testDb
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, base.user.id),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

describe("the refund window", () => {
  it("runs fourteen whole UTC calendar days after the day of purchase", () => {
    // Bought at 23:30 UTC on 1 March: the whole of 15 March still counts.
    expect(lastDayOfRefundWindow(PURCHASED_AT)).toBe("2026-03-15");
    expect(isWithinRefundWindow(PURCHASED_AT, new Date("2026-03-15T23:59:00Z"))).toBe(true);
    expect(isWithinRefundWindow(PURCHASED_AT, new Date("2026-03-16T00:00:00Z"))).toBe(false);
  });
});

describe("getRefundEligibility", () => {
  it("offers back exactly the amount paid, not the list price", () => {
    const purchase = buyForSelf(4000);
    expect(getRefundEligibility(purchase, course(), DURING_WINDOW)).toEqual({
      eligible: true,
      amount: 4000,
      lastDayOfWindow: "2026-03-15",
    });
  });

  it("refuses a free course", () => {
    testDb.update(schema.courses).set({ price: 0 }).run();
    const purchase = buyForSelf(0);
    expect(getRefundEligibility(purchase, course(), DURING_WINDOW)).toEqual({
      eligible: false,
      block: "free-course",
    });
  });

  it("refuses once the window has closed", () => {
    const purchase = buyForSelf();
    const result = getRefundEligibility(purchase, course(), new Date("2026-04-01T00:00:00Z"));
    expect(result).toEqual({ eligible: false, block: "window-closed" });
  });

  it("refuses at two hours of watch time", () => {
    const purchase = buyForSelf();
    watch(MAX_WATCH_TIME_SECONDS);
    expect(getRefundEligibility(purchase, course(), DURING_WINDOW)).toEqual({
      eligible: false,
      block: "watched-too-much",
    });
  });

  it("refuses a second request while one is open", () => {
    const purchase = buyForSelf();
    createRefundRequest(purchase.id, "Not what I expected");
    expect(getRefundEligibility(purchase, course(), DURING_WINDOW)).toEqual({
      eligible: false,
      block: "request-open",
    });
  });

  it("allows a new request after a decline", () => {
    const purchase = buyForSelf();
    const request = createRefundRequest(purchase.id, "Not what I expected");
    declineRefund(request.id, admin.id, DURING_WINDOW);
    expect(getRefundEligibility(purchase, course(), DURING_WINDOW).eligible).toBe(true);
  });

  it("gives a student one refund per course, ever, even after buying again", () => {
    const first = buyForSelf();
    const request = createRefundRequest(first.id, "Not what I expected");
    approveRefund(request.id, admin.id, DURING_WINDOW);

    const second = buyForSelf(PRICE, "2026-03-11T10:00:00.000Z");
    expect(getRefundEligibility(second, course(), DURING_WINDOW)).toEqual({
      eligible: false,
      block: "already-refunded",
    });
  });

  it("refuses a team licence once any seat is claimed", () => {
    const licence = buyTeamLicence(3);
    testDb
      .update(schema.coupons)
      .set({ redeemedByUserId: admin.id, redeemedAt: DURING_WINDOW.toISOString() })
      .where(eq(schema.coupons.code, `seat-${licence.id}-0`))
      .run();
    expect(getRefundEligibility(licence, course(), DURING_WINDOW)).toEqual({
      eligible: false,
      block: "seat-claimed",
    });
  });

  it("ignores the team owner's watch time for a team licence", () => {
    const licence = buyTeamLicence(2);
    watch(MAX_WATCH_TIME_SECONDS * 2);
    expect(getRefundEligibility(licence, course(), DURING_WINDOW)).toMatchObject({
      eligible: true,
      amount: PRICE * 2,
    });
  });
});

describe("getIndividualPurchase", () => {
  it("never picks a team licence the student bought for others", () => {
    const own = buyForSelf(PRICE, "2026-03-01T10:00:00.000Z");
    buyTeamLicence(2); // bought later
    expect(getIndividualPurchase(base.user.id, base.course.id)?.id).toBe(own.id);
  });
});

describe("approveRefund", () => {
  it("records the full amount paid and ends the enrollment and rating, keeping progress", () => {
    const purchase = buyForSelf(4000);
    testDb
      .insert(schema.courseRatings)
      .values({ userId: base.user.id, courseId: base.course.id, rating: 5 })
      .run();
    watch(60);
    const request = createRefundRequest(purchase.id, "Not what I expected");

    expect(approveRefund(request.id, admin.id, DURING_WINDOW)).toEqual({ ok: true });

    const refund = testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, request.id))
      .get()!;
    expect(refund).toMatchObject({
      status: schema.RefundStatus.Approved,
      amountRefunded: 4000,
      resolvedByUserId: admin.id,
    });
    expect(isEnrolled()).toBe(false);
    expect(testDb.select().from(schema.courseRatings).all()).toHaveLength(0);
    expect(testDb.select().from(schema.videoWatchEvents).all()).toHaveLength(1);
  });

  it("voids every seat of a team licence", () => {
    const licence = buyTeamLicence(2);
    const request = createRefundRequest(licence.id, "Team changed plans");

    expect(approveRefund(request.id, admin.id, DURING_WINDOW)).toEqual({ ok: true });

    const seats = testDb.select().from(schema.coupons).all();
    expect(seats.every((seat) => seat.voidedAt !== null)).toBe(true);
  });

  it("refuses when a seat was claimed after the request was made", () => {
    const licence = buyTeamLicence(2);
    const request = createRefundRequest(licence.id, "Team changed plans");
    testDb
      .update(schema.coupons)
      .set({ redeemedByUserId: admin.id, redeemedAt: DURING_WINDOW.toISOString() })
      .where(eq(schema.coupons.code, `seat-${licence.id}-0`))
      .run();

    expect(approveRefund(request.id, admin.id, DURING_WINDOW).ok).toBe(false);
    const refund = testDb.select().from(schema.refunds).get()!;
    expect(refund.status).toBe(schema.RefundStatus.Requested);
  });

  it("will not decide a request twice", () => {
    const purchase = buyForSelf();
    const request = createRefundRequest(purchase.id, "Not what I expected");
    declineRefund(request.id, admin.id, DURING_WINDOW);

    expect(approveRefund(request.id, admin.id, DURING_WINDOW).ok).toBe(false);
    expect(isEnrolled()).toBe(true);
  });
});
