import { submitBookingRating } from "@/lib/bookings";
import { createServerErrorResponse } from "@/lib/requests";
import { bookingRatingSchema } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = bookingRatingSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ message: parsed.error.issues[0]?.message ?? "ข้อมูลคะแนนไม่ถูกต้อง" }, { status: 400 });
    }

    const result = await submitBookingRating(parsed.data.ticketId, parsed.data.rating, parsed.data.feedback);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
