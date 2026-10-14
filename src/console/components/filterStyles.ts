/** Filter-bar controls shared by the console's list pages (Charge Points,
 *  Message Log, Run History) and the selects of the charge point page, so
 *  every select has the same height, padding and chevron (`.cx-select` in
 *  index.css draws it; the right padding keeps the text clear of it). `py-0`
 *  undoes the flowbite base padding, which overflowed the fixed height and
 *  clipped the text. */
export const FILTER_SELECT_CLASS =
  "cx-select h-8 rounded-[7px] border border-cx-border bg-cx-card py-0 pl-2.5 pr-7 text-[13px] text-cx-fg hover:border-cx-border-strong";

export const FILTER_INPUT_CLASS =
  "rounded-[7px] border border-cx-border bg-cx-card px-2.5 py-1.5 text-[13px] text-cx-fg placeholder:text-cx-faint hover:border-cx-border-strong";
