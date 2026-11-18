import "server-only";

import {
  buildTelegramInlineKeyboard,
  getInitialTelegramActionRows,
  getNextTelegramActionRows,
  getTelegramActionConfig,
} from "@/lib/settings";
import type { SettingsMap, TelegramAction, TelegramRequestNotificationPayload } from "@/lib/types";
import { getBookingDepartmentIndex } from "@/lib/booking-options";
import { escapeTelegramHtml } from "@/lib/utils";

type TelegramApiResult = {
  ok?: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

async function callTelegramApi(token: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  let result: TelegramApiResult = {};

  try {
    result = (await response.json()) as TelegramApiResult;
  } catch {
    result = { ok: false, description: "Telegram response was not valid JSON" };
  }

  return result;
}

function getTelegramConfig(settings: SettingsMap) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = settings.TELEGRAM_CHAT_ID?.trim();
  return {
    token,
    chatId,
    isConfigured: Boolean(token && chatId),
  };
}

export async function sendTelegramRequestNotification(settings: SettingsMap, payload: TelegramRequestNotificationPayload) {
  const { token, chatId, isConfigured } = getTelegramConfig(settings);
  if (!isConfigured || !token || !chatId) {
    return { statusText: "Not Configured", message: "(ยังไม่ได้ตั้งค่า Telegram)" };
  }

  const keyboard = buildTelegramInlineKeyboard(getInitialTelegramActionRows(), payload.reqId, settings);

  const message = `🔔 <b>แจ้งเตือนคำขอหนังสือบำเหน็จค้ำประกัน</b>\n\n` +
    `🏢 <b>ส่วนราชการ:</b> ${escapeTelegramHtml(payload.agency)}\n` +
    `👥 <b>จำนวนผู้ขอ:</b> ${escapeTelegramHtml(payload.requestSummary)}\n` +
    `📅 <b>วันที่:</b> ${escapeTelegramHtml(payload.dateText)} ⏰ ${escapeTelegramHtml(payload.timeText)}\n` +
    `📌 <b>สถานะ:</b> ${escapeTelegramHtml(payload.status)}`;

  const result = await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });

  if (result.ok) {
    return { statusText: "Success", message: "และส่งแจ้งเตือน Telegram แล้ว" };
  }

  return { statusText: "Error", message: "(ส่ง Telegram ไม่สำเร็จ)" };
}

