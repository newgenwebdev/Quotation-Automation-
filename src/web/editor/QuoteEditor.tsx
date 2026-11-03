"use client";
/**
 * THE QUOTATION EDITOR — one page, nine sections, used for both "Generate with Quinn" (opens
 * pre-filled) and "Generate manually" (opens blank). Totals update live using the same maths
 * as the server (calc.ts); the server recalculates and validates everything when saving.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { QuinnNotes } from "@/db/schema";
import {
  PLACEHOLDER_CLIENT, PLACEHOLDER_TITLE, addDays, daysBetween, formatRM, linesFromPriceList, parsePercent, parseRinggit, percentLabel,
  reviewQuote, senToInput, type PriceListItem,
} from "@/quotations/calc";
import {
  discountFrom, liveTotals, newKey, parseQty, toPayload,
  type EditorLine, type EditorState, type FieldErrors,
} from "./model";

export interface EditorProps {
  initial: EditorState;
  createdBy: string | null;
  priceList: (PriceListItem & { priceText: string })[];
  templates: { id: string; name: string; body: string; isDefault: boolean }[];
  previousTerms: { versionId: string; label: string; termsText: string }[];
  aiNotes: QuinnNotes | null;
  validityDays: number;
  today: string;
  flash?: string | null;
}

type Banner = { kind: "ok" | "error" | "warn" | "info"; text: string; list?: string[] } | null;

const CATEGORY_LABEL: Record<string, string> = {
  website: "Website", landing_page: "Landing page", ecommerce: "E-commerce", mobile_app: "Mobile app",
  custom_software: "Custom software", ai_automation: "AI automation", seo: "SEO", hosting: "Hosting", maintenance: "Maintenance", other: "Other",
};

export function QuoteEditor(props: EditorProps) {
  const [s, setS] = useState<EditorState>(props.initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "finalise" | "preview">(null);
  const [banner, setBanner] = useState<Banner>(props.flash ? { kind: "ok", text: props.flash } : null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [confirm, setConfirm] = useState<null | { errors: string[]; warnings: string[] }>(null);
  const [termsUndo, setTermsUndo] = useState<null | Pick<EditorState, "termsText" | "termsTemplateId" | "termsSourceVersionId">>(null);
  const edits = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);
  const finalRef = useRef<HTMLElement>(null);

  const change = useCallback((fn: (prev: EditorState) => EditorState) => {
    edits.current += 1;
    setDirty(true);
    setS(fn);
  }, []);
  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) => change((p) => ({ ...p, [k]: v }));
  const setClient = (k: keyof EditorState["client"], v: string) => change((p) => ({ ...p, client: { ...p.client, [k]: v } }));

  const live = useMemo(() => liveTotals(s), [s]);
  const review = useMemo(() => {
    const parsed = s.lines.filter((l) => l.description.trim() || l.unitPrice.trim()).map((l) => {
      const p = parseRinggit(l.unitPrice);
      return { description: l.description || "(no description)", quantity: parseQty(l.quantity) ?? 1, unitPriceSen: p === null || Number.isNaN(p) ? null : p };
    });
    return reviewQuote({
      quoteDate: s.quoteDate || null, validUntil: s.validUntil || null, clientCompany: s.client.company, projectTitle: s.projectTitle,
      overview: s.overview, scopeCount: s.services.length + s.features.length + s.deliverables.length,
      lines: parsed, discount: discountFrom(s), subtotalSen: live.totals.subtotalSen, totalSen: live.totals.totalSen,
      paymentMilestones: s.paymentMilestones.filter((m) => m.label.trim() || m.percent.trim()).map((m) => {
        const bp = parsePercent(m.percent);
        return { label: m.label, percentBp: bp === null || Number.isNaN(bp) ? 0 : bp };
      }),
      termsText: s.termsText,
    }, props.today);
  }, [s, live, props.today]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const showBanner = (b: Banner) => { setBanner(b); requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };

  const save = async (opts: { finalise?: boolean; quiet?: boolean } = {}): Promise<string | null> => {
    const { payload, errors: fe } = toPayload(s);
    setErrors(fe);
    if (Object.keys(fe).length) {
      showBanner({ kind: "error", text: "Please fix the highlighted fields before saving.", list: [...new Set(Object.values(fe))] });
      return null;
    }
    const startedAt = edits.current;
    setBusy(opts.finalise ? "finalise" : opts.quiet ? "preview" : "save");
    try {
      const res = await fetch("/api/quotations/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, payload, finalise: !!opts.finalise }),
      });
      const data = await res.json().catch(() => null) as null | { ok: boolean; id?: string; number?: string; updatedAt?: string; finalised?: boolean; errors?: string[]; error?: string; issues?: string[] };
      if (res.status === 401) { showBanner({ kind: "error", text: "Your session has ended. Copy anything you need, then sign in again in a new tab. Nothing was saved." }); return null; }
      if (!res.ok || !data?.ok || !data.id) {
        showBanner({ kind: "error", text: data?.error ?? "Couldn't save. Check your connection and try again. Nothing was lost on this page.", list: data?.issues });
        return null;
      }
      const { id, number, updatedAt } = data as { id: string; number: string; updatedAt: string };
      setS((p) => ({ ...p, id, number, updatedAt }));
      if (edits.current === startedAt) setDirty(false);
      setSavedAt(new Date());
      if (!s.id) window.history.replaceState(null, "", `/quotations/${id}`);
      if (opts.finalise) {
        if (data.finalised) {
          setDirty(false);
          window.location.assign(`/quotations/${id}?ok=${encodeURIComponent(`${number} is finalised. Download the PDF and send it to the client.`)}`);
        } else {
          setConfirm({ errors: data.errors ?? ["This quotation isn't ready to finalise yet."], warnings: [] });
          showBanner({ kind: "warn", text: "Draft saved, but it can't be finalised yet:", list: data.errors });
        }
      } else if (!opts.quiet) {
        setBanner({ kind: "ok", text: `Draft saved${number ? ` as ${number}` : ""}.` });
      }
      return id;
    } catch {
      showBanner({ kind: "error", text: "Couldn't reach the server. Check your connection and try again. Nothing was lost on this page." });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    // Open the tab now (browsers block pop-ups opened after a delay), then point it at the PDF.
    const w = window.open("about:blank", "_blank");
    const id = dirty || !s.id ? await save({ quiet: true }) : s.id;
    if (!id) { w?.close(); return; }
    const url = `/quotations/${id}/pdf?inline=1`;
    if (w) w.location.href = url; else window.location.assign(url);
  };

  const startFinalise = () => {
    const { errors: fe } = toPayload(s);
    setErrors(fe);
    const fieldProblems = [...new Set(Object.values(fe))];
    setConfirm({ errors: [...fieldProblems, ...review.errors], warnings: review.warnings });
    requestAnimationFrame(() => finalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // Ctrl/Cmd + S saves.
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!busy) void save(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ---------- Lines ----------
  const updateLine = (key: string, patch: Partial<EditorLine>) =>
    change((p) => ({ ...p, lines: p.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: string) => change((p) => ({ ...p, lines: p.lines.filter((l) => l.key !== key) }));
  const addLine = () => change((p) => ({ ...p, lines: [...p.lines, { key: newKey("l"), catalogueItemId: null, category: null, description: "", details: "", quantity: "1", unitLabel: "", unitPrice: "" }] }));
  const [pick, setPick] = useState({ id: "", qty: "1", error: "" });
  const addFromList = () => {
    const item = props.priceList.find((i) => i.id === pick.id);
    if (!item) { setPick((x) => ({ ...x, error: "Choose a service from the price list." })); return; }
    const qty = parseQty(pick.qty);
    if (qty === null) { setPick((x) => ({ ...x, error: "Quantity must be a whole number of at least 1." })); return; }
    const r = linesFromPriceList(item, qty);
    if ("problem" in r) { setPick((x) => ({ ...x, error: `${r.problem} Add it as a separate item with your own price instead.` })); return; }
    const added: EditorLine[] = r.lines.map((l) => ({
      key: newKey("l"), catalogueItemId: l.catalogueItemId, category: l.category, description: l.description, details: l.details ?? "",
      quantity: String(l.quantity), unitLabel: l.unitLabel ?? "", unitPrice: senToInput(l.unitPriceSen),
    }));
    change((p) => {
      const keep = p.lines.filter((l) => l.description.trim() || l.unitPrice.trim() || l.details.trim());
      return { ...p, lines: [...keep, ...added] };
    });
    setPick({ id: "", qty: "1", error: "" });
  };

  // ---------- Terms ----------
  const termsChoice = s.termsSourceVersionId ? `q:${s.termsSourceVersionId}` : s.termsTemplateId ? `t:${s.termsTemplateId}` : "";
  const chooseTerms = (value: string) => {
    if (!value) return;
    const [kind, id] = value.split(":");
    const text = kind === "t" ? props.templates.find((t) => t.id === id)?.body : props.previousTerms.find((p) => p.versionId === id)?.termsText;
    if (text === undefined) return;
    setTermsUndo({ termsText: s.termsText, termsTemplateId: s.termsTemplateId, termsSourceVersionId: s.termsSourceVersionId });
    change((p) => ({ ...p, termsText: text, termsTemplateId: kind === "t" ? id : null, termsSourceVersionId: kind === "q" ? id : null }));
  };

  const err = (k: string) => errors[k];
  const notes = props.aiNotes;
  const unpricedCount = s.lines.filter((l) => (l.description.trim() || l.details.trim()) && !l.unitPrice.trim()).length;
  const validDays = s.quoteDate && s.validUntil ? daysBetween(s.quoteDate, s.validUntil) : null;
  const placeholderClient = s.client.company.trim().toLowerCase() === PLACEHOLDER_CLIENT.toLowerCase();
  const placeholderTitle = s.projectTitle.trim().toLowerCase() === PLACEHOLDER_TITLE.toLowerCase();

  return (
    <div className="editor">
      <div ref={topRef} style={{ scrollMarginTop: 80 }} />
      <a className="back" href="/quotations">← Quotations</a>
      <div className="page-head">
        <div>
          <h1>{s.number ?? (notes ? "Quinn's draft" : "New quotation")}</h1>
          <p className="sub">
            <span className="badge draft">Draft</span>{" "}
            {s.version > 1 && <>Revision {s.version} · </>}
            {props.createdBy ? <>Created by {props.createdBy}</> : "Fill in the sections below, then preview and finalise."}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void preview()} disabled={!!busy}>Preview PDF</button>
        </div>
      </div>

      {banner && (
        <div className={`msg ${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
          {banner.text}
          {banner.list && banner.list.length > 0 && <ul>{banner.list.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}

      {notes && (
        <details className="card notes-panel" open>
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Quinn&apos;s notes: check these before finalising <span className="hint">(internal, never printed)</span></summary>
          <div className="grid" style={{ marginTop: 12 }}>
            {notes.missingInformation.length > 0 && <div><div className="label">Missing information</div><ul>{notes.missingInformation.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            {notes.clarificationQuestions.length > 0 && <div><div className="label">Questions to ask the client</div><ul>{notes.clarificationQuestions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            {notes.assumptions.length > 0 && <div><div className="label">What Quinn assumed or estimated</div><ul>{notes.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            {(notes.pricingNotes?.length ?? 0) > 0 && <div><div className="label">Pricing</div><ul>{notes.pricingNotes!.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          </div>
        </details>
      )}

      {/* 1 ---------- Quotation information ---------- */}
      <Section n={1} title="Quotation information">
        <div className="grid-3">
          <div className="field">
            <label htmlFor="number">Quotation number</label>
            <input id="number" value={s.number ?? "Assigned automatically when saved"} readOnly />
          </div>
          <Field id="quoteDate" label="Quotation date" error={err("quoteDate")}>
            <input id="quoteDate" type="date" value={s.quoteDate} required aria-invalid={!!err("quoteDate")} className={err("quoteDate") ? "invalid" : ""}
              onChange={(e) => set("quoteDate", e.target.value)} />
          </Field>
          <Field id="validUntil" label="Valid until" hint={validDays !== null && validDays >= 0 ? `${validDays} day${validDays === 1 ? "" : "s"}` : undefined} error={err("validUntil")}>
            <input id="validUntil" type="date" value={s.validUntil} min={s.quoteDate} aria-invalid={!!err("validUntil")} className={err("validUntil") ? "invalid" : ""}
              onChange={(e) => set("validUntil", e.target.value)} />
            {s.quoteDate && validDays !== props.validityDays && (
              <button type="button" className="ghost sm" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => set("validUntil", addDays(s.quoteDate, props.validityDays))}>
                Use the default ({props.validityDays} day{props.validityDays === 1 ? "" : "s"})
              </button>
            )}
          </Field>
        </div>
      </Section>

      {/* 2 ---------- Customer ---------- */}
      <Section n={2} title="Customer information">
        <div className="grid-2">
          <Field id="company" label="Client company" error={err("client.company")} hint={placeholderClient ? "Quinn couldn't find it: please enter it" : undefined}>
            <input id="company" value={s.client.company} required autoComplete="organization" aria-invalid={!!err("client.company")}
              className={err("client.company") ? "invalid" : placeholderClient ? "flag" : ""} onChange={(e) => setClient("company", e.target.value)} />
          </Field>
          <Field id="contactName" label="Contact person" hint="optional">
            <input id="contactName" value={s.client.contactName} autoComplete="name" onChange={(e) => setClient("contactName", e.target.value)} />
          </Field>
          <Field id="email" label="Email" hint="optional" error={err("client.email")}>
            <input id="email" type="email" value={s.client.email} autoComplete="email" aria-invalid={!!err("client.email")} className={err("client.email") ? "invalid" : ""}
              onChange={(e) => setClient("email", e.target.value)} />
          </Field>
          <Field id="phone" label="Phone" hint="optional">
            <input id="phone" type="tel" value={s.client.phone} autoComplete="tel" onChange={(e) => setClient("phone", e.target.value)} />
          </Field>
          <Field id="address" label="Company address" hint="optional" className="span-2">
            <textarea id="address" className="grow" rows={2} value={s.client.address} autoComplete="street-address" onChange={(e) => setClient("address", e.target.value)} />
          </Field>
        </div>
      </Section>

      {/* 3 ---------- Project ---------- */}
      <Section n={3} title="Project information">
        <Field id="projectTitle" label="Project title" error={err("projectTitle")} hint={placeholderTitle ? "Quinn couldn't tell: please enter it" : undefined}>
          <input id="projectTitle" value={s.projectTitle} required aria-invalid={!!err("projectTitle")} className={err("projectTitle") ? "invalid" : placeholderTitle ? "flag" : ""}
            placeholder="e.g. Corporate website revamp" onChange={(e) => set("projectTitle", e.target.value)} />
        </Field>
        <Field id="overview" label="Project overview" hint="a short paragraph for the client">
          <textarea id="overview" rows={4} value={s.overview} className={!s.overview.trim() && notes ? "flag" : ""}
            placeholder="What the client needs and what NewGen will deliver." onChange={(e) => set("overview", e.target.value)} />
        </Field>
        <ListField label="Project objectives" hint="the client's business goals" items={s.objectives} onChange={(v) => set("objectives", v)} addLabel="Add objective" />
      </Section>

      {/* 4 ---------- Scope ---------- */}
      <Section n={4} title="Scope of work">
        <div className="grid-2">
          <ListField label="Services included" items={s.services} onChange={(v) => set("services", v)} addLabel="Add service" />
          <ListField label="Features and functionalities" items={s.features} onChange={(v) => set("features", v)} addLabel="Add feature" />
          <ListField label="Deliverables" items={s.deliverables} onChange={(v) => set("deliverables", v)} addLabel="Add deliverable" />
          <ListField label="Exclusions" hint="not included" items={s.exclusions} onChange={(v) => set("exclusions", v)} addLabel="Add exclusion" />
          <ListField label="Technical requirements" hint="optional" items={s.technicalRequirements} onChange={(v) => set("technicalRequirements", v)} addLabel="Add requirement" />
        </div>
      </Section>

      {/* 5 ---------- Pricing ---------- */}
      <Section n={5} title="Pricing breakdown" aside={unpricedCount > 0 ? <span className="badge review">{unpricedCount} need{unpricedCount === 1 ? "s" : ""} a price</span> : undefined}>
        <div className="lines" role="group" aria-label="Pricing items">
          <div className="line-row head" aria-hidden="true">
            <span>#</span><span>Item</span><span>Qty</span><span>Unit</span><span style={{ textAlign: "right" }}>Unit price (RM)</span><span style={{ textAlign: "right" }}>Amount</span><span />
          </div>
          {s.lines.map((l, i) => {
            const total = live.lineTotals.get(l.key) ?? null;
            const needsPrice = !l.unitPrice.trim() && !!(l.description.trim() || l.details.trim());
            return (
              <div className="line-row" key={l.key}>
                <span className="no">{i + 1}</span>
                <div className="desc">
                  <span className="mlabel">Item {i + 1}</span>
                  <input aria-label={`Item ${i + 1} description`} value={l.description} placeholder="Description, e.g. UI/UX design"
                    className={err(`line.${l.key}.description`) ? "invalid" : ""} onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                  <textarea aria-label={`Item ${i + 1} details`} className="details grow" rows={1} value={l.details} placeholder="Details for the client (optional)"
                    onChange={(e) => updateLine(l.key, { details: e.target.value })} />
                  <div className="meta">
                    {needsPrice && <span className="badge review">Price review required</span>}
                    {l.catalogueItemId && !needsPrice && <span className="badge active" title="Uses the price list">Price list</span>}
                    {l.category && <span className="muted small">{CATEGORY_LABEL[l.category] ?? l.category}</span>}
                  </div>
                </div>
                <div>
                  <span className="mlabel">Qty</span>
                  <input aria-label={`Item ${i + 1} quantity`} inputMode="numeric" className={`num ${err(`line.${l.key}.quantity`) ? "invalid" : ""}`} value={l.quantity}
                    onChange={(e) => updateLine(l.key, { quantity: e.target.value })} />
                </div>
                <div>
                  <span className="mlabel">Unit</span>
                  <input aria-label={`Item ${i + 1} unit`} value={l.unitLabel} placeholder="e.g. page" className={err(`line.${l.key}.unitLabel`) ? "invalid" : ""}
                    onChange={(e) => updateLine(l.key, { unitLabel: e.target.value })} />
                </div>
                <div className="rm">
                  <span className="mlabel">Unit price (RM)</span>
                  <input aria-label={`Item ${i + 1} unit price in ringgit`} inputMode="decimal" placeholder={needsPrice ? "Enter price" : "0.00"}
                    className={`num ${err(`line.${l.key}.unitPrice`) ? "invalid" : needsPrice ? "flag" : ""}`} value={l.unitPrice}
                    onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                    onBlur={(e) => { const v = parseRinggit(e.target.value); if (v !== null && !Number.isNaN(v)) updateLine(l.key, { unitPrice: senToInput(v) }); }} />
                </div>
                <div className="amount" aria-live="polite">{total === null ? <span className="muted">—</span> : formatRM(total)}</div>
                <button type="button" className="icon-btn" aria-label={`Remove item ${i + 1}`} title="Remove item" onClick={() => removeLine(l.key)}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="add-link" onClick={addLine}>+ Add item</button>
        </div>

        {props.priceList.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="label">Add from the price list</div>
            <div className="add-from-list">
              <select aria-label="Service from the price list" value={pick.id} onChange={(e) => setPick({ ...pick, id: e.target.value, error: "" })}>
                <option value="">Choose a service…</option>
                {props.priceList.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.priceText}</option>)}
              </select>
              <input aria-label="Quantity" inputMode="numeric" value={pick.qty} onChange={(e) => setPick({ ...pick, qty: e.target.value, error: "" })} />
              <button type="button" className="secondary" onClick={addFromList}>Add</button>
            </div>
            {pick.error && <div className="field-error" role="alert">{pick.error}</div>}
          </div>
        )}

        <div className="pricing-extras">
          <div>
            <div className="label">Discount <span className="hint">· optional</span></div>
            <div className="grid-3" style={{ gridTemplateColumns: "140px 1fr" }}>
              <div>
                <span className="mini">Type</span>
                <select aria-label="Discount type" value={s.discountType} onChange={(e) => set("discountType", e.target.value as EditorState["discountType"])}>
                  <option value="none">No discount</option>
                  <option value="amount">Amount (RM)</option>
                  <option value="percent">Percent (%)</option>
                </select>
              </div>
              {s.discountType !== "none" && (
                <div>
                  <span className="mini">{s.discountType === "amount" ? "Amount (RM)" : "Percent (%)"}</span>
                  <input aria-label={s.discountType === "amount" ? "Discount amount in ringgit" : "Discount percentage"} inputMode="decimal"
                    placeholder={s.discountType === "amount" ? "e.g. 500" : "e.g. 10"} value={s.discountValue}
                    className={err("discountValue") ? "invalid" : ""} onChange={(e) => set("discountValue", e.target.value)} />
                </div>
              )}
            </div>
            {s.discountType !== "none" && (
              <div style={{ marginTop: 8 }}>
                <span className="mini">Label shown to the client</span>
                <input aria-label="Discount label" placeholder="e.g. Early sign-up discount" value={s.discountLabel} onChange={(e) => set("discountLabel", e.target.value)} />
              </div>
            )}
            {err("discountValue") && <div className="field-error">{err("discountValue")}</div>}
          </div>
          <div>
            <label className="check" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={s.taxEnabled} onChange={(e) => set("taxEnabled", e.target.checked)} /> Charge tax
            </label>
            {s.taxEnabled && (
              <div className="grid-3" style={{ gridTemplateColumns: "1fr 110px" }}>
                <div>
                  <span className="mini">Tax name</span>
                  <input aria-label="Tax name" placeholder="e.g. SST" value={s.taxLabel} className={err("taxLabel") ? "invalid" : ""} onChange={(e) => set("taxLabel", e.target.value)} />
                </div>
                <div>
                  <span className="mini">Rate (%)</span>
                  <input aria-label="Tax rate percent" inputMode="decimal" placeholder="e.g. 8" value={s.taxRate} className={err("taxRate") ? "invalid" : ""} onChange={(e) => set("taxRate", e.target.value)} />
                </div>
              </div>
            )}
            {(err("taxRate") || err("taxLabel")) && <div className="field-error">{err("taxRate") ?? err("taxLabel")}</div>}
          </div>
        </div>

        <div className="totals" aria-live="polite">
          <div className="t"><span>Subtotal</span><span>{formatRM(live.totals.subtotalSen)}</span></div>
          {live.totals.discountSen > 0 && (
            <div className="t"><span>{s.discountLabel.trim() || "Discount"}{s.discountType === "percent" && discountFrom(s) ? ` (${percentLabel(discountFrom(s)!.value)})` : ""}</span><span>- {formatRM(live.totals.discountSen)}</span></div>
          )}
          {s.taxEnabled && <div className="t"><span>{s.taxLabel || "Tax"}{s.taxRate ? ` (${s.taxRate}%)` : ""}</span><span>{formatRM(live.totals.taxSen)}</span></div>}
          <div className="t grand"><span>Total (MYR)</span><span>{formatRM(live.totals.totalSen)}</span></div>
          {unpricedCount > 0 && <p className="muted small" style={{ marginTop: 6 }}>Excludes {unpricedCount} item{unpricedCount === 1 ? "" : "s"} still needing a price.</p>}
        </div>
      </Section>

      {/* 6 ---------- Timeline ---------- */}
      <Section n={6} title="Project timeline">
        <Field id="duration" label="Estimated duration" hint="e.g. 8–10 weeks">
          <input id="duration" value={s.timelineDuration} onChange={(e) => set("timelineDuration", e.target.value)} />
        </Field>
        <div className="label">Delivery milestones <span className="hint">optional</span></div>
        {s.timelineMilestones.map((m, i) => (
          <div className="ms-row" key={m.key}>
            <input aria-label={`Milestone ${i + 1}`} placeholder="e.g. UI/UX design approval" value={m.label}
              onChange={(e) => change((p) => ({ ...p, timelineMilestones: p.timelineMilestones.map((x) => x.key === m.key ? { ...x, label: e.target.value } : x) }))} />
            <input aria-label={`Milestone ${i + 1} timing`} placeholder="e.g. Week 2" value={m.timing}
              onChange={(e) => change((p) => ({ ...p, timelineMilestones: p.timelineMilestones.map((x) => x.key === m.key ? { ...x, timing: e.target.value } : x) }))} />
            <button type="button" className="icon-btn" aria-label={`Remove milestone ${i + 1}`} onClick={() => change((p) => ({ ...p, timelineMilestones: p.timelineMilestones.filter((x) => x.key !== m.key) }))}>✕</button>
          </div>
        ))}
        <button type="button" className="add-link" onClick={() => change((p) => ({ ...p, timelineMilestones: [...p.timelineMilestones, { key: newKey("m"), label: "", timing: "" }] }))}>+ Add milestone</button>
      </Section>

      {/* 7 ---------- Payment terms ---------- */}
      <Section n={7} title="Payment terms" aside={<span className={`badge ${live.percentSum === 10000 ? "active" : "review"}`}>{live.percentSum / 100}% of 100%</span>}>
        <p className="muted small">First payment is usually the deposit, the last one the balance. Amounts are calculated from the total.</p>
        {s.paymentMilestones.map((m, i) => (
          <div className="pay-row" key={m.key}>
            <input aria-label={`Payment ${i + 1} name`} placeholder={i === 0 ? "Deposit" : "Balance on completion"} value={m.label}
              className={err(`pay.${m.key}.label`) ? "invalid" : ""}
              onChange={(e) => change((p) => ({ ...p, paymentMilestones: p.paymentMilestones.map((x) => x.key === m.key ? { ...x, label: e.target.value } : x) }))} />
            <input aria-label={`Payment ${i + 1} percentage`} inputMode="decimal" placeholder="%" value={m.percent}
              className={`num ${err(`pay.${m.key}.percent`) ? "invalid" : ""}`}
              onChange={(e) => change((p) => ({ ...p, paymentMilestones: p.paymentMilestones.map((x) => x.key === m.key ? { ...x, percent: e.target.value } : x) }))} />
            <span className="amount">{formatRM(live.split[i]?.amountSen ?? 0)}</span>
            <button type="button" className="icon-btn" aria-label={`Remove payment ${i + 1}`} onClick={() => change((p) => ({ ...p, paymentMilestones: p.paymentMilestones.filter((x) => x.key !== m.key) }))}>✕</button>
          </div>
        ))}
        <button type="button" className="add-link" onClick={() => change((p) => ({ ...p, paymentMilestones: [...p.paymentMilestones, { key: newKey("p"), label: "", percent: "" }] }))}>+ Add payment</button>
        <Field id="paymentNotes" label="Payment notes" hint="optional, e.g. how and when invoices are paid">
          <textarea id="paymentNotes" className="grow" rows={2} value={s.paymentNotes} onChange={(e) => set("paymentNotes", e.target.value)} />
        </Field>
      </Section>

      {/* 8 ---------- Terms ---------- */}
      <Section n={8} title="Terms and conditions">
        <Field id="termsSource" label="Standard T&C template">
          <div className="row">
            <select id="termsSource" value={termsChoice} onChange={(e) => chooseTerms(e.target.value)} style={{ flex: 1, minWidth: 220 }}>
              <option value="">{s.termsText ? "Edited / custom terms" : "Choose a template…"}</option>
              {props.templates.length > 0 && (
                <optgroup label="T&C templates">{props.templates.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}</optgroup>
              )}
              {props.previousTerms.length > 0 && (
                <optgroup label={`Used before for ${s.client.company}`}>{props.previousTerms.map((p) => <option key={p.versionId} value={`q:${p.versionId}`}>{p.label}</option>)}</optgroup>
              )}
            </select>
            {termsUndo && <button type="button" className="ghost sm" onClick={() => { const u = termsUndo; setTermsUndo(null); change((p) => ({ ...p, ...u })); }}>Undo</button>}
          </div>
          {props.templates.length === 0 && <p className="muted small" style={{ marginTop: 6 }}>No templates yet. Add your standard terms in <a href="/settings/terms">Settings → T&amp;C templates</a>.</p>}
        </Field>
        <Field id="termsText" label="Terms & conditions" hint="printed as written; adjust for this client if needed">
          <textarea id="termsText" rows={10} value={s.termsText}
            onChange={(e) => change((p) => ({ ...p, termsText: e.target.value }))} />
        </Field>
        <Field id="projectTerms" label="Project-specific terms" hint="optional">
          <textarea id="projectTerms" className="grow" rows={3} value={s.projectTerms} onChange={(e) => set("projectTerms", e.target.value)} />
        </Field>
        <ListField label="Assumptions" hint="optional, e.g. the client provides all content" items={s.assumptions} onChange={(v) => set("assumptions", v)} addLabel="Add assumption" />
      </Section>

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 650 }}>Internal notes <span className="hint">(for the NewGen team, never printed)</span></summary>
        <textarea aria-label="Internal notes" style={{ marginTop: 12 }} rows={3} value={s.internalNotes} onChange={(e) => set("internalNotes", e.target.value)} />
      </details>

      {/* 9 ---------- Final preview ---------- */}
      <section className="card" ref={finalRef} style={{ scrollMarginTop: 20 }} aria-labelledby="sec-9">
        <div className="card-head"><div className="section-title"><span className="step">9</span><h2 id="sec-9">Final preview</h2></div></div>
        <div className="grid-2">
          <div>
            <div className="cap">Summary</div>
            <p style={{ marginBottom: 4 }}><strong>{s.client.company || "Client company"}</strong></p>
            <p className="muted" style={{ marginBottom: 8 }}>{s.projectTitle || "Project title"}</p>
            <p style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{formatRM(live.totals.totalSen)}</p>
            <p className="muted small">{s.lines.filter((l) => l.description.trim()).length} pricing item(s) · {s.paymentMilestones.length} payment(s){s.validUntil ? ` · valid until ${s.validUntil}` : ""}</p>
            {live.split.length > 0 && (
              <ul className="small" style={{ paddingLeft: 18 }}>
                {live.split.map((m, i) => <li key={i}>{m.label || "Payment"} ({percentLabel(m.percentBp)}): {formatRM(m.amountSen)}</li>)}
              </ul>
            )}
          </div>
          <div>
            <div className="cap">Ready to finalise?</div>
            <ul className="checklist">
              {review.errors.map((x) => <li key={x} className="err"><span className="dot">!</span><span>{x}</span></li>)}
              {review.warnings.map((x) => <li key={x} className="warn"><span className="dot">?</span><span>{x}</span></li>)}
              {review.errors.length === 0 && <li className="ok"><span className="dot">✓</span><span>Everything required is filled in.</span></li>}
            </ul>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void preview()} disabled={!!busy}>{busy === "preview" ? "Saving…" : "Preview PDF"}</button>
          <button type="button" onClick={startFinalise} disabled={!!busy}>Finalise quotation</button>
        </div>
        {confirm && (
          <div className="confirm" role="dialog" aria-labelledby="confirm-title">
            {confirm.errors.length > 0 ? (
              <>
                <h3 id="confirm-title" style={{ marginTop: 0 }}>Not ready yet</h3>
                <ul>{confirm.errors.map((x) => <li key={x}>{x}</li>)}</ul>
                <button type="button" className="secondary" onClick={() => setConfirm(null)}>OK, keep editing</button>
              </>
            ) : (
              <>
                <h3 id="confirm-title" style={{ marginTop: 0 }}>Finalise {s.number ?? "this quotation"}?</h3>
                {confirm.warnings.length > 0 ? (
                  <><p>Please double-check:</p><ul>{confirm.warnings.map((x) => <li key={x}>{x}</li>)}</ul></>
                ) : <p>Everything looks complete.</p>}
                <p className="muted small">Finalising locks this version as the client-ready quotation. You can still start a new revision later.</p>
                <div className="actions">
                  <button type="button" onClick={() => { setConfirm(null); void save({ finalise: true }); }} disabled={!!busy}>{busy === "finalise" ? "Finalising…" : "Finalise quotation"}</button>
                  <button type="button" className="secondary" onClick={() => setConfirm(null)}>Keep editing</button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <div className="savebar">
        <div className="inner">
          <span className={`state ${dirty ? "dirty" : ""}`} aria-live="polite">
            {busy === "save" ? "Saving…" : busy === "finalise" ? "Finalising…" : dirty ? "Unsaved changes" : savedAt ? `Saved at ${savedAt.toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" })}` : s.id ? "All changes saved" : "Not saved yet"}
          </span>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void save()} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            <button type="button" className="secondary" onClick={() => void preview()} disabled={!!busy}>Preview</button>
            <button type="button" onClick={startFinalise} disabled={!!busy}>Finalise</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Small building blocks ----------

function Section({ n, title, aside, children }: { n: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={`sec-${n}`}>
      <div className="card-head">
        <div className="section-title"><span className="step">{n}</span><h2 id={`sec-${n}`}>{title}</h2></div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ id, label, hint, error, className, children }: { id: string; label: string; hint?: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label} {hint && <span className="hint">· {hint}</span>}</label>
      {children}
      {error && <div className="field-error" id={`${id}-error`}>{error}</div>}
    </div>
  );
}

/** A list of short text items: type, press Enter for the next one, ✕ to remove. */
function ListField({ label, hint, items, onChange, addLabel }: { label: string; hint?: string; items: string[]; onChange: (v: string[]) => void; addLabel: string }) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusAt.current !== null) { refs.current[focusAt.current]?.focus(); focusAt.current = null; }
  });
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, i: number) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const next = [...items];
      next.splice(i + 1, 0, "");
      focusAt.current = i + 1;
      onChange(next);
    } else if (e.key === "Backspace" && items[i] === "" && items.length > 0) {
      e.preventDefault();
      focusAt.current = Math.max(0, i - 1);
      onChange(items.filter((_, j) => j !== i));
    }
  };
  return (
    <div className="field list-field">
      <div className="label">{label} {hint && <span className="hint">· {hint}</span>}</div>
      {items.map((it, i) => (
        <div className="item" key={i}>
          <span className="bullet" aria-hidden="true">•</span>
          <textarea ref={(el) => { refs.current[i] = el; }} className="grow" rows={1} aria-label={`${label} ${i + 1}`} value={it}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value.replace(/\n/g, " ") : x)))} onKeyDown={(e) => onKey(e, i)} />
          <button type="button" className="icon-btn" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="add-link" onClick={() => { focusAt.current = items.length; onChange([...items, ""]); }}>+ {addLabel}</button>
    </div>
  );
}
