/**
 * The bottom-left column of standing-context controls — the name form,
 * the status panel, the huddle control and the call dock: what you claim
 * about yourself and what you do from where your avatar stands, as
 * opposed to the conversation (the chat panel, bottom-right) and the
 * space-level surfaces along the top (recordings, admin).
 *
 * Bottom to top, each control owns a band and sits on the band's bottom
 * edge (App's ColumnSlot). A band is at least the height it reserves, so a
 * control stays put while another one changes height within its band (an
 * inline error, the huddle join offer, the call dock coming and going); a
 * panel taller than its band (one that wraps on a narrow screen) stretches
 * the band and pushes the bands above it up rather than covering them.
 * Adding a control is adding a band: the bands above it move up by its
 * height.
 */

/** The column's distance from the canvas's left and bottom edges. */
export const COLUMN_INSET = 12;

/**
 * The bands, bottom to top, each with the height it reserves. The heights
 * keep the column's long-standing hand-tuned offsets (band bottoms 12, 58,
 * 148, 220) rather than following the panels: each band holds its panel's
 * desktop states (the huddle band fits the two-row join offer exactly,
 * with the fonts it was tuned against). A panel that grows past its band
 * (one that wraps on a narrow screen, or a taller font) moves the bands
 * above it up. The top band reserves nothing until a control lands above
 * it.
 */
const BANDS = [
  // What you claim about yourself: the name, and the status over it.
  { control: 'name', height: 46 },
  { control: 'status', height: 90 },
  // What you do from where you stand: a huddle is founded on the spot, a
  // call is joined from the conversation group the avatar stands in.
  { control: 'huddle', height: 72 },
  { control: 'call', height: 0 },
] as const;

/** The controls of the column: one per band, so a control cannot lack one. */
export type ColumnControl = (typeof BANDS)[number]['control'];

/**
 * Where `control`'s band goes in the column: its place in the stack
 * counted from the bottom (the flex `order`) and the height it reserves
 * (the band's `minHeight`).
 */
export function columnBand(control: ColumnControl): { order: number; minHeight: number } {
  const order = BANDS.findIndex((band) => band.control === control);
  return { order, minHeight: BANDS[order].height };
}
