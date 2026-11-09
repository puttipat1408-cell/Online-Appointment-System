const REPORT_SPREADSHEET_ID = "1kpweyi5BoNQXBAUkC-YYR4Bpui7MB5jIkkVlm-izBE0";
const DAILY_SHEET_NAME = "รายการจองรายวัน";

const REPORT_HEADERS = [
  "ชื่อผู้รับเรื่อง",
  "จำนวน",
  "วันที่รับ",
  "ช่วงเวลา",
  "ชื่อผู้รับบริการ(หน่วยงาน)",
  "เรื่องที่ขอรับบริการ",
  "กลุ่มงานที่รับผิดชอบ",
  "รหัส",
  "สถานะ",
];

const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
];

const STANDARD_DEPARTMENTS = [
  "ฝ่ายบริหารทั่วไป",
  "กลุ่มงานวิชาการ",
  "กลุ่มงานระบบการคลัง GF",
  "กลุ่มนโยบายเศรษฐกิจการคลัง",
];

function doPost(e) {
  let lock;

  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const expectedSecret = scriptProperties.getProperty("GOOGLE_SHEETS_WEBHOOK_SECRET");
    if (!expectedSecret) return jsonResponse({ ok: false, error: "Webhook secret is not configured" });

    const payload = JSON.parse(e && e.postData ? e.postData.contents : "{}");
    if (payload.secret !== expectedSecret) return jsonResponse({ ok: false, error: "Unauthorized" });

    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    const spreadsheet = SpreadsheetApp.openById(REPORT_SPREADSHEET_ID);

    // 1. Rebuild all summaries action
    if (payload.action === "rebuild_all_summaries") {
      const dailySheet = getOrCreateDailySheet(spreadsheet);
      rebuildAllMonthlySummaries(spreadsheet, dailySheet);
      return jsonResponse({ ok: true, message: "Rebuilt all monthly summaries" });
    }

    // 2. Upsert booking action
    if (payload.action !== "upsert_booking") {
      return jsonResponse({ ok: false, error: "Unsupported action" });
    }

    const booking = payload.booking || {};
    if (!/^NID-[A-Z0-9]{6}$/.test(String(booking.ticketId || ""))) {
      return jsonResponse({ ok: false, error: "Invalid ticket ID" });
    }

    const dailySheet = getOrCreateDailySheet(spreadsheet);
    let lastRow = dailySheet.getLastRow();
    if (lastRow === 0) {
      dailySheet.getRange(1, 1, 1, REPORT_HEADERS.length).setValues([REPORT_HEADERS]);
      formatDailyHeaders(dailySheet);
      lastRow = 1;
    }

    const values = [[
      String(booking.receiverName || ""),
      Number(booking.amount) || 1,
      String(booking.date || ""),
      String(booking.timeSlot || ""),
      String(booking.agency || ""),
      String(booking.topic || ""),
      String(booking.department || ""),
      String(booking.ticketId),
      String(booking.status || ""),
    ]];

    let existingRow = 0;
    if (lastRow > 1) {
      const ticketIds = dailySheet.getRange(2, 8, lastRow - 1, 1).getDisplayValues();
      const index = ticketIds.findIndex((row) => row[0].trim() === booking.ticketId);
      if (index >= 0) existingRow = index + 2;
    }

    let operation = "inserted";
    if (existingRow) {
      dailySheet.getRange(existingRow, 1, 1, REPORT_HEADERS.length).setValues(values);
      operation = "updated";
    } else {
      dailySheet.appendRow(values[0]);
    }

    // อัปเดตแท็บสรุปรายเดือนของเดือนนั้นทันที
    if (booking.date) {
      updateMonthlySummary(spreadsheet, dailySheet, String(booking.date));
    }

    return jsonResponse({ ok: true, operation, ticketId: booking.ticketId });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return jsonResponse({ ok: false, error: message });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

// -------------------------------------------------------------
// แปลงวันที่ (รองรับทั้ง Date object และ String)
// -------------------------------------------------------------
function parseDateCell(val) {
  if (!val) return null;

  // 1. ถ้าเป็น Date object จาก Google Sheets
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, "0");
    const day = String(val.getDate()).padStart(2, "0");
    return { year, month, day, ym: `${year}-${month}`, dateStr: `${year}-${month}-${day}` };
  }

  // 2. ถ้าเป็น String รูปแบบ YYYY-MM-DD หรือ YYYY/MM/DD
  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = String(parseInt(isoMatch[2], 10)).padStart(2, "0");
    const day = String(parseInt(isoMatch[3], 10)).padStart(2, "0");
    return { year, month, day, ym: `${year}-${month}`, dateStr: `${year}-${month}-${day}` };
  }

  // 3. ถ้าเป็น String รูปแบบ DD/MM/YYYY
  const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmyMatch) {
    let year = parseInt(dmyMatch[3], 10);
    if (year > 2400) year -= 543;
    const month = String(parseInt(dmyMatch[2], 10)).padStart(2, "0");
    const day = String(parseInt(dmyMatch[1], 10)).padStart(2, "0");
    return { year, month, day, ym: `${year}-${month}`, dateStr: `${year}-${month}-${day}` };
  }

  return null;
}

