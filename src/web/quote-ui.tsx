export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", pending_approval: "Waiting for Finance", submitted: "Waiting for Finance",
  approved: "Approved", rejected: "Sent back", cancelled: "Cancelled", superseded: "Superseded",
};

export function QuoteStatus({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{QUOTE_STATUS_LABEL[status] ?? status}</span>;
}
