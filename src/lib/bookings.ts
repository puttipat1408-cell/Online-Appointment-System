import "server-only";

import { randomInt } from "node:crypto";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSettingsMap } from "@/lib/settings";
import { syncBookingReportRow } from "@/lib/google-sheets";
import { sendTelegramBookingNotification } from "@/lib/telegram";
import { BOOKING_TIME_SLOTS, BOOKING_TOPIC_GROUPS, getBookingTopic } from "@/lib/booking-options";
import type { CreateBookingInput } from "@/lib/types";
import { AppError, formatBangkokDay, getBangkokDateParts } from "@/lib/utils";

const TICKET_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SLOT_TAKEN_MESSAGE = "ขออภัย ช่วงเวลานี้ของกลุ่มงานดังกล่าวมีผู้จองแล้ว กรุณาเลือกช่วงเวลาอื่น";

export function isTimeSlotPassedToday(dateStr: string, slotId: string, now: Date = new Date()): boolean {
  const today = formatBangkokDay(now);
  if (dateStr < today) return true;
  if (dateStr > today) return false;

  const startTimePart = slotId.split("-")[0];
  const [slotHour, slotMin] = startTimePart.split(".").map((num) => parseInt(num, 10));
  if (isNaN(slotHour) || isNaN(slotMin)) return false;

  const { hour, minute } = getBangkokDateParts(now);
  const currentMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);
  const slotMinutes = slotHour * 60 + slotMin;

  return slotMinutes <= currentMinutes;
}

function validateBookingDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError("รูปแบบวันที่ไม่ถูกต้อง");
  }

  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new AppError("วันที่ไม่ถูกต้อง");
  }

  if (date < formatBangkokDay(new Date())) {
    throw new AppError("ไม่สามารถจองวันที่ผ่านมาแล้วได้");
  }
}

function generateTicketId() {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix += TICKET_ALPHABET[randomInt(TICKET_ALPHABET.length)];
  }
  return `NID-${suffix}`;
}

