/*
 The one focus ring: a 2px outline in --color-focus (teal ink on light, bright teal on dark), 2px outside the control,
 painted in the system highlight under forced colours. A real outline, never a box-shadow, so Windows High Contrast keeps it.
*/
export const ring =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus forced-colors:focus-visible:outline-[Highlight]";
