"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as KeyboardEventType } from "react";

import { BOOKING_TOPIC_GROUPS, getBookingTopic } from "@/lib/booking-options";

type BookingForm = {
  agency: string;
  topicId: string;
  topicOther: string;
  date: string;
  timeSlot: string;
};

type BookingSlot = {
  id: string;
  label: string;
  available: boolean;
  reason?: "past" | "booked" | "available";
};

type BookingStatus = {
  ticketId: string;
  agency: string;
  topic: string;
  department: string;
  date: string;
  timeSlot: string;
  status: string;
  receiverName: string;
  note: string;
  satisfactionRating?: number | null;
  ratingStats?: BookingRatingStats;
};

type BookingRatingStats = {
  total: number;
  average: number;
  counts: Record<"1" | "2" | "3" | "4" | "5", number>;
};

type CreateBookingResponse = {
  success: boolean;
  ticketId: string;
  message: string;
  booking: BookingStatus;
};

const THEME_STORAGE_KEY = "appointment-system-color-theme";
const COLOR_THEMES = [
  { id: "rose", label: "ชมพูเดิม", swatch: "#ea8aa1" },
  { id: "mint", label: "มิ้นต์", swatch: "#6fa989" },
  { id: "lavender", label: "ลาเวนเดอร์", swatch: "#9a7fba" },
  { id: "sky", label: "ฟ้า", swatch: "#6b9db8" },
  { id: "peach", label: "พีช", swatch: "#dd9273" },
  { id: "gold", label: "ทองอ่อน", swatch: "#bd9855" },
] as const;
type ColorTheme = (typeof COLOR_THEMES)[number]["id"];

async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.message || "ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง");
  }
  return payload as T;
}

function getBangkokToday() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

function formatThaiDate(date: string, includeWeekday = true) {
  if (!date) return "—";
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "long",
    year: "numeric",
  };
  if (includeWeekday) options.weekday = "long";
  return new Intl.DateTimeFormat("th-TH", options).format(new Date(`${date}T00:00:00`));
}

function getFriendlySystemError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/public\.bookings|schema cache|supabase environment|service_role key/i.test(message)) {
    return "ระบบนัดหมายยังไม่พร้อมใช้งาน กรุณาให้ผู้ดูแลตั้งค่า Supabase และรันไฟล์ supabase/booking-system.sql";
  }
  return message || fallback;
}

