import { redactLogFields } from "../shared/redact";

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ source: "wirecall", event, ...redactLogFields(fields) }));
}
