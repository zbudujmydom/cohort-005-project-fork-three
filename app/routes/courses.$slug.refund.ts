import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, purchases, users } from "~/db/schema";
import { and, eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  REFUND_BLOCK_MESSAGES,
  createRefundRequest,
  getIndividualPurchase,
  getRefundEligibility,
} from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
  // Present when a team owner asks for a team licence back; absent when a
  // student asks for their own purchase back.
  purchaseId: z.coerce.number().int().optional(),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function getOwnPurchase(purchaseId: number, userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.id, purchaseId),
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId)
      )
    )
    .get();
}

/**
 * The confirmation the buyer gets in their inbox. There is no mail transport
 * wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  buyerName: string;
  buyerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.buyerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.buyerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const buyer = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!buyer) {
    throw data("User not found", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const purchase =
    parsed.data.purchaseId === undefined
      ? getIndividualPurchase(currentUserId, course.id)
      : getOwnPurchase(parsed.data.purchaseId, currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  const eligibility = getRefundEligibility(purchase, course, new Date());

  if (!eligibility.eligible) {
    const status = eligibility.block === "request-open" ? 409 : 403;
    throw data(REFUND_BLOCK_MESSAGES[eligibility.block], { status });
  }

  createRefundRequest(purchase.id, parsed.data.reason);

  const email = buildRefundRequestEmail({
    buyerName: buyer.name,
    buyerEmail: buyer.email,
    courseTitle: course.title,
    amount: eligibility.amount,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect(parsed.data.purchaseId === undefined ? "/settings" : "/team");
}
