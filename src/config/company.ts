/**
 * Company details printed on every quotation.
 * Only facts confirmed by NewGen go here. Bank details are left out until provided,
 * so the PDF never shows made-up payment information.
 */
export const COMPANY = {
  name: "NewGen Innovation Sdn. Bhd.",
  registration: "202201030615 (1476312T)",
  addressLines: [
    "Seksyen C No. 188, Jalan S2 C9,",
    "Green Technology Park Seremban 2,",
    "70300 Seremban, Negeri Sembilan, Malaysia",
  ],
  /** e.g. { bank: "...", accountName: "...", accountNumber: "..." } — set once Finance confirms. */
  bank: null as null | { bank: string; accountName: string; accountNumber: string },
  logoPath: "public/brand/newgen-logo.png",
  brandColor: "#7B5BD6",
};
