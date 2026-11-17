import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courseRatings,
  coupons,
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refunds ───
// One place for the refund rules (see GLOSSARY.md: Refund request, Refund,
// Refund window, Watch time, Team licence, Seat). The course page, the team
// page, the refund route and the admin queue all go through here, so the offer
// a buyer sees and the rules the server enforces cannot drift apart.
//
// Uses positional parameters (project convention).

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCH_TIME_SECONDS = 2 * 60 * 60;

type Purchase = typeof purchases.$inferSelect;
type Course = typeof courses.$inferSelect;

export type RefundBlock =
  | "free-course"
  | "request-open"
  | "already-refunded"
  | "window-closed"
  | "watched-too-much"
  | "seat-claimed";

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayOfWindow: string }
  | { eligible: false; block: RefundBlock };

export const REFUND_BLOCK_MESSAGES: Record<RefundBlock, string> = {
  "free-course": "This course is free, so there is nothing to refund.",
  "request-open": "You already have a refund request open on this purchase.",
  "already-refunded": "You have already had a refund for this course.",
  "window-closed": `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
  "watched-too-much":
    "You have watched too much of this course to get a refund.",
  "seat-claimed":
    "A seat from this team licence has been claimed, so it can no longer be refunded.",
};

// ─── Refund window ───
// Counted in whole UTC calendar days: a purchase at 23:00 UTC still gets the
// whole of its fourteenth day.

function utcDay(when: Date): string {
  return when.toISOString().slice(0, 10);
}

export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setUTCDate(deadline.getUTCDate() + REFUND_WINDOW_DAYS);
  return utcDay(deadline);
}

export function isWithinRefundWindow(purchasedAtIso: string, now: Date) {
  const today = utcDay(now);
  return (
    today >= utcDay(new Date(purchasedAtIso)) &&
    today <= lastDayOfRefundWindow(purchasedAtIso)
  );
}

// ─── Lookups ───

const notATeamLicence = sql`not exists (select 1 from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`;

export function isTeamLicence(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

/**
 * The student's latest purchase of the course for themselves — never a team
 * licence they bought for others.
 */
export function getIndividualPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notATeamLicence
      )
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasOpenRequest(purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
}

function hasApprovedRefund(purchaseIds: number[]) {
  if (purchaseIds.length === 0) return false;
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        inArray(refunds.purchaseId, purchaseIds),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
}

function individualPurchaseIds(userId: number, courseId: number) {
  return db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notATeamLicence
      )
    )
    .all()
    .map((row) => row.id);
}

function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

/** Watch time: the furthest point reached in each lesson, summed. */
export function getWatchTimeSeconds(userId: number, courseId: number) {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// ─── Eligibility ───

/**
 * May the buyer of this purchase make a refund request for it right now?
 * Works for both a student's own purchase and a team licence.
 */
export function getRefundEligibility(
  purchase: Purchase,
  course: Pick<Course, "id" | "price">,
  now: Date
): RefundEligibility {
  if (course.price === 0) return { eligible: false, block: "free-course" };

  if (hasOpenRequest(purchase.id)) {
    return { eligible: false, block: "request-open" };
  }

  const teamLicence = isTeamLicence(purchase.id);

  // A student gets one refund per course, ever. A team licence can only be
  // refunded once, because the refund voids its seats.
  const refundedBefore = teamLicence
    ? hasApprovedRefund([purchase.id])
    : hasApprovedRefund(individualPurchaseIds(purchase.userId, course.id));
  if (refundedBefore) return { eligible: false, block: "already-refunded" };

  if (!isWithinRefundWindow(purchase.createdAt, now)) {
    return { eligible: false, block: "window-closed" };
  }

  if (teamLicence) {
    if (hasClaimedSeat(purchase.id)) {
      return { eligible: false, block: "seat-claimed" };
    }
  } else if (
    getWatchTimeSeconds(purchase.userId, course.id) >= MAX_WATCH_TIME_SECONDS
  ) {
    return { eligible: false, block: "watched-too-much" };
  }

  return {
    eligible: true,
    amount: purchase.amountPaid,
    lastDayOfWindow: lastDayOfRefundWindow(purchase.createdAt),
  };
}

// ─── Making and deciding refund requests ───

export function createRefundRequest(purchaseId: number, reason: string) {
  return db
    .insert(refunds)
    .values({ purchaseId, status: RefundStatus.Requested, reason })
    .returning()
    .get();
}

export type RefundDecisionResult = { ok: true } | { ok: false; error: string };

function getOpenRequest(refundId: number) {
  const refund = db.select().from(refunds).where(eq(refunds.id, refundId)).get();
  if (!refund || refund.status !== RefundStatus.Requested) return undefined;
  return refund;
}

/**
 * Approve a refund request: give back the full amount paid, and end what the
 * purchase paid for — the student's enrollment (and their rating, since only
 * students with access rate a course), or every seat of a team licence.
 * Lesson progress and comments are kept.
 */
export function approveRefund(
  refundId: number,
  adminId: number,
  now: Date
): RefundDecisionResult {
  return db.transaction((tx) => {
    const refund = getOpenRequest(refundId);
    if (!refund) return { ok: false, error: "This request is no longer open." };

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, refund.purchaseId))
      .get();
    if (!purchase) return { ok: false, error: "Purchase not found." };

    const resolvedAt = now.toISOString();

    if (isTeamLicence(purchase.id)) {
      // A seat may have been claimed while the request was waiting.
      if (hasClaimedSeat(purchase.id)) {
        return {
          ok: false,
          error:
            "A seat from this team licence was claimed after the request was made. Decline it instead.",
        };
      }
      tx.update(coupons)
        .set({ voidedAt: resolvedAt })
        .where(and(eq(coupons.purchaseId, purchase.id), isNull(coupons.voidedAt)))
        .run();
    } else {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, purchase.userId),
            eq(enrollments.courseId, purchase.courseId)
          )
        )
        .run();
      tx.delete(courseRatings)
        .where(
          and(
            eq(courseRatings.userId, purchase.userId),
            eq(courseRatings.courseId, purchase.courseId)
          )
        )
        .run();
    }

    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: purchase.amountPaid,
        resolvedAt,
        resolvedByUserId: adminId,
      })
      .where(eq(refunds.id, refund.id))
      .run();

    return { ok: true };
  });
}

/** Decline a refund request. Nothing is given back and nothing ends. */
export function declineRefund(
  refundId: number,
  adminId: number,
  now: Date
): RefundDecisionResult {
  const refund = getOpenRequest(refundId);
  if (!refund) return { ok: false, error: "This request is no longer open." };

  db.update(refunds)
    .set({
      status: RefundStatus.Declined,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
    })
    .where(eq(refunds.id, refund.id))
    .run();

  return { ok: true };
}