export async function getAvailableBookingSlots(date: string, topicId: string) {
  validateBookingDate(date);

  const topic = getBookingTopic(topicId);
  if (!topic) {
    throw new AppError("กรุณาเลือกเรื่องที่ขอรับบริการ");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("bookings")
    .select("time_slot")
    .eq("appointment_date", date)
    .eq("department", topic.department)
    .neq("status", "ยกเลิก");

  if (error) {
    throw new AppError(`ตรวจสอบคิวว่างไม่สำเร็จ: ${error.message}`, 500);
  }

  const bookedSlots = new Set((data ?? []).map((row) => row.time_slot));
  const now = new Date();

  return BOOKING_TIME_SLOTS.map((slot) => {
    const isPast = isTimeSlotPassedToday(date, slot.id, now);
    const isBooked = bookedSlots.has(slot.id);
    const available = !isBooked && !isPast;

    return {
      ...slot,
      available,
      reason: isPast ? ("past" as const) : isBooked ? ("booked" as const) : ("available" as const),
    };
  });
}

export async function createBooking(input: CreateBookingInput, appOrigin: string) {
  const topic = getBookingTopic(input.topicId);
  if (!topic) {
    throw new AppError("เรื่องที่ขอรับบริการไม่ถูกต้อง");
  }

  const topicOther = (input.topicOther ?? "").trim();
  if (topic.allowsOther && !topicOther) {
    throw new AppError("กรุณาระบุรายละเอียดเรื่องที่ขอรับบริการ");
  }

  const timeSlot = BOOKING_TIME_SLOTS.find((slot) => slot.id === input.timeSlot);
  if (!timeSlot) {
    throw new AppError("ช่วงเวลาที่เลือกไม่ถูกต้อง");
  }

  validateBookingDate(input.date);

  const agency = input.agency.trim();
  if (!agency) {
    throw new AppError("กรุณาระบุชื่อส่วนราชการผู้รับบริการ");
  }

  const topicText = topic.allowsOther ? `${topic.label} (${topicOther})` : topic.label;
  const availableSlots = await getAvailableBookingSlots(input.date, input.topicId);
  const targetSlot = availableSlots.find((slot) => slot.id === input.timeSlot);
  if (!targetSlot?.available) {
    if (targetSlot?.reason === "past" || isTimeSlotPassedToday(input.date, input.timeSlot)) {
      throw new AppError("ช่วงเวลานี้ผ่านไปแล้วในวันนี้ ไม่สามารถจองได้", 400);
    }
    throw new AppError(SLOT_TAKEN_MESSAGE, 409);
  }

  const supabase = getSupabaseAdminClient();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ticketId = generateTicketId();
    const { error } = await supabase.from("bookings").insert({
      ticket_id: ticketId,
      amount: 1,
      appointment_date: input.date,
      time_slot: timeSlot.id,
      agency,
      topic: topicText,
      department: topic.department,
      receiver_name: "",
      status: "รอตอบรับ",
    });

    if (!error) {
      await syncBookingReportRow({
        receiverName: "",
        amount: 1,
        date: input.date,
        timeSlot: timeSlot.id,
        agency,
        topic: topicText,
        department: topic.department,
        ticketId,
        status: "รอตอบรับ",
      });

      try {
        const telegramSettings = await getSettingsMap();
        const notification = await sendTelegramBookingNotification(telegramSettings, {
          ticketId,
          agency,
          topic: topicText,
          department: topic.department,
          date: input.date,
          timeSlot: timeSlot.label,
        }, appOrigin);
        if (!notification.configured) {
          console.warn("Telegram booking notification skipped: bot token or chat ID is not configured.");
        }
      } catch (notificationError) {
        console.error("ส่ง Telegram แจ้งเตือนการจองไม่สำเร็จ", notificationError);
      }

      return {
        success: true,
        ticketId,
        message: "จองคิวสำเร็จเรียบร้อยแล้ว",
        booking: {
          ticketId,
          agency,
          topic: topicText,
          department: topic.department,
          date: input.date,
          timeSlot: timeSlot.id,
          status: "รอตอบรับ",
          receiverName: "รอเจ้าหน้าที่ตอบรับ",
          note: "",
        },
      };
    }

    if (error.code === "23505") {
      const { data: occupiedSlot, error: lookupError } = await supabase
        .from("bookings")
        .select("ticket_id")
        .eq("appointment_date", input.date)
        .eq("department", topic.department)
        .eq("time_slot", timeSlot.id)
        .neq("status", "ยกเลิก")
        .maybeSingle();

      if (lookupError) {
        throw new AppError(`ตรวจสอบสถานะคิวไม่สำเร็จ: ${lookupError.message}`, 500);
      }
      if (occupiedSlot) {
        throw new AppError(SLOT_TAKEN_MESSAGE, 409);
      }
      continue;
    }

    throw new AppError(`บันทึกการจองไม่สำเร็จ: ${error.message}`, 500);
  }

  throw new AppError("สร้างหมายเลขคิวไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", 500);
}

const CANCELLATION_REPLY_WINDOW_MS = 30 * 60 * 1000;