function QueueQrCode({ ticketId }: { ticketId: string }) {
  const [imageSource, setImageSource] = useState("");
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const trackingUrl = new URL("/", window.location.origin);
    trackingUrl.searchParams.set("ticketId", ticketId);
    void QRCode.toDataURL(trackingUrl.toString(), {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 240,
      color: { dark: "#18364a", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (!cancelled) setImageSource(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setHasError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  return (
    <div className="ticket-qr">
      <div className="ticket-qr-image">
        {imageSource ? (
          <Image src={imageSource} alt={`QR Code หมายเลขคิว ${ticketId}`} width={240} height={240} unoptimized />
        ) : (
          <span className="qr-placeholder">{hasError ? "สร้าง QR Code ไม่สำเร็จ" : "กำลังสร้าง QR Code…"}</span>
        )}
      </div>
      <p>สแกนเพื่อเปิดติดตามสถานะคิว</p>
      {imageSource ? (
        <a className="qr-download" href={imageSource} download={`queue-${ticketId}.png`}>
          ดาวน์โหลด QR Code
        </a>
      ) : null}
    </div>
  );
}

export function RequestConsole({ agencies }: { agencies: readonly string[] }) {
  const [activeTab, setActiveTab] = useState<"book" | "track">("book");
  const [colorTheme, setColorTheme] = useState<ColorTheme>("rose");
  const [isThemeReady, setIsThemeReady] = useState(false);
  const [agencyDropdownOpen, setAgencyDropdownOpen] = useState(false);
  const [activeAgencyIndex, setActiveAgencyIndex] = useState(0);
  const [form, setForm] = useState<BookingForm>(() => ({
    agency: "",
    topicId: "",
    topicOther: "",
    date: getBangkokToday(),
    timeSlot: "",
  }));
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slotRefreshKey, setSlotRefreshKey] = useState(0);
  const [bookingError, setBookingError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<BookingStatus | null>(null);
  const [ticketInput, setTicketInput] = useState("");
  const [statusResult, setStatusResult] = useState<BookingStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [ratingValue, setRatingValue] = useState(0);
  const [isSavingRating, setIsSavingRating] = useState(false);
  const [ratingMessage, setRatingMessage] = useState("");
  const [ratingError, setRatingError] = useState("");
  const autoLookupTicketRef = useRef("");

  const lookupBookingStatus = useCallback(async (rawTicketId: string) => {
    const ticketId = rawTicketId.trim().toUpperCase();
    setTicketInput(ticketId);
    setActiveTab("track");
    if (!ticketId) {
      setStatusError("กรุณากรอกหมายเลขคิว");
      setStatusResult(null);
      return;
    }

    setIsCheckingStatus(true);
    setStatusError("");
    setStatusResult(null);
    setRatingValue(0);
    setRatingMessage("");
    setRatingError("");
    try {
      const response = await fetch(`/api/bookings?ticketId=${encodeURIComponent(ticketId)}`, { cache: "no-store" });
      const result = await readApiResponse<{ found: boolean } & BookingStatus>(response);
      if (result.found) {
        setStatusResult(result);
        setRatingValue(result.satisfactionRating ?? 0);
      }
      else setStatusError("ไม่พบหมายเลขคิวนี้ในระบบ กรุณาตรวจสอบรหัสอีกครั้ง");
    } catch (error) {
      setStatusError(getFriendlySystemError(error, "ค้นหาสถานะคิวไม่สำเร็จ"));
    } finally {
      setIsCheckingStatus(false);
    }
  }, []);

  async function saveBookingRating() {
    if (!statusResult || ratingValue < 1 || ratingValue > 5) {
      setRatingError("กรุณาเลือกคะแนน 1–5 ดาว");
      return;
    }

    setIsSavingRating(true);
    setRatingError("");
    setRatingMessage("");
    try {
      const response = await fetch("/api/bookings/rating", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: statusResult.ticketId, rating: ratingValue }),
      });
      const result = await readApiResponse<{ satisfactionRating: number; ratingStats: BookingRatingStats }>(response);
      setStatusResult((current) => current
        ? { ...current, satisfactionRating: result.satisfactionRating, ratingStats: result.ratingStats }
        : current);
      setRatingMessage("บันทึกคะแนนเรียบร้อย ขอบคุณสำหรับความคิดเห็น");
    } catch (error) {
      setRatingError(getFriendlySystemError(error, "บันทึกคะแนนไม่สำเร็จ กรุณาลองอีกครั้ง"));
    } finally {
      setIsSavingRating(false);
    }
  }

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const validTheme = COLOR_THEMES.find((theme) => theme.id === savedTheme);
    if (validTheme) setColorTheme(validTheme.id);
    setIsThemeReady(true);
  }, []);

  useEffect(() => {
    if (!isThemeReady) return;
    document.documentElement.dataset.colorTheme = colorTheme;
    window.localStorage.setItem(THEME_STORAGE_KEY, colorTheme);
  }, [colorTheme, isThemeReady]);

  useEffect(() => {
    const ticketId = new URLSearchParams(window.location.search).get("ticketId")?.trim().toUpperCase();
    if (!ticketId || autoLookupTicketRef.current === ticketId) return;
    autoLookupTicketRef.current = ticketId;
    setActiveTab("track");
    void lookupBookingStatus(ticketId);
  }, [lookupBookingStatus]);

  const selectedTopic = getBookingTopic(form.topicId);
  const agencyQuery = form.agency.trim().toLocaleLowerCase("th-TH");
  const agencySuggestions = agencies
    .filter((agency) => !agencyQuery || agency.toLocaleLowerCase("th-TH").includes(agencyQuery))
    .sort((first, second) => {
      if (!agencyQuery) return 0;
      const firstStarts = first.toLocaleLowerCase("th-TH").startsWith(agencyQuery);
      const secondStarts = second.toLocaleLowerCase("th-TH").startsWith(agencyQuery);
      return Number(secondStarts) - Number(firstStarts);
    });

  useEffect(() => {
    if (!form.date || !selectedTopic) {
      setSlots([]);
      setSlotsError("");
      setIsLoadingSlots(false);
      return;
    }

    let cancelled = false;
    setIsLoadingSlots(true);
    setSlotsError("");

    const params = new URLSearchParams({ date: form.date, topicId: selectedTopic.id });
    void fetch(`/api/bookings/slots?${params.toString()}`, { cache: "no-store" })
      .then((response) => readApiResponse<BookingSlot[]>(response))
      .then((nextSlots) => {
        if (!cancelled) setSlots(nextSlots);
      })
      .catch((error) => {
        if (cancelled) return;
        setSlots([]);
        setSlotsError(getFriendlySystemError(error, "ตรวจสอบคิวว่างไม่สำเร็จ"));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSlots(false);
      });

    return () => {
      cancelled = true;
    };
  }, [form.date, selectedTopic?.id, slotRefreshKey]);

  function updateForm<K extends keyof BookingForm>(key: K, value: BookingForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setBookingError("");
  }

  function handleTopicChange(topicId: string) {
    setForm((current) => ({ ...current, topicId, topicOther: "", timeSlot: "" }));
    setSlots([]);
    setSlotsError("");
    setIsLoadingSlots(Boolean(topicId && form.date));
    setBookingError("");
  }

  function handleDateChange(date: string) {
    setForm((current) => ({ ...current, date, timeSlot: "" }));
    setSlots([]);
    setSlotsError("");
    setIsLoadingSlots(Boolean(date && selectedTopic));
    setBookingError("");
  }

  function selectAgency(agency: string) {
    updateForm("agency", agency);
    setAgencyDropdownOpen(false);
    setActiveAgencyIndex(0);
  }

  function handleAgencyKeyDown(event: KeyboardEventType<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAgencyDropdownOpen(true);
      setActiveAgencyIndex((current) => Math.min(current + 1, agencySuggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setAgencyDropdownOpen(true);
      setActiveAgencyIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Escape") {
      setAgencyDropdownOpen(false);
    } else if (event.key === "Enter" && agencyDropdownOpen && agencySuggestions.length > 0) {
      event.preventDefault();
      selectAgency(agencySuggestions[Math.min(activeAgencyIndex, agencySuggestions.length - 1)]);
    }
  }

  async function handleBookingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBookingError("");

    if (!form.agency.trim()) {
      setBookingError("กรุณาระบุชื่อส่วนราชการผู้รับบริการ");
      return;
    }
    if (!selectedTopic) {
      setBookingError("กรุณาเลือกเรื่องที่ขอรับบริการ");
      return;
    }
    if (selectedTopic.allowsOther && !form.topicOther.trim()) {
      setBookingError("กรุณาระบุรายละเอียดเรื่องที่ขอรับบริการ");
      return;
    }
    if (!form.timeSlot || !slots.some((slot) => slot.id === form.timeSlot && slot.available)) {
      setBookingError("กรุณาเลือกช่วงเวลาที่ยังว่าง");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency: form.agency,
          topicId: form.topicId,
          topicOther: form.topicOther,
          date: form.date,
          timeSlot: form.timeSlot,
        }),
      });
      const result = await readApiResponse<CreateBookingResponse>(response);
      setConfirmation(result.booking);
      setForm({
        agency: "",
        topicId: "",
        topicOther: "",
        date: getBangkokToday(),
        timeSlot: "",
      });
      setSlots([]);
    } catch (error) {
      setBookingError(getFriendlySystemError(error, "จองคิวไม่สำเร็จ กรุณาลองอีกครั้ง"));
      setSlotRefreshKey((current) => current + 1);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleStatusLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void lookupBookingStatus(ticketInput);
  }

  function closeConfirmation() {
    setConfirmation(null);
  }

  const dateToday = getBangkokToday();

  return (
    <main className="page-shell">
      <div className="page-frame">
        <header className="hero-bar">
          <div className="hero-brand">
            <div className="hero-brand-badge">
              <Image src="/logo.svg" alt="" width={52} height={52} className="hero-brand-logo" unoptimized />
            </div>
            <div className="hero-copy">
              <p className="eyebrow">สำนักงานคลังจังหวัดสกลนคร</p>
              <h1>ระบบนัดหมายบริการส่วนราชการ</h1>
              <p className="hero-description">สะดวก รวดเร็ว โปร่งใส</p>
            </div>
          </div>
          <div className="hero-status"><span className="hero-status-dot" /> จองคิวออนไลน์</div>
        </header>

        <div className="control-row">
          <div className="tab-set" role="tablist" aria-label="เมนูระบบนัดหมาย">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "book"}
              className={`tab-button ${activeTab === "book" ? "is-active" : ""}`}
              onClick={() => setActiveTab("book")}
            >
              <span className="tab-icon" aria-hidden="true">＋</span>
              จองคิวนัดหมาย
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "track"}
              className={`tab-button ${activeTab === "track" ? "is-active" : ""}`}
              onClick={() => setActiveTab("track")}
            >
              <span className="tab-icon" aria-hidden="true">⌕</span>
              ติดตามสถานะคิว
            </button>
          </div>
          <div className="control-meta">
            <div className="theme-picker" role="group" aria-label="เลือกสีธีม">
              <span className="theme-picker-label">ธีมสี</span>
              {COLOR_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`theme-option ${colorTheme === theme.id ? "is-active" : ""}`}
                  aria-label={theme.label}
                  aria-pressed={colorTheme === theme.id}
                  title={theme.label}
                  onClick={() => setColorTheme(theme.id)}
                >
                  <span className="theme-swatch" style={{ backgroundColor: theme.swatch }} />
                </button>
              ))}
            </div>
            <div className="today-label"><span className="today-label-dot" /> {formatThaiDate(dateToday, false)}</div>
          </div>
        </div>

        {activeTab === "book" ? (
          <div className="booking-layout">
            <section className="panel booking-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">แบบฟอร์มออนไลน์</div>
                  <h2 className="panel-title">ฟอร์มกรอกข้อมูลการจอง</h2>
                  <p className="panel-subtitle">เลือกเรื่องที่ขอรับบริการ ระบบจะจัดกลุ่มงานและตรวจสอบคิวว่างให้อัตโนมัติ</p>
                </div>
                <div className="panel-chip"><span className="chip-dot" /> ตรวจสอบคิวว่าง</div>
              </div>

              {bookingError ? <div className="notice notice-error" role="alert">{bookingError}</div> : null}

              <form onSubmit={handleBookingSubmit}>
                <div className="field-section">
                  <div className="section-heading">
                    <span className="section-number">1</span>
                    <div><h3>ข้อมูลการขอรับบริการ</h3><p>กรอกหน่วยงานและเลือกเรื่องที่ต้องการติดต่อ</p></div>
                  </div>
                  <div className="field-grid">
                    <div className="field full">
                      <label htmlFor="agency">ชื่อส่วนราชการผู้รับบริการ</label>
                      <div className="agency-combobox">
                        <input
                          id="agency"
                          className="input"
                          type="text"
                          role="combobox"
                          aria-autocomplete="list"
                          aria-expanded={agencyDropdownOpen}
                          aria-controls="agency-suggestions"
                          aria-activedescendant={agencyDropdownOpen && agencySuggestions.length > 0 ? `agency-option-${activeAgencyIndex}` : undefined}
                          value={form.agency}
                          onChange={(event) => {
                            updateForm("agency", event.target.value);
                            setActiveAgencyIndex(0);
                            setAgencyDropdownOpen(true);
                          }}
                          onFocus={() => {
                            setActiveAgencyIndex(0);
                            setAgencyDropdownOpen(true);
                          }}
                          onBlur={() => window.setTimeout(() => setAgencyDropdownOpen(false), 120)}
                          onKeyDown={handleAgencyKeyDown}
                          placeholder="พิมพ์ค้นหาหรือระบุชื่อส่วนราชการ"
                          autoComplete="off"
                          maxLength={200}
                          required
                        />
                        {agencyDropdownOpen ? (
                          <div className="agency-suggestions" id="agency-suggestions" role="listbox" aria-label="รายการส่วนราชการที่ตรงกัน">
                            {agencySuggestions.length > 0 ? agencySuggestions.map((agency, index) => (
                              <button
                                type="button"
                                id={`agency-option-${index}`}
                                className={`agency-option ${activeAgencyIndex === index ? "is-active" : ""}`}
                                key={agency}
                                role="option"
                                aria-selected={activeAgencyIndex === index}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => selectAgency(agency)}
                              >
                                {agency}
                              </button>
                            )) : (
                              <div className="agency-no-match" role="option" aria-disabled="true">
                                ไม่พบรายการที่ตรงกัน — สามารถใช้ชื่อที่พิมพ์ได้
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="field full">
                      <label htmlFor="topicId">เรื่องที่ขอรับบริการ</label>
                      <select
                        id="topicId"
                        className="select"
                        value={form.topicId}
                        onChange={(event) => handleTopicChange(event.target.value)}
                        required
                      >
                        <option value="">-- กรุณาเลือกเรื่องที่ขอรับบริการ --</option>
                        {BOOKING_TOPIC_GROUPS.map((group) => (
                          <optgroup key={group.department} label={group.department}>
                            {group.topics.map((topic) => (
                              <option key={topic.id} value={topic.id}>{topic.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {selectedTopic?.allowsOther ? (
                        <input
                          className="input other-topic-input"
                          type="text"
                          value={form.topicOther}
                          onChange={(event) => updateForm("topicOther", event.target.value)}
                          placeholder="โปรดระบุรายละเอียดเพิ่มเติม..."
                          maxLength={300}
                          required
                        />
                      ) : null}
                    </div>
                    <div className="field full">
                      <label htmlFor="departmentDisplay">กลุ่มงานที่รับผิดชอบ (จัดให้อัตโนมัติ)</label>
                      <input
                        id="departmentDisplay"
                        className="input readonly-input"
                        type="text"
                        value={selectedTopic?.department ?? ""}
                        placeholder="ระบบจะเลือกกลุ่มงานให้อัตโนมัติ"
                        readOnly
                      />
                    </div>
                  </div>
                </div>

                <div className="field-section">
                  <div className="section-heading">
                    <span className="section-number">2</span>
                    <div><h3>วันและเวลาที่ต้องการเข้าพบ</h3><p>ตรวจสอบคิวว่างแยกตามวันและกลุ่มงาน</p></div>
                  </div>
                  <div className="field-grid">
                    <div className="field full">
                      <label htmlFor="bookingDate">วันที่ต้องการเข้าพบ</label>
                      <input
                        id="bookingDate"
                        className="input"
                        type="date"
                        min={dateToday}
                        value={form.date}
                        onChange={(event) => handleDateChange(event.target.value)}
                        required
                      />
                    </div>
                    <div className="field full">
                      <span className="field-label">เลือกช่วงเวลาเข้าพบ <span className="field-hint">ตรวจสอบคิวว่างตามกลุ่มงาน</span></span>
                      <div className="time-slot-grid" role="group" aria-label="ช่วงเวลานัดหมาย">
                        {!selectedTopic ? (
                          <div className="slot-message">กรุณาเลือกเรื่องที่ขอรับบริการก่อน</div>
                        ) : isLoadingSlots ? (
                          <div className="slot-message">กำลังตรวจสอบช่วงเวลาว่าง…</div>
                        ) : slotsError ? (
                          <div className="slot-message slot-message-error">{slotsError}</div>
                        ) : slots.length === 0 ? (
                          <div className="slot-message">ไม่พบช่วงเวลาที่เปิดให้จอง</div>
                        ) : slots.map((slot) => (
                          <button
                            type="button"
                            key={slot.id}
                            className={`time-slot ${form.timeSlot === slot.id ? "is-selected" : ""} ${!slot.available ? "is-unavailable" : ""}`}
                            aria-pressed={form.timeSlot === slot.id}
                            disabled={!slot.available}
                            onClick={() => updateForm("timeSlot", slot.id)}
                          >
                            <span>{slot.label}</span>
                            <span className={`slot-availability ${slot.available ? "" : "is-full"}`}>
                              {slot.available
                                ? "✨ ว่าง"
                                : slot.reason === "past"
                                ? "⏰ เลยเวลาแล้ว"
                                : "🔒 กลุ่มนี้จองแล้ว"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="button-row">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={isSubmitting}
                    onClick={() => {
                      setForm({ agency: "", topicId: "", topicOther: "", date: getBangkokToday(), timeSlot: "" });
                      setBookingError("");
                    }}
                  >ล้างข้อมูล</button>
                  <button type="submit" className="button-primary" disabled={isSubmitting || isLoadingSlots}>
                    <span>{isSubmitting ? "กำลังบันทึกคิว…" : "ยืนยันการจองคิว"}</span>
                    <span className="button-arrow" aria-hidden="true">→</span>
                  </button>
                </div>
              </form>
            </section>

          </div>
        ) : (
          <section className="panel tracking-panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">ตรวจสอบข้อมูลนัดหมาย</div>
                <h2 className="panel-title">ติดตามสถานะการจองคิว</h2>
                <p className="panel-subtitle">กรอกหมายเลขคิวเพื่อติดตามสถานะและประเมินความพึงพอใจแยกตามเรื่องที่จอง</p>
              </div>
            </div>
            <form className="ticket-search" onSubmit={handleStatusLookup}>
              <input
                className="input ticket-input"
                type="text"
                value={ticketInput}
                onChange={(event) => {
                  setTicketInput(event.target.value.toUpperCase());
                  setStatusError("");
                }}
                placeholder="เช่น NID-8F3K9A"
                autoComplete="off"
                maxLength={10}
              />
              <button type="submit" className="button-primary" disabled={isCheckingStatus}>
                {isCheckingStatus ? "กำลังค้นหา…" : "ค้นหา"}
              </button>
            </form>
            {statusError ? <div className="notice notice-error tracking-notice" role="alert">{statusError}</div> : null}
            {statusResult ? (
              <div className="tracking-result">
                <div className="tracking-result-header">
                  <div><span className="summary-label">หมายเลขคิว</span><strong className="tracking-ticket-id">{statusResult.ticketId}</strong></div>
                  <span className="queue-status"><span />{statusResult.status}</span>
                </div>
                <div className="tracking-details">
                  <div><span>เจ้าหน้าที่ผู้รับเรื่อง</span><strong>{statusResult.receiverName}</strong></div>
                  <div><span>หน่วยงานผู้รับบริการ</span><strong>{statusResult.agency}</strong></div>
                  <div><span>เรื่องที่นัดหมาย</span><strong>{statusResult.topic}</strong></div>
                  <div><span>กลุ่มงาน</span><strong>{statusResult.department}</strong></div>
                  <div><span>วันที่เข้าพบ</span><strong>{formatThaiDate(statusResult.date)}</strong></div>
                  <div><span>ช่วงเวลา</span><strong>{statusResult.timeSlot}</strong></div>
                  <div><span>หมายเหตุเพิ่มเติม</span><strong>{statusResult.note || "-"}</strong></div>
                </div>
                {statusResult.status === "ยกเลิก" ? (
                  <p className="satisfaction-muted">คิวที่ยกเลิกแล้วไม่สามารถให้คะแนนได้</p>
                ) : (
                  <section className="satisfaction-panel" aria-labelledby="satisfactionTitle">
                    <div className="satisfaction-heading">
                      <h3 id="satisfactionTitle">ให้คะแนนความพึงพอใจ</h3>
                      <p>ประเมินเรื่อง “{statusResult.topic}” ตั้งแต่ 1–5 ดาว</p>
                    </div>
                    <div className="satisfaction-stars" role="group" aria-label="เลือกคะแนนความพึงพอใจ">
                      {[1, 2, 3, 4, 5].map((stars) => (
                        <button
                          key={stars}
                          type="button"
                          className={`satisfaction-star ${ratingValue >= stars ? "is-selected" : ""}`}
                          onClick={() => {
                            setRatingValue(stars);
                            setRatingError("");
                            setRatingMessage("");
                          }}
                          aria-label={`${stars} ดาว`}
                          aria-pressed={ratingValue === stars}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                    <div className="satisfaction-actions">
                      <span>{ratingValue ? `เลือก ${ratingValue} จาก 5 ดาว` : "แตะดาวเพื่อให้คะแนน"}</span>
                      <button type="button" className="button-primary" onClick={saveBookingRating} disabled={isSavingRating || ratingValue === 0}>
                        {isSavingRating ? "กำลังบันทึก…" : statusResult.satisfactionRating ? "ปรับปรุงคะแนน" : "บันทึกคะแนน"}
                      </button>
                    </div>
                    {ratingError ? <p className="satisfaction-feedback is-error" role="alert">{ratingError}</p> : null}
                    {ratingMessage ? <p className="satisfaction-feedback is-success" role="status">{ratingMessage}</p> : null}
                    <div className="satisfaction-summary">
                      <strong>คะแนนเฉลี่ย {statusResult.ratingStats?.average.toFixed(2) ?? "0.00"} / 5</strong>
                      <span>{statusResult.ratingStats?.total ?? 0} คะแนนในเรื่องนี้</span>
                    </div>
                    <div className="satisfaction-distribution" aria-label="การกระจายคะแนนในเรื่องนี้">
                      {[5, 4, 3, 2, 1].map((stars) => {
                        const count = statusResult.ratingStats?.counts[String(stars) as keyof BookingRatingStats["counts"]] ?? 0;
                        const total = statusResult.ratingStats?.total ?? 0;
                        const percent = total ? (count / total) * 100 : 0;
                        return (
                          <div className="satisfaction-distribution-row" key={stars}>
                            <span>{stars} ★</span>
                            <div className="satisfaction-meter"><span style={{ width: `${percent}%` }} /></div>
                            <span>{count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            ) : null}
          </section>
        )}

      </div>

      <footer className="developer-footer" aria-label="ข้อมูลผู้พัฒนา">
        <div className="developer-card">
          <p className="developer-name">
            <span className="developer-icons" aria-hidden="true">
              <span>🦋</span>
              <span>👧</span>
            </span>
            <span>พรรณลิณี แผนเมือง</span>
          </p>
          <p className="developer-role">นักวิชาการเงินและบัญชี กลุ่มงานวิชาการ</p>
          <p className="developer-caption">ผู้พัฒนาระบบนัดหมายบริการส่วนราชการ</p>
        </div>
      </footer>

      {confirmation ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirmationTitle">
            <div className="confirmation-check" aria-hidden="true">✓</div>
            <h2 id="confirmationTitle">จองคิวสำเร็จแล้ว</h2>
            <p className="confirmation-subtitle">บันทึกรหัสคิวหรือสแกน QR Code เพื่อติดตามสถานะและให้คะแนนความพึงพอใจ</p>
            <div className="confirmation-ticket">
              <span>หมายเลขคิวนัดหมาย (Ticket ID)</span>
              <strong>{confirmation.ticketId}</strong>
              <QueueQrCode ticketId={confirmation.ticketId} />
            </div>
            <div className="confirmation-summary">
              <p>{formatThaiDate(confirmation.date)} · {confirmation.timeSlot}</p>
              <p>{confirmation.department}</p>
            </div>
            <button type="button" className="button-primary confirmation-close" onClick={closeConfirmation}>ปิดหน้าต่าง</button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