function getMonthlySheetName(parsedDate) {
  if (parsedDate && parsedDate.year && parsedDate.month) {
    const monthNum = parseInt(parsedDate.month, 10);
    const thaiYear = parsedDate.year > 2400 ? parsedDate.year : parsedDate.year + 543;
    const monthName = THAI_MONTHS[monthNum - 1] || parsedDate.month;
    return `สรุป ${monthName} ${thaiYear}`;
  }
  return "สรุปยอดรายเดือน";
}

function formatThaiDisplayDate(dateStr) {
  const parsed = parseDateCell(dateStr);
  if (parsed) {
    const day = parseInt(parsed.day, 10);
    const monthNum = parseInt(parsed.month, 10);
    const thaiYear = parsed.year > 2400 ? parsed.year : parsed.year + 543;
    const monthName = THAI_MONTHS[monthNum - 1] || parsed.month;
    return `${day} ${monthName} ${thaiYear}`;
  }
  return String(dateStr);
}

// -------------------------------------------------------------
// จัดการแท็บรายการจองรายวัน (เปลี่ยนชื่อ ชีต1 -> รายการจองรายวัน)
// -------------------------------------------------------------
function getOrCreateDailySheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(DAILY_SHEET_NAME);
  if (sheet) return sheet;

  // ตรวจหา "ชีต1" เพื่อเปลี่ยนชื่อ
  sheet = spreadsheet.getSheetByName("ชีต1");
  if (sheet) {
    sheet.setName(DAILY_SHEET_NAME);
    formatDailyHeaders(sheet);
    return sheet;
  }

  // หรือชีตแรกของไฟล์
  const sheets = spreadsheet.getSheets();
  if (sheets.length > 0 && !sheets[0].getName().startsWith("สรุป")) {
    sheets[0].setName(DAILY_SHEET_NAME);
    formatDailyHeaders(sheets[0]);
    return sheets[0];
  }

  const newSheet = spreadsheet.insertSheet(DAILY_SHEET_NAME, 0);
  newSheet.getRange(1, 1, 1, REPORT_HEADERS.length).setValues([REPORT_HEADERS]);
  formatDailyHeaders(newSheet);
  return newSheet;
}

function formatDailyHeaders(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, REPORT_HEADERS.length);
  headerRange
    .setFontWeight("bold")
    .setBackground("#fef08a") // สีเหลือง
    .setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
}

// -------------------------------------------------------------
// อัปเดตแท็บสรุปรายเดือนทั้งหมด
// -------------------------------------------------------------
function rebuildAllMonthlySummaries(spreadsheet, dailySheet) {
  const lastRow = dailySheet.getLastRow();
  if (lastRow <= 1) return;

  const datesValues = dailySheet.getRange(2, 3, lastRow - 1, 1).getValues();
  const datesDisplay = dailySheet.getRange(2, 3, lastRow - 1, 1).getDisplayValues();
  const yearMonths = new Set();

  for (let i = 0; i < datesValues.length; i++) {
    const parsed = parseDateCell(datesValues[i][0]) || parseDateCell(datesDisplay[i][0]);
    if (parsed) yearMonths.add(parsed.ym);
  }

  yearMonths.forEach((ym) => {
    updateMonthlySummary(spreadsheet, dailySheet, `${ym}-01`);
  });
}