async function syncBookingReportByTicket(ticketId: string) {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("bookings")
      .select("receiver_name, amount, appointment_date, time_slot, agency, topic, department, ticket_id, status")
      .eq("ticket_id", ticketId)
      .maybeSingle();

    if (error || !data) {
      console.error(`Google Sheets sync skipped for ${ticketId}: could not load updated booking.`);
      return;
    }

    await syncBookingReportRow({
      receiverName: data.receiver_name ?? "",
      amount: data.amount,
      date: data.appointment_date,
      timeSlot: data.time_slot,
      agency: data.agency,
      topic: data.topic,
      department: data.department,
      ticketId: data.ticket_id,
      status: data.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Supabase error";
    console.error(`Google Sheets sync skipped for ${ticketId}: ${message}`);
  }
}

async function getTelegramBooking(settings: Record<string, string>, ticketId: string, callbackChatId: number | string) {
  const normalizedTicketId = ticketId.trim().toUpperCase();
  if (!/^NID-[A-Z0-9]{6}$/.test(normalizedTicketId)) {
    throw new AppError("รูปแบบหมายเลขคิวไม่ถูกต้อง", 400);
  }

  const supabase = getSupabaseAdminClient();
  const { data: booking, error: lookupError } = await supabase
    .from("bookings")
    .select("ticket_id, department, status, pending_cancel_user_id, pending_cancel_chat_id, pending_cancel_message_id, pending_cancel_at")
    .eq("ticket_id", normalizedTicketId)
    .maybeSingle();

  if (lookupError) throw new AppError(`ค้นหาคิวไม่สำเร็จ: ${lookupError.message}`, 500);
  if (!booking) throw new AppError("ไม่พบหมายเลขคิวนี้", 404);

  const groupIndex = BOOKING_TOPIC_GROUPS.findIndex((group) => group.department === booking.department);
  const groupChatKeys = [
    "TELEGRAM_CHAT_ID_BOOKING_ADMIN",
    "TELEGRAM_CHAT_ID_BOOKING_ACADEMIC",
    "TELEGRAM_CHAT_ID_BOOKING_GF",
    "TELEGRAM_CHAT_ID_BOOKING_POLICY",
  ];
  const allowedChatId = (groupIndex >= 0 ? settings[groupChatKeys[groupIndex]]?.trim() : "")
    || settings.TELEGRAM_CHAT_ID?.trim()
    || process.env.TELEGRAM_CHAT_ID?.trim();
  if (!allowedChatId || String(callbackChatId) !== allowedChatId) {
    throw new AppError("กลุ่ม Telegram นี้ไม่มีสิทธิ์เปลี่ยนสถานะคิว", 403);
  }

  return { supabase, booking, ticketId: normalizedTicketId };
}

export async function updateBookingStatusFromTelegram(
  settings: Record<string, string>,
  ticketId: string,
  callbackChatId: number | string,
  actorName: string,
) {
  const { supabase, booking, ticketId: normalizedTicketId } = await getTelegramBooking(settings, ticketId, callbackChatId);
  if (booking.status !== "รอตอบรับ") return { ticketId: normalizedTicketId, status: booking.status, updated: false };

  const { data: updatedBooking, error: updateError } = await supabase
    .from("bookings")
    .update({
      status: "ยืนยันแล้ว",
      receiver_name: actorName,
      pending_cancel_user_id: null,
      pending_cancel_chat_id: null,
      pending_cancel_message_id: null,
      pending_cancel_at: null,
    })
    .eq("ticket_id", normalizedTicketId)
    .eq("status", "รอตอบรับ")
    .select("status")
    .maybeSingle();

  if (updateError) throw new AppError(`ปรับสถานะคิวไม่สำเร็จ: ${updateError.message}`, 500);
  if (updatedBooking) await syncBookingReportByTicket(normalizedTicketId);
  return {
    ticketId: normalizedTicketId,
    status: updatedBooking?.status ?? booking.status,
    updated: Boolean(updatedBooking),
  };
}

export async function beginBookingCancellationFromTelegram(
  settings: Record<string, string>,
  ticketId: string,
  callbackChatId: number | string,
  callbackUserId: number | string,
  callbackMessageId: number,
) {
  const { supabase, booking, ticketId: normalizedTicketId } = await getTelegramBooking(settings, ticketId, callbackChatId);
  if (booking.status !== "รอตอบรับ") return { ticketId: normalizedTicketId, status: booking.status, updated: false };

  const { data: updatedBooking, error: updateError } = await supabase
    .from("bookings")
    .update({
      pending_cancel_user_id: callbackUserId,
      pending_cancel_chat_id: callbackChatId,
      pending_cancel_message_id: callbackMessageId,
      pending_cancel_at: new Date().toISOString(),
    })
    .eq("ticket_id", normalizedTicketId)
    .eq("status", "รอตอบรับ")
    .select("status")
    .maybeSingle();

  if (updateError) throw new AppError(`เริ่มยกเลิกคิวไม่สำเร็จ: ${updateError.message}`, 500);
  return {
    ticketId: normalizedTicketId,
    status: updatedBooking?.status ?? booking.status,
    updated: Boolean(updatedBooking),
  };
}

export async function prepareBookingCancellationReasonFromTelegram(
  settings: Record<string, string>,
  ticketId: string,
  callbackChatId: number | string,
  callbackUserId: number | string,
) {
  const { supabase, booking, ticketId: normalizedTicketId } = await getTelegramBooking(settings, ticketId, callbackChatId);
  const originalMessageId = booking.pending_cancel_message_id == null ? null : Number(booking.pending_cancel_message_id);
  const belongsToPendingCancellation =
    String(booking.pending_cancel_user_id ?? "") === String(callbackUserId) &&
    String(booking.pending_cancel_chat_id ?? "") === String(callbackChatId);

  if (booking.status !== "รอตอบรับ" || !belongsToPendingCancellation) {
    return { ticketId: normalizedTicketId, status: booking.status, authorized: false, expired: false, originalMessageId };
  }

  const pendingSince = booking.pending_cancel_at ? Date.parse(booking.pending_cancel_at) : 0;
  if (!pendingSince || Date.now() - pendingSince > CANCELLATION_REPLY_WINDOW_MS) {
    const { error: clearError } = await supabase
      .from("bookings")
      .update({
        pending_cancel_user_id: null,
        pending_cancel_chat_id: null,
        pending_cancel_message_id: null,
        pending_cancel_at: null,
      })
      .eq("ticket_id", normalizedTicketId)
      .eq("status", "รอตอบรับ")
      .eq("pending_cancel_user_id", callbackUserId);

    if (clearError) throw new AppError(`ล้างคำขอยกเลิกที่หมดอายุไม่สำเร็จ: ${clearError.message}`, 500);
    return { ticketId: normalizedTicketId, status: booking.status, authorized: true, expired: true, originalMessageId };
  }

  return { ticketId: normalizedTicketId, status: booking.status, authorized: true, expired: false, originalMessageId };
}

export async function completeBookingCancellationFromTelegram(
  settings: Record<string, string>,
  ticketId: string,
  callbackChatId: number | string,
  callbackUserId: number | string,
  actorName: string,
  reason: string,
) {
  const { supabase, booking, ticketId: normalizedTicketId } = await getTelegramBooking(settings, ticketId, callbackChatId);
  const originalMessageId = booking.pending_cancel_message_id == null ? null : Number(booking.pending_cancel_message_id);
  const belongsToPendingCancellation =
    String(booking.pending_cancel_user_id ?? "") === String(callbackUserId) &&
    String(booking.pending_cancel_chat_id ?? "") === String(callbackChatId);

  if (booking.status !== "รอตอบรับ" || !belongsToPendingCancellation) {
    return { ticketId: normalizedTicketId, status: booking.status, updated: false, authorized: false, expired: false, originalMessageId };
  }

  const pendingSince = booking.pending_cancel_at ? Date.parse(booking.pending_cancel_at) : 0;
  if (!pendingSince || Date.now() - pendingSince > CANCELLATION_REPLY_WINDOW_MS) {
    const { error: clearError } = await supabase
      .from("bookings")
      .update({
        pending_cancel_user_id: null,
        pending_cancel_chat_id: null,
        pending_cancel_message_id: null,
        pending_cancel_at: null,
      })
      .eq("ticket_id", normalizedTicketId)
      .eq("status", "รอตอบรับ")
      .eq("pending_cancel_user_id", callbackUserId);

    if (clearError) throw new AppError(`ล้างคำขอยกเลิกที่หมดอายุไม่สำเร็จ: ${clearError.message}`, 500);
    return { ticketId: normalizedTicketId, status: booking.status, updated: false, authorized: true, expired: true, originalMessageId };
  }

  const cleanReason = reason.trim();
  if (cleanReason.length > 1000) {
    throw new AppError("เหตุผลการยกเลิกยาวเกินไป กรุณาระบุไม่เกิน 1,000 ตัวอักษร", 400);
  }

  const { data: updatedBooking, error: updateError } = await supabase
    .from("bookings")
    .update({
      status: "ยกเลิก",
      receiver_name: actorName,
      note: cleanReason,
      pending_cancel_user_id: null,
      pending_cancel_chat_id: null,
      pending_cancel_message_id: null,
      pending_cancel_at: null,
    })
    .eq("ticket_id", normalizedTicketId)
    .eq("status", "รอตอบรับ")
    .eq("pending_cancel_user_id", callbackUserId)
    .eq("pending_cancel_chat_id", callbackChatId)
    .select("status")
    .maybeSingle();

  if (updateError) throw new AppError(`ยกเลิกคิวไม่สำเร็จ: ${updateError.message}`, 500);
  if (updatedBooking) await syncBookingReportByTicket(normalizedTicketId);
  return {
    ticketId: normalizedTicketId,
    status: updatedBooking?.status ?? booking.status,
    updated: Boolean(updatedBooking),
    authorized: true,
    expired: false,
    originalMessageId,
  };
}

type BookingRatingStats = {
  total: number;
  average: number;
  counts: Record<"1" | "2" | "3" | "4" | "5", number>;
};

async function getBookingRatingStats(topic: string): Promise<BookingRatingStats> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("get_booking_rating_stats", { p_topic: topic });
  if (error) throw new AppError(`โหลดสถิติความพึงพอใจไม่สำเร็จ: ${error.message}`, 500);

  const stats = (data ?? {}) as Partial<BookingRatingStats>;
  const counts = stats.counts ?? ({} as BookingRatingStats["counts"]);
  return {
    total: Number(stats.total) || 0,
    average: Number(stats.average) || 0,
    counts: {
      "1": Number(counts["1"]) || 0,
      "2": Number(counts["2"]) || 0,
      "3": Number(counts["3"]) || 0,
      "4": Number(counts["4"]) || 0,
      "5": Number(counts["5"]) || 0,
    },
  };
}

