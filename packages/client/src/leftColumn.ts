/**
 * The bottom-left column of standing-context controls — the name form,
 * the status panel, the huddle control and the call dock: what you claim
 * about yourself and what you do from where your avatar stands, as
 * opposed to the conversation (the chat panel, bottom-right) and the
 * space-level surfaces along the top (recordings, admin).
 *
 * Bottom to top, each control owns a band of fixed height and sits on the
 * band's bottom edge (App's ColumnSlot); a panel taller than its band
 * grows upward over the band above instead of pushing it. So a control
 * stays put while another one changes height (an inline error, the huddle
 * join offer, the call dock coming and going), and adding a control is
 * adding a band: the bands above it move up by its height.
 */

/** The controls of the column. */
export type ColumnControl = 'name' | 'status' | 'huddle' | 'call';

/** The column's distance from the canvas's left and bottom edges. */
export const COLUMN_INSET = 12;

/**
 * The bands, bottom to top, each with the height it reserves: its panel
 * at rest plus the gap to the next band. The top band reserves nothing
 * until a control lands above it.
 */
const BANDS: readonly { control: ColumnControl; height: number }[] = [
  // What you claim about yourself: the name, and the status over it.
  { control: 'name', height: 46 },
  { control: 'status', height: 90 },
  // What you do from where you stand: a huddle is founded on the spot, a
  // call is joined from the conversation group the avatar stands in.
  { control: 'huddle', height: 72 },
  { control: 'call', height: 0 },
];

/** How far above the canvas's bottom edge `control`'s band starts. */
export function bandBottom(control: ColumnControl): number {
  let bottom = COLUMN_INSET;
  for (const band of BANDS) {
    if (band.control === control) break;
    bottom += band.height;
  }
  return bottom;
}