// -------------------------------------------------------------
// อัปเดตตารางสรุปรายเดือน: มีทั้งแยกกลุ่มงาน และแยกรายวันในเดือน
// -------------------------------------------------------------
function updateMonthlySummary(spreadsheet, dailySheet, dateStr) {
  const targetParsed = parseDateCell(dateStr);
  if (!targetParsed) return;
  const targetYm = targetParsed.ym;

  const summarySheetName = getMonthlySheetName(targetParsed);
  let summarySheet = spreadsheet.getSheetByName(summarySheetName);
  if (!summarySheet) {
    summarySheet = spreadsheet.insertSheet(summarySheetName);
  }

  const lastRow = dailySheet.getLastRow();
  if (lastRow <= 1) return;

  const rows = dailySheet.getRange(2, 1, lastRow - 1, REPORT_HEADERS.length).getValues();
  const displayRows = dailySheet.getRange(2, 1, lastRow - 1, REPORT_HEADERS.length).getDisplayValues();

  // 1. คำนวณสรุปแยกตามกลุ่มงาน
  const deptStats = {};
  STANDARD_DEPARTMENTS.forEach((dept) => {
    deptStats[dept] = { pending: 0, confirmed: 0, cancelled: 0, total: 0 };
  });

  // 2. คำนวณสรุปแยกรายวัน
  const dailyStats = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const disp = displayRows[i];

    // ตรวจวันที่
    const parsedDate = parseDateCell(r[2]) || parseDateCell(disp[2]);
    if (!parsedDate || parsedDate.ym !== targetYm) continue;

    const dateKey = parsedDate.dateStr;
    const dept = String(disp[6] || r[6] || "").trim() || "ไม่ระบุ";
    const status = String(disp[8] || r[8] || "").trim();

    if (!deptStats[dept]) {
      deptStats[dept] = { pending: 0, confirmed: 0, cancelled: 0, total: 0 };
    }

    if (!dailyStats[dateKey]) {
      dailyStats[dateKey] = { pending: 0, confirmed: 0, cancelled: 0, total: 0, dateObj: parsedDate };
    }

    // จัดหมวดหมู่สถานะ
    if (status.includes("รอ") || status === "รอตอบรับ") {
      deptStats[dept].pending++;
      dailyStats[dateKey].pending++;
    } else if (status.includes("ยืนยัน") || status === "ยืนยันแล้ว") {
      deptStats[dept].confirmed++;
      dailyStats[dateKey].confirmed++;
    } else if (status.includes("ยกเลิก")) {
      deptStats[dept].cancelled++;
      dailyStats[dateKey].cancelled++;
    } else {
      deptStats[dept].pending++;
      dailyStats[dateKey].pending++;
    }

    deptStats[dept].total++;
    dailyStats[dateKey].total++;
  }

  // ล้างเนื้อหาเดิมเพื่อเขียนใหม่
  summarySheet.clear();

  // --- ส่วนหัวเรื่อง ---
  summarySheet.getRange("A1").setValue(`📊 รายงานสรุปการจองคิวนัดหมายออนไลน์ ประจำเดือน ${summarySheetName.replace("สรุป ", "")}`);
  summarySheet.getRange("A1").setFontSize(14).setFontWeight("bold");

  // --- ตารางที่ 1: สรุปแยกตามกลุ่มงาน ---
  summarySheet.getRange("A3").setValue("🏢 สรุปยอดการจองแยกตามกลุ่มงานที่รับผิดชอบ").setFontWeight("bold").setFontSize(11);

  const deptHeaders = ["กลุ่มงานที่รับผิดชอบ", "รอตอบรับ", "ยืนยันแล้ว", "ยกเลิก", "รวมทั้งสิ้น (คิว)"];
  summarySheet.getRange(4, 1, 1, deptHeaders.length).setValues([deptHeaders])
    .setBackground("#0284c7")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");

  const deptDataRows = [];
  let totalPending = 0, totalConfirmed = 0, totalCancelled = 0, grandTotal = 0;

  // เอา standard departments มาก่อน ตามด้วยอื่นๆ
  const allDepts = Object.keys(deptStats).sort((a, b) => {
    const idxA = STANDARD_DEPARTMENTS.indexOf(a);
    const idxB = STANDARD_DEPARTMENTS.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  allDepts.forEach((dept) => {
    const s = deptStats[dept];
    deptDataRows.push([dept, s.pending, s.confirmed, s.cancelled, s.total]);
    totalPending += s.pending;
    totalConfirmed += s.confirmed;
    totalCancelled += s.cancelled;
    grandTotal += s.total;
  });

  let currentRow = 5;
  if (deptDataRows.length > 0) {
    summarySheet.getRange(currentRow, 1, deptDataRows.length, deptHeaders.length).setValues(deptDataRows);
    summarySheet.getRange(currentRow, 2, deptDataRows.length, 4).setHorizontalAlignment("center");
    currentRow += deptDataRows.length;
  }

  // แถวรวมทั้งหมดของตารางกลุ่มงาน
  summarySheet.getRange(currentRow, 1, 1, deptHeaders.length).setValues([
    ["รวมทั้งหมด", totalPending, totalConfirmed, totalCancelled, grandTotal]
  ]).setBackground("#e0f2fe").setFontWeight("bold");
  summarySheet.getRange(currentRow, 2, 1, 4).setHorizontalAlignment("center");

  // --- ตารางที่ 2: สรุปยอดการจองรายวันในเดือน ---
  currentRow += 3;
  summarySheet.getRange(currentRow, 1).setValue("📅 สรุปยอดการจองแยกตามรายวันในเดือน").setFontWeight("bold").setFontSize(11);
  currentRow += 1;

  const dailyHeaders = ["วันที่รับ", "รอตอบรับ", "ยืนยันแล้ว", "ยกเลิก", "รวม (คิว)"];
  summarySheet.getRange(currentRow, 1, 1, dailyHeaders.length).setValues([dailyHeaders])
    .setBackground("#10b981")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");
  currentRow += 1;

  const sortedDates = Object.keys(dailyStats).sort();
  const dailyDataRows = [];
  sortedDates.forEach((d) => {
    const s = dailyStats[d];
    dailyDataRows.push([formatThaiDisplayDate(d), s.pending, s.confirmed, s.cancelled, s.total]);
  });

  if (dailyDataRows.length > 0) {
    summarySheet.getRange(currentRow, 1, dailyDataRows.length, dailyHeaders.length).setValues(dailyDataRows);
    summarySheet.getRange(currentRow, 2, dailyDataRows.length, 4).setHorizontalAlignment("center");
    currentRow += dailyDataRows.length;
  }

  // แถวรวมของตารางรายวัน
  summarySheet.getRange(currentRow, 1, 1, dailyHeaders.length).setValues([
    ["รวมตลอดทั้งเดือน", totalPending, totalConfirmed, totalCancelled, grandTotal]
  ]).setBackground("#d1fae5").setFontWeight("bold");
  summarySheet.getRange(currentRow, 2, 1, 4).setHorizontalAlignment("center");

  // ปรับความกว้างคอลัมน์อัตโนมัติ
  for (let c = 1; c <= 5; c++) {
    summarySheet.autoResizeColumn(c);
  }
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

// -------------------------------------------------------------
// ทำงานอัตโนมัติเมื่อเปิดชีต หรือมีคนแก้ไขข้อมูลในชีต
// -------------------------------------------------------------

// เมนูลัดบนแถบเมนู Google Sheet ให้กดอัปเดตเองได้ทันทีโดยไม่ต้องเปิดโปรแกรม
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("⚡ ระบบนัดหมาย")
      .addItem("🔄 อัปเดตสรุปรายเดือนทั้งหมดทันที", "menuRebuildSummaries")
      .addToUi();
  } catch (e) {
    // กรณีรันผ่าน Webhook จะไม่มี UI ข้ามไปได้
  }
}

function menuRebuildSummaries() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const dailySheet = getOrCreateDailySheet(spreadsheet);
  rebuildAllMonthlySummaries(spreadsheet, dailySheet);
  spreadsheet.toast("อัปเดตแท็บสรุปรายเดือนทุกเดือนเรียบร้อยแล้ว!", "สำเร็จ", 5);
}

// อัปเดตสรุปรายเดือนอัตโนมัติทันทีที่มีการแก้ไขในแท็บ "รายการจองรายวัน"
function onEdit(e) {
  try {
    const range = e && e.range;
    if (!range) return;
    const sheet = range.getSheet();
    if (sheet.getName() !== DAILY_SHEET_NAME) return;

    const row = range.getRow();
    if (row <= 1) return;

    const spreadsheet = sheet.getParent();
    const dateVal = sheet.getRange(row, 3).getValue();
    if (dateVal) {
      updateMonthlySummary(spreadsheet, sheet, dateVal);
    }
  } catch (err) {
    console.error("onEdit error:", err);
  }
}