export async function submitBookingRating(ticketId: string, rating: number) {
  const normalizedTicketId = ticketId.trim().toUpperCase();
  if (!/^NID-[A-Z0-9]{6}$/.test(normalizedTicketId)) {
    throw new AppError("รูปแบบหมายเลขคิวไม่ถูกต้อง");
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError("กรุณาเลือกคะแนน 1–5 ดาว");
  }

  const supabase = getSupabaseAdminClient();
  const { data: booking, error: lookupError } = await supabase
    .from("bookings")
    .select("ticket_id, topic, status")
    .eq("ticket_id", normalizedTicketId)
    .maybeSingle();

  if (lookupError) throw new AppError(`ค้นหาคิวเพื่อบันทึกคะแนนไม่สำเร็จ: ${lookupError.message}`, 500);
  if (!booking) throw new AppError("ไม่พบหมายเลขคิวนี้", 404);
  if (booking.status === "ยกเลิก") throw new AppError("คิวที่ยกเลิกแล้วไม่สามารถให้คะแนนได้", 409);

  const { data: updatedBooking, error: updateError } = await supabase
    .from("bookings")
    .update({ satisfaction_rating: rating })
    .eq("ticket_id", normalizedTicketId)
    .select("satisfaction_rating")
    .single();

  if (updateError) throw new AppError(`บันทึกคะแนนไม่สำเร็จ: ${updateError.message}`, 500);

  return {
    satisfactionRating: updatedBooking.satisfaction_rating as number,
    ratingStats: await getBookingRatingStats(booking.topic),
  };
}

export async function checkBookingStatus(ticketId: string) {
  const normalizedTicketId = ticketId.trim().toUpperCase();
  if (!/^NID-[A-Z0-9]{6}$/.test(normalizedTicketId)) {
    throw new AppError("รูปแบบหมายเลขคิวไม่ถูกต้อง");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("bookings")
    .select("ticket_id, agency, topic, department, appointment_date, time_slot, status, receiver_name, note, satisfaction_rating")
    .eq("ticket_id", normalizedTicketId)
    .maybeSingle();

  if (error) {
    throw new AppError(`ค้นหาสถานะคิวไม่สำเร็จ: ${error.message}`, 500);
  }
  if (!data) return null;

  const ratingStats = await getBookingRatingStats(data.topic);

  return {
    ticketId: data.ticket_id,
    agency: data.agency,
    topic: data.topic,
    department: data.department,
    date: data.appointment_date,
    timeSlot: data.time_slot,
    status: data.status || "รอตอบรับ",
    receiverName: data.receiver_name || "รอเจ้าหน้าที่ตอบรับ",
    note: data.note || "",
    satisfactionRating: data.satisfaction_rating as number | null,
    ratingStats,
  };
}
