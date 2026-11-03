export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", finalised: "Finalised", sent: "Sent", cancelled: "Cancelled", superseded: "Replaced",
};

export function QuoteStatus({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{QUOTE_STATUS_LABEL[status] ?? status}</span>;
}
