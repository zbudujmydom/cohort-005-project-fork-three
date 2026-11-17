import { useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  UserRole,
  RefundStatus,
  courses,
  coupons,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { db } from "~/db";
import { desc, eq, ne, sql } from "drizzle-orm";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { approveRefund, declineRefund } from "~/lib/refunds.server";

const RECENT_DECISIONS_SHOWN = 20;

const refundDecisionSchema = z.object({
  intent: z.enum(["approve", "decline"]),
  refundId: z.coerce.number().int(),
});

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function requireAdmin(userId: number | null) {
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  const user = getUserById(userId);
  if (!user || user.role !== UserRole.Admin) {
    throw data("Only admins can decide refund requests.", { status: 403 });
  }
  return user;
}

const seatCount = sql<number>`(select count(*) from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`;

function selectRefundRows() {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      amountRefunded: refunds.amountRefunded,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      seatCount,
      buyerName: users.name,
      buyerEmail: users.email,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id));
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireAdmin(await getCurrentUserId(request));

  const open = selectRefundRows()
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(refunds.requestedAt)
    .all();

  const recent = selectRefundRows()
    .where(ne(refunds.status, RefundStatus.Requested))
    .orderBy(desc(refunds.resolvedAt))
    .limit(RECENT_DECISIONS_SHOWN)
    .all();

  return { open, recent };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = requireAdmin(await getCurrentUserId(request));

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionSchema);

  if (!parsed.success) {
    return data({ error: "Invalid input." }, { status: 400 });
  }

  const { intent, refundId } = parsed.data;
  const result =
    intent === "approve"
      ? approveRefund(refundId, admin.id, new Date())
      : declineRefund(refundId, admin.id, new Date());

  if (!result.ok) {
    return data({ error: result.error }, { status: 409 });
  }

  return { success: true, intent };
}

type RefundRow = Awaited<ReturnType<typeof loader>>["open"][number];

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function whatWasBought(row: RefundRow) {
  return row.seatCount > 0
    ? `Team licence, ${row.seatCount} seat${row.seatCount === 1 ? "" : "s"}`
    : "Own purchase";
}

function OpenRequest({ row }: { row: RefundRow }) {
  const fetcher = useFetcher<{ success?: boolean; intent?: string; error?: string }>();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) toast.error(fetcher.data.error);
    if (fetcher.data.success) {
      toast.success(
        fetcher.data.intent === "approve" ? "Refund approved." : "Request declined."
      );
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Link
              to={`/courses/${row.courseSlug}`}
              className="font-medium hover:underline"
            >
              {row.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {row.buyerName} ({row.buyerEmail}) · {whatWasBought(row)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold">{formatPrice(row.amountPaid)}</p>
            <p className="text-xs text-muted-foreground">
              Bought {formatDate(row.purchasedAt)} · asked{" "}
              {formatDate(row.requestedAt)}
            </p>
          </div>
        </div>
        <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
          {row.reason}
        </p>
        <fetcher.Form method="post" className="flex gap-2">
          <input type="hidden" name="refundId" value={row.id} />
          <Button
            type="submit"
            name="intent"
            value="approve"
            size="sm"
            disabled={isSubmitting}
          >
            Approve refund
          </Button>
          <Button
            type="submit"
            name="intent"
            value="decline"
            size="sm"
            variant="outline"
            disabled={isSubmitting}
          >
            Decline
          </Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { open, recent } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approving gives back the full amount paid and ends the student&apos;s
          enrollment, or voids every seat of a team licence.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">Open ({open.length})</h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No refund requests are waiting.
          </p>
        ) : (
          <div className="space-y-4">
            {open.map((row) => (
              <OpenRequest key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Recently decided</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing decided yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Course</th>
                  <th className="px-4 py-3 text-left font-medium">Buyer</th>
                  <th className="px-4 py-3 text-left font-medium">Decision</th>
                  <th className="px-4 py-3 text-left font-medium">Refunded</th>
                  <th className="px-4 py-3 text-left font-medium">Decided</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-4 py-3">{row.courseTitle}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.buyerEmail}
                    </td>
                    <td className="px-4 py-3">
                      {row.status === RefundStatus.Approved ? "Approved" : "Declined"}
                    </td>
                    <td className="px-4 py-3">
                      {row.amountRefunded === null
                        ? "—"
                        : formatPrice(row.amountRefunded)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(row.resolvedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 403 ? "Admins only" : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