export async function sendTelegramBookingNotification(settings: SettingsMap, payload: {
  ticketId: string;
  agency: string;
  topic: string;
  department: string;
  consultationDetails: string;
  date: string;
  timeSlot: string;
}, appOrigin: string) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatSettingKeys = [
    "TELEGRAM_CHAT_ID_BOOKING_ADMIN",
    "TELEGRAM_CHAT_ID_BOOKING_ACADEMIC",
    "TELEGRAM_CHAT_ID_BOOKING_GF",
    "TELEGRAM_CHAT_ID_BOOKING_POLICY",
  ];
  const groupIndex = getBookingDepartmentIndex(payload.department);
  const groupChatId = groupIndex >= 0 ? settings[chatSettingKeys[groupIndex]]?.trim() : "";
  const chatId = groupChatId || settings.TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { configured: false, sent: false };

  const trackingUrl = new URL("/", appOrigin);
  trackingUrl.searchParams.set("ticketId", payload.ticketId);
  const appointmentDate = new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${payload.date}T00:00:00+07:00`));
  const message = `📅 <b>มีการจองนัดหมายใหม่</b>\n\n` +
    `🎫 <b>หมายเลขคิว:</b> ${escapeTelegramHtml(payload.ticketId)}\n` +
    `🏢 <b>ส่วนราชการ:</b> ${escapeTelegramHtml(payload.agency)}\n` +
    `📌 <b>เรื่องที่ขอรับบริการ:</b> ${escapeTelegramHtml(payload.topic)}\n` +
    `📝 <b>ปัญหา/ข้อหารือ:</b> ${escapeTelegramHtml(payload.consultationDetails)}\n` +
    `👥 <b>กลุ่มงาน:</b> ${escapeTelegramHtml(payload.department)}\n` +
    `🗓️ <b>วันที่เข้าพบ:</b> ${escapeTelegramHtml(appointmentDate)}\n` +
    `⏰ <b>ช่วงเวลา:</b> ${escapeTelegramHtml(payload.timeSlot)}\n` +
    `📌 <b>สถานะ:</b> รอตอบรับ`;
  const result = await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: settings.TELEGRAM_BOOKING_CONFIRM_TEXT?.trim() || "✅ ยืนยันนัดหมาย", callback_data: `BOOKING_CONFIRM|${payload.ticketId}` },
          { text: settings.TELEGRAM_BOOKING_CANCEL_TEXT?.trim() || "❌ ยกเลิกคิว", callback_data: `BOOKING_CANCEL|${payload.ticketId}` },
        ],
        ...(trackingUrl.protocol === "https:"
          ? [[{ text: "🔎 ติดตามสถานะคิว", url: trackingUrl.toString() }]]
          : []),
      ],
    },
  });

  if (!result.ok) {
    throw new Error(result.description || "Telegram ส่งข้อความแจ้งเตือนไม่สำเร็จ");
  }

  return { configured: true, sent: true };
}

export async function sendTelegramBookingCallbackFeedback(settings: SettingsMap, payload: {
  callbackId: string;
  messageId: number;
  chatId: number | string;
  ticketId: string;
  status: string;
  actionBy: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await Promise.all([
    callTelegramApi(token, "answerCallbackQuery", {
      callback_query_id: payload.callbackId,
      text: `อัปเดตสถานะคิวเป็น: ${payload.status}`,
    }),
    callTelegramApi(token, "editMessageReplyMarkup", {
      chat_id: payload.chatId,
      message_id: payload.messageId,
      reply_markup: { inline_keyboard: [] },
    }),
    callTelegramApi(token, "sendMessage", {
      chat_id: payload.chatId,
      text: `🎫 คิว ${payload.ticketId} อัปเดตสถานะเป็น <b>${escapeTelegramHtml(payload.status)}</b>\n👤 ผู้ดำเนินการ: ${escapeTelegramHtml(payload.actionBy)}`,
      parse_mode: "HTML",
      reply_to_message_id: payload.messageId,
    }),
  ]);
}

export async function answerTelegramCallbackQuery(settings: SettingsMap, callbackId: string, text: string) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await callTelegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  });
}

export async function sendTelegramBookingCancellationPrompt(settings: SettingsMap, payload: {
  callbackId: string;
  chatId: number | string;
  bookingMessageId: number;
  ticketId: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await callTelegramApi(token, "answerCallbackQuery", {
    callback_query_id: payload.callbackId,
    text: "พิมพ์เหตุผลหรือเลือกยกเลิกโดยไม่ระบุเหตุผลได้",
  });

  const prompt = await callTelegramApi(token, "sendMessage", {
    chat_id: payload.chatId,
    text: `✍️ เหตุผลการยกเลิกคิว ${payload.ticketId} (พิมพ์เหตุผลด้านล่างได้เลย)`,
    reply_to_message_id: payload.bookingMessageId,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "เหตุผล (ไม่บังคับ)",
    },
  });
  if (!prompt.ok) throw new Error(prompt.description || "ส่งข้อความขอเหตุผลการยกเลิกไม่สำเร็จ");

  const skip = await callTelegramApi(token, "editMessageReplyMarkup", {
    chat_id: payload.chatId,
    message_id: payload.bookingMessageId,
    reply_markup: {
      inline_keyboard: [[{
        text: settings.TELEGRAM_BOOKING_CANCEL_SKIP_TEXT?.trim() || "ยกเลิกโดยไม่ระบุเหตุผล",
        callback_data: `BOOKING_CANCEL_SKIP|${payload.ticketId}`,
      }]],
    },
  });
  if (!skip.ok) throw new Error(skip.description || "แสดงตัวเลือกยกเลิกโดยไม่ระบุเหตุผลไม่สำเร็จ");
}

export async function sendTelegramBookingCancellationOptions(settings: SettingsMap, payload: {
  callbackId: string;
  chatId: number | string;
  bookingMessageId: number;
  ticketId: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await callTelegramApi(token, "answerCallbackQuery", {
    callback_query_id: payload.callbackId,
    text: "เลือกได้ว่าจะระบุเหตุผลหรือข้าม",
  });

  const result = await callTelegramApi(token, "editMessageReplyMarkup", {
    chat_id: payload.chatId,
    message_id: payload.bookingMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: settings.TELEGRAM_BOOKING_CANCEL_REASON_TEXT?.trim() || "✍️ ระบุเหตุผล", callback_data: `BOOKING_CANCEL_REASON|${payload.ticketId}` },
        { text: settings.TELEGRAM_BOOKING_CANCEL_SKIP_TEXT?.trim() || "ยกเลิกโดยไม่ระบุเหตุผล", callback_data: `BOOKING_CANCEL_SKIP|${payload.ticketId}` },
      ]],
    },
  });
  if (!result.ok) throw new Error(result.description || "แสดงตัวเลือกการยกเลิกไม่สำเร็จ");
}

export async function restoreTelegramBookingActions(settings: SettingsMap, payload: {
  chatId: number | string;
  messageId: number;
  ticketId: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await callTelegramApi(token, "editMessageReplyMarkup", {
    chat_id: payload.chatId,
    message_id: payload.messageId,
    reply_markup: {
      inline_keyboard: [
        [
          { text: settings.TELEGRAM_BOOKING_CONFIRM_TEXT?.trim() || "✅ ยืนยันนัดหมาย", callback_data: `BOOKING_CONFIRM|${payload.ticketId}` },
          { text: settings.TELEGRAM_BOOKING_CANCEL_TEXT?.trim() || "❌ ยกเลิกคิว", callback_data: `BOOKING_CANCEL|${payload.ticketId}` },
        ],
      ],
    },
  });
}

export async function sendTelegramBookingCancellationFeedback(settings: SettingsMap, payload: {
  callbackId?: string;
  chatId: number | string;
  sourceMessageId?: number;
  originalMessageId?: number | null;
  replyToMessageId?: number;
  ticketId: string;
  status: string;
  actionBy: string;
  reason: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  const messagesToClear = [...new Set([payload.sourceMessageId, payload.originalMessageId].filter((id): id is number => typeof id === "number"))];
  const reasonLine = payload.reason ? `\n📝 หมายเหตุเพิ่มเติม: ${escapeTelegramHtml(payload.reason)}` : "\n📝 หมายเหตุเพิ่มเติม: -";

  await Promise.all([
    ...(payload.callbackId ? [callTelegramApi(token, "answerCallbackQuery", {
      callback_query_id: payload.callbackId,
      text: `อัปเดตสถานะคิวเป็น: ${payload.status}`,
    })] : []),
    ...messagesToClear.map((messageId) => callTelegramApi(token, "editMessageReplyMarkup", {
      chat_id: payload.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    })),
    callTelegramApi(token, "sendMessage", {
      chat_id: payload.chatId,
      text: `🎫 คิว ${payload.ticketId} อัปเดตสถานะเป็น <b>${escapeTelegramHtml(payload.status)}</b>\n👤 ผู้ดำเนินการ: ${escapeTelegramHtml(payload.actionBy)}${reasonLine}`,
      parse_mode: "HTML",
      ...(payload.replyToMessageId ? { reply_to_message_id: payload.replyToMessageId } : {}),
    }),
  ]);
}

export async function sendTelegramBookingCancellationNotice(settings: SettingsMap, payload: {
  chatId: number | string;
  replyToMessageId?: number;
  text: string;
}) {
  const token = settings.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await callTelegramApi(token, "sendMessage", {
    chat_id: payload.chatId,
    text: payload.text,
    ...(payload.replyToMessageId ? { reply_to_message_id: payload.replyToMessageId } : {}),
  });
}

export async function sendTelegramStatusNotification(settings: SettingsMap, payload: {
  requestSummary: string;
  status: string;
  note: string;
}) {
  const { token, chatId, isConfigured } = getTelegramConfig(settings);
  if (!isConfigured || !token || !chatId) {
    return;
  }

  const message = `🔄 <b>อัปเดตสถานะคำขอ</b>\n\n` +
    `👥 <b>จำนวนผู้ขอ:</b> ${escapeTelegramHtml(payload.requestSummary)}\n` +
    `📌 <b>สถานะใหม่:</b> <b>${escapeTelegramHtml(payload.status)}</b>\n` +
    `📝 <b>หมายเหตุ:</b> ${escapeTelegramHtml(payload.note || "-")}`;

  await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
  });
}

export async function sendTelegramCallbackFeedback(settings: SettingsMap, payload: {
  action: TelegramAction;
  requestSummary?: string;
  agency?: string;
  reqId: string;
  callbackId: string;
  messageId?: number;
  chatId?: number | string;
  actionBy: string;
}) {
  const { token, isConfigured } = getTelegramConfig(settings);
  if (!isConfigured || !token || !payload.messageId || !payload.chatId) return;

  const actionConfig = getTelegramActionConfig(payload.action, settings);
  const newKeyboard = buildTelegramInlineKeyboard(getNextTelegramActionRows(payload.action), payload.reqId, settings);
  const agencyLine = payload.agency
    ? `🏢 <b>ส่วนราชการ:</b> ${escapeTelegramHtml(payload.agency)}\n`
    : "";
  const requestSummaryLine = payload.requestSummary
    ? `👥 <b>จำนวนผู้ขอ:</b> ${escapeTelegramHtml(payload.requestSummary)}\n`
    : "";
  const quickAlertMsg = `${actionConfig.icon} <b>อัปเดตสถานะแล้ว</b>\n\n` +
    requestSummaryLine +
    agencyLine +
    `📌 <b>สถานะปัจจุบัน:</b> <b>${escapeTelegramHtml(actionConfig.statusText)}</b>\n` +
    `👨‍💻 <b>ผู้ดำเนินการ:</b> ${escapeTelegramHtml(payload.actionBy)}`;

  await Promise.all([
    callTelegramApi(token, "answerCallbackQuery", {
      callback_query_id: payload.callbackId,
      text: `กำลังอัปเดตเป็น: ${actionConfig.statusText}...`,
    }),
    callTelegramApi(token, "editMessageReplyMarkup", {
      chat_id: payload.chatId,
      message_id: payload.messageId,
      reply_markup: { inline_keyboard: [] },
    }),
    callTelegramApi(token, "sendMessage", {
      chat_id: payload.chatId,
      text: quickAlertMsg,
      parse_mode: "HTML",
      reply_to_message_id: payload.messageId,
      ...(newKeyboard.length > 0 ? { reply_markup: { inline_keyboard: newKeyboard } } : {}),
    }),
  ]);
}
