export type SettingsMap = Record<string, string>;

export type TelegramAction = "RECEIVE" | "PENDING" | "APPROVE" | "NOT_FOUND";

export interface TelegramActionConfig {
  action: TelegramAction;
  buttonText: string;
  statusText: string;
  icon: string;
}

export interface RequestRecord {
  id: string;
  reqId: string;
  requestDate: string;
  requestTime: string;
  requestSummary: string;
  agency: string;
  maskedCitizenId: string;
  status: string;
  note: string;
  telegramStatus: string;
  createdAt: string;
}

export interface CreateRequestInput {
  requestCount: number;
  agency: string;
}

export interface CreateBookingInput {
  agency: string;
  topicId: string;
  topicOther?: string;
  consultationDetails: string;
  date: string;
  timeSlot: string;
}

export interface UpdateRequestStatusInput {
  status: string;
  note?: string;
  sendNotification?: boolean;
}

export interface TelegramRequestNotificationPayload {
  reqId: string;
  requestSummary: string;
  agency: string;
  dateText: string;
  timeText: string;
  status: string;
}
